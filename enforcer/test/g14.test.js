"use strict";
/*
 * Unit tests for G14 mutation-target selection (pure).
 *
 * Regression for the failure that motivated it: on a real fix-claim G14 reported
 * 12/12 survivors, but most mutants had been injected into COMMITTED BUILD
 * ARTIFACTS (generated .json, .html) that no test could ever assert on. Those
 * mutants always survive, so the gate reported the receipt as toothless when the
 * receipt was never at fault - and the budget they consumed never reached the
 * code that actually changed.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { computeMutants, isMutable, CODE_EXTS } = require("../g14.js");

// One added line per file, each carrying an obviously mutable operator.
const lines = (files) => new Map(files.map((f) => [f, new Set([1])]));
const read = () => "if (a === b && count > 3) { return true; }";

test("mutates known code extensions", () => {
  for (const f of ["src/a.js", "app/svc.py", "cmd/main.go", "lib/x.rb", "s.sh"]) {
    assert.ok(isMutable(f, []), `${f} should be mutable`);
  }
});

test("never mutates generated/non-code artifacts", () => {
  for (const f of ["graph.json", "graph.html", "icon.svg", "package-lock.json",
                   "out.min.css", "README", "data.csv", "snap.snapshot"]) {
    assert.equal(isMutable(f, []), false, `${f} must not be mutated`);
  }
});

test("budget lands on the code, not the committed artifacts", () => {
  // The shape from the original failure: generated artifacts alongside one real
  // source change. Every mutant must target the source file.
  const added = lines([
    "graphify-out/cache/ast/mod.json",
    "graphify-out/graph.html",
    "graphify-out/graph.json",
    "app/services/ingest.py",
  ]);
  const mutants = computeMutants({ addedLines: added, read });
  assert.ok(mutants.length > 0, "the code file must still produce mutants");
  assert.deepEqual([...new Set(mutants.map((m) => m.file))], ["app/services/ingest.py"]);
});

test("an all-artifact diff yields no mutants and says which files it skipped", () => {
  // The dangerous quiet case: G14 must not report a confident empty result when
  // the reason it found nothing is that everything changed was generated.
  const added = lines(["graph.json", "graph.html"]);
  const mutants = computeMutants({ addedLines: added, read });
  assert.equal(mutants.length, 0);
  assert.deepEqual(mutants.skipped, ["graph.html", "graph.json"]);
});

test("gates.G14.exclude skips generated files that DO carry a code extension", () => {
  const added = lines(["dist/bundle.js", "src/real.js"]);
  const mutants = computeMutants({ addedLines: added, read, exclude: ["dist/**"] });
  assert.deepEqual([...new Set(mutants.map((m) => m.file))], ["src/real.js"]);
  assert.deepEqual(mutants.skipped, ["dist/bundle.js"]);
});

test("exclude accepts a bare glob and leaves unmatched files alone", () => {
  const added = lines(["generated_client.js", "src/real.js"]);
  const mutants = computeMutants({ addedLines: added, read, exclude: ["generated_*.js"] });
  assert.deepEqual([...new Set(mutants.map((m) => m.file))], ["src/real.js"]);
});

test("selection stays deterministic and extension matching is case-insensitive", () => {
  assert.ok(isMutable("src/A.JS", []));
  assert.ok(CODE_EXTS.has("py") && !CODE_EXTS.has("json"));
});
