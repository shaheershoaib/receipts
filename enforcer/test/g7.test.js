"use strict";
/* Unit tests for G7's dependency-graph logic (pure, injected in-memory I/O). */
const { test } = require("node:test");
const assert = require("node:assert");
const { jsImports, resolveJsKey, coLocatedTests, pyKey, pyImportKeys, pyCoLocatedTests, computeNewDependents } = require("../g7.js");

// ------------------------------------------------------------------------ python

test("pyImportKeys: absolute, relative, from-import, aliases, comma lists", () => {
  const src = `
import pkg.util
import os, app.models as m
from pkg.mod import thing
from . import sibling
from ..shared import helper as h
from .local_mod import x, y
`;
  const keys = pyImportKeys("pkg/sub/consumer.py", src);
  for (const k of [
    "pkg/util",            // import pkg.util
    "app/models",          // comma + alias
    "pkg/mod",             // from pkg.mod import thing
    "pkg/mod/thing",       // ...thing may itself be a submodule
    "pkg/sub/sibling",     // from . import sibling
    "pkg/shared",          // from ..shared import helper
    "pkg/shared/helper",
    "pkg/sub/local_mod",   // from .local_mod import x
  ]) assert.ok(keys.includes(k), `${k} missing from ${JSON.stringify(keys)}`);
  assert.ok(keys.includes("os"), "stdlib keys are emitted but match nothing in-repo");
});

test("pyKey: __init__.py collapses to the package dir", () => {
  assert.equal(pyKey("pkg/mod.py"), "pkg/mod");
  assert.equal(pyKey("pkg/__init__.py"), "pkg");
});

test("pyCoLocatedTests finds test_x / x_test / tests/ variants", () => {
  const head = new Set(["pkg/test_consumer.py", "pkg/tests/test_consumer.py", "tests/test_consumer.py", "other.py"]);
  const got = pyCoLocatedTests("pkg/consumer.py", head).sort();
  assert.deepEqual(got, ["pkg/test_consumer.py", "pkg/tests/test_consumer.py", "tests/test_consumer.py"]);
});

test("python: a NEW-EDGE consumer of a changed module is a new dependent with its tests", () => {
  const base = {
    "pkg/mod.py": "def f():\n    return 1\n",
    "pkg/consumer.py": "def g():\n    return 0\n", // no import at base
    "pkg/test_consumer.py": "from pkg.consumer import g\n",
  };
  const head = {
    ...base,
    "pkg/mod.py": "def f():\n    return 2\n",
    "pkg/consumer.py": "from pkg.mod import f\ndef g():\n    return f()\n", // NEW edge
  };
  const r = computeNewDependents({
    ...env(base, head),
    changedSource: ["pkg/mod.py", "pkg/consumer.py"],
  });
  assert.equal(r.computed, true);
  const dep = r.newDependents.find((d) => d.file === "pkg/consumer.py");
  assert.ok(dep, `consumer detected: ${JSON.stringify(r.newDependents)}`);
  assert.equal(dep.reason, "new-edge");
  assert.deepEqual(dep.tests, ["pkg/test_consumer.py"]);
});

test("python: a STABLE consumer (edge existed at base) is not re-flagged", () => {
  const base = {
    "pkg/mod.py": "def f():\n    return 1\n",
    "pkg/consumer.py": "from pkg.mod import f\n",
  };
  const head = { ...base, "pkg/mod.py": "def f():\n    return 2\n" };
  const r = computeNewDependents({
    ...env(base, head),
    changedSource: ["pkg/mod.py"],
  });
  assert.deepEqual(r.newDependents, [], "default scope is NEW dependents only");
});

test("python: relative-import consumer resolves through the package tree", () => {
  const base = { "pkg/mod.py": "def f():\n    return 1\n" };
  const head = {
    ...base,
    "pkg/mod.py": "def f():\n    return 2\n",
    "pkg/consumer.py": "from .mod import f\n", // new file, relative edge
  };
  const r = computeNewDependents({
    ...env(base, head),
    changedSource: ["pkg/mod.py", "pkg/consumer.py"],
  });
  const dep = r.newDependents.find((d) => d.file === "pkg/consumer.py");
  assert.ok(dep && dep.reason === "new-file", JSON.stringify(r.newDependents));
});

test("python: vendored/venv files are never consumers", () => {
  const base = { "pkg/mod.py": "x=1\n" };
  const head = {
    ...base,
    "pkg/mod.py": "x=2\n",
    ".venv/lib/thing.py": "from pkg.mod import x\n",
  };
  const r = computeNewDependents({ ...env(base, head), changedSource: ["pkg/mod.py"] });
  assert.deepEqual(r.newDependents, []);
});

function env(baseTree, headTree) {
  const pick = (c) => (c === "BASE" ? baseTree : headTree);
  return {
    base: "BASE", head: "HEAD",
    listAt: (c) => Object.keys(pick(c)),
    readAt: (c, p) => (Object.prototype.hasOwnProperty.call(pick(c), p) ? pick(c)[p] : null),
  };
}

test("jsImports extracts import/require/export-from/dynamic specifiers", () => {
  const src = `
    import a from "./a";
    import { b } from './b';
    export { c } from "./c";
    const d = require("./d");
    const e = await import("./e");
    import "./side";
    import x from "react";`;
  const got = jsImports(src);
  for (const s of ["./a", "./b", "./c", "./d", "./e", "./side", "react"]) assert.ok(got.includes(s), s);
});

test("resolveJsKey resolves relative imports, ignores bare specifiers", () => {
  assert.equal(resolveJsKey("src/chart.ts", "./field"), "src/field");
  assert.equal(resolveJsKey("src/ui/chart.ts", "../field"), "src/field");
  assert.equal(resolveJsKey("src/chart.ts", "react"), null);
});

test("coLocatedTests finds sibling and __tests__ tests present at head", () => {
  const headSet = new Set(["src/field.ts", "src/field.test.ts", "src/__tests__/field.spec.tsx"]);
  const got = coLocatedTests("src/field.ts", headSet);
  assert.ok(got.includes("src/field.test.ts"));
  assert.ok(got.includes("src/__tests__/field.spec.tsx"));
});

test("new-edge: a consumer that newly imports the changed file is flagged", () => {
  const base = { "src/field.ts": "export const field=1;", "src/chart.ts": "export const chart=2;" };
  const head = {
    "src/field.ts": "export const field=1; // changed",
    "src/chart.ts": 'import { field } from "./field"; export const chart = field;',
    "src/chart.test.ts": "test stub",
  };
  const r = computeNewDependents({ ...env(base, head), changedSource: ["src/field.ts"] });
  assert.equal(r.computed, true);
  assert.equal(r.newDependents.length, 1);
  assert.equal(r.newDependents[0].file, "src/chart.ts");
  assert.equal(r.newDependents[0].reason, "new-edge");
  assert.deepEqual(r.newDependents[0].tests, ["src/chart.test.ts"]);
});

test("stable consumer (imported at base AND head) is NOT new", () => {
  const imp = 'import { field } from "./field"; export const chart = field;';
  const base = { "src/field.ts": "export const field=1;", "src/chart.ts": imp };
  const head = { "src/field.ts": "export const field=2;", "src/chart.ts": imp };
  const r = computeNewDependents({ ...env(base, head), changedSource: ["src/field.ts"] });
  assert.equal(r.newDependents.length, 0, "a long-standing consumer is not a NEW dependent");

  const all = computeNewDependents({ ...env(base, head), changedSource: ["src/field.ts"], allDependents: true });
  assert.equal(all.newDependents.length, 1, "allDependents widens to every consumer");
});

test("new-file: a freshly added consumer is flagged", () => {
  const base = { "src/field.ts": "export const field=1;" };
  const head = {
    "src/field.ts": "export const field=2;",
    "src/widget.ts": 'import { field } from "./field";',
  };
  const r = computeNewDependents({ ...env(base, head), changedSource: ["src/field.ts"] });
  assert.equal(r.newDependents.length, 1);
  assert.equal(r.newDependents[0].reason, "new-file");
});

test("graph mode works for any stack via an explicit consumer graph", () => {
  const base = { "api/field.rb": "x" };
  const head = { "api/field.rb": "y", "api/report.rb": "z" }; // report.rb is new
  const graph = { "api/report.rb": ["api/field.rb"] };
  const r = computeNewDependents({ ...env(base, head), changedSource: ["api/field.rb"], graph });
  assert.equal(r.computed, true);
  assert.equal(r.newDependents.length, 1);
  assert.equal(r.newDependents[0].file, "api/report.rb");
});

test("unsupported stack with no graph -> not computed (honest, no false all-clear)", () => {
  const r = computeNewDependents({ ...env({}, { "main.go": "package main" }), changedSource: ["main.go"] });
  assert.equal(r.computed, false);
  assert.equal(r.supported, false);
  assert.match(r.note, /not computed/i);
});

// ------------------------- python from-import guesses: phantom-dependent guard

test("pyImportScan separates definite keys from from-import name guesses", () => {
  const { pyImportScan } = require("../g7.js");
  const { keys, guesses } = pyImportScan("consumer.py", "from pkg.mod import thing\nimport pkg.other\n");
  assert.ok(keys.includes("pkg/mod"));
  assert.ok(keys.includes("pkg/other"));
  assert.ok(guesses.includes("pkg/mod/thing"));
  assert.ok(!keys.includes("pkg/mod/thing"));
});

test("a from-import guess is dropped when the parent module FILE exists (phantom dependent)", () => {
  // `from pkg.mod import thing` where pkg/mod.py exists: the import resolves to the
  // module file and `thing` is a symbol - an unrelated pkg/mod/thing.py changing must
  // NOT make consumer.py a dependent.
  const baseFiles = { "pkg/mod.py": "def thing():\n    return 1\n", "pkg/mod/thing.py": "X = 1\n" };
  const headFiles = { ...baseFiles, "consumer.py": "from pkg.mod import thing\n" };
  const pick = (ref) => (ref === "b" ? baseFiles : headFiles);
  const r = computeNewDependents({
    base: "b", head: "h", changedSource: ["pkg/mod/thing.py"],
    listAt: (ref) => Object.keys(pick(ref)), readAt: (ref, f) => pick(ref)[f] || "",
  });
  assert.deepEqual(r.newDependents, [], "phantom edge suppressed");
});

test("a from-import of a REAL submodule is still a dependent (no parent module file)", () => {
  const baseFiles = { "myapp/__init__.py": "", "myapp/models.py": "A = 1\n" };
  const headFiles = { ...baseFiles, "svc.py": "from myapp import models\n" };
  const pick = (ref) => (ref === "b" ? baseFiles : headFiles);
  const r = computeNewDependents({
    base: "b", head: "h", changedSource: ["myapp/models.py"],
    listAt: (ref) => Object.keys(pick(ref)), readAt: (ref, f) => pick(ref)[f] || "",
  });
  assert.equal(r.newDependents.length, 1, "the real submodule edge survives");
  assert.equal(r.newDependents[0].file, "svc.py");
});
