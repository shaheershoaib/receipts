"use strict";
/* Unit tests for G13 coverage-of-diff parsing and intersection (pure). */
const { test } = require("node:test");
const assert = require("node:assert");
const { parseLcov, parseAddedLines, computeG13 } = require("../g13.js");

const LCOV = `TN:
SF:src/mod.js
DA:1,3
DA:2,0
DA:3,1
end_of_record
SF:/abs/prefix/src/other.js
DA:10,1
end_of_record
`;

test("parseLcov: covered lines only (hits > 0), multi-record", () => {
  const m = parseLcov(LCOV);
  assert.deepEqual([...m.get("src/mod.js")].sort((a, b) => a - b), [1, 3], "DA:2,0 is instrumented but NOT covered");
  assert.ok(m.get("/abs/prefix/src/other.js").has(10));
});

const DIFF = `diff --git a/src/mod.js b/src/mod.js
--- a/src/mod.js
+++ b/src/mod.js
@@ -1 +1,2 @@
+line one
+line two
@@ -9,0 +12 @@
+line twelve
diff --git a/gone.js b/gone.js
--- a/gone.js
+++ /dev/null
@@ -1,3 +0,0 @@
diff --git a/new.js b/new.js
--- /dev/null
+++ b/new.js
@@ -0,0 +1,3 @@
+a
+b
+c
`;

test("parseAddedLines: hunk math, single-line default, deletions add nothing", () => {
  const m = parseAddedLines(DIFF);
  assert.deepEqual([...m.get("src/mod.js")].sort((a, b) => a - b), [1, 2, 12]);
  assert.deepEqual([...m.get("new.js")].sort((a, b) => a - b), [1, 2, 3]);
  assert.ok(!m.has("gone.js"), "a pure deletion has no head-side lines");
});

test("computeG13: covered lines pass, uncovered are named, absent files are no_data", () => {
  const lcov = parseLcov(LCOV);
  const addedLines = new Map([
    ["src/mod.js", new Set([1, 2, 3])],       // 2 is uncovered (DA:2,0)
    ["src/other.js", new Set([10])],           // matched via the /abs/prefix suffix rule
    ["src/never-loaded.js", new Set([5, 6])], // no lcov record at all
  ]);
  const { findings } = computeG13({ addedLines, lcov });
  assert.equal(findings.length, 2);
  const mod = findings.find((f) => f.file === "src/mod.js");
  assert.deepEqual(mod.uncovered, [2]);
  assert.equal(mod.no_data, false);
  const never = findings.find((f) => f.file === "src/never-loaded.js");
  assert.deepEqual(never.uncovered, [5, 6]);
  assert.equal(never.no_data, true, "a file no test loaded is fully unverified");
});

test("computeG13: a fully-covered diff produces no findings", () => {
  const { findings } = computeG13({
    addedLines: new Map([["src/mod.js", new Set([1, 3])]]),
    lcov: parseLcov(LCOV),
  });
  assert.deepEqual(findings, []);
});
