"use strict";
/* Unit tests for G7's dependency-graph logic (pure, injected in-memory I/O). */
const { test } = require("node:test");
const assert = require("node:assert");
const { jsImports, resolveJsKey, coLocatedTests, computeNewDependents } = require("../g7.js");

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
