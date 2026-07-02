"use strict";
/*
 * E2E tests for monorepo support: nested receipts.config.json files (read from the
 * trusted BASE commit) supply per-package test runners; the receipt's red/green runs
 * with each test's nearest config, cwd'd to that package. Policy (claim / degrade /
 * gates) stays root-only.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cfg, makeRepo, runVerify, testAsserting, modReturning } = require("./helpers.js");
const { groupTestsByPackage } = require("../verify.js");

test("groupTestsByPackage: nearest config wins, paths relativize, root catches the rest", () => {
  const pkg = new Map([
    ["packages/a", { test_command: "node {test}" }],
    ["packages/a/sub", { test_command: "node sub {test}" }],
  ]);
  const groups = groupTestsByPackage(
    ["packages/a/x.test.js", "packages/a/sub/y.test.js", "top.test.js"],
    pkg,
    { test_command: "root {test}" }
  );
  const byDir = Object.fromEntries(groups.map((g) => [g.dir, g]));
  assert.deepEqual(byDir["packages/a"].tests, ["x.test.js"]);
  assert.deepEqual(byDir["packages/a/sub"].tests, ["y.test.js"], "deepest config wins");
  assert.deepEqual(byDir[""].tests, ["top.test.js"]);
  assert.equal(byDir[""].verify.test_command, "root {test}");
});

// A root config with NO verify block (policy only) + two packages with their own
// runners - the shape of a real monorepo.
function monorepoFixture() {
  const rootCfg = JSON.stringify({
    version: 1,
    claim: { issue_link: "closes #(\\d+)", downgrade_tags: ["unverified-reasoned", "speculative", "reverted"] },
    degrade: {},
    gates: { enabled: "all", disabled: [] },
  }, null, 2);
  const pkgCfg = JSON.stringify({ version: 1, verify: { test_command: "node {test}", suite_command: "node mod.test.js" } }, null, 2);
  return {
    "receipts.config.json": rootCfg,
    "packages/a/receipts.config.json": pkgCfg,
    "packages/b/receipts.config.json": pkgCfg,
    "packages/a/mod.js": modReturning(1),
    "packages/b/mod.js": modReturning(5),
    "packages/b/mod.test.js": testAsserting(5),
  };
}

test("monorepo: a fix in one package verifies with THAT package's runner, cwd'd there", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: monorepoFixture(),
    headFiles: {
      "packages/a/mod.js": modReturning(2),
      "packages/a/mod.test.js": testAsserting(2), // requires ./mod - only resolves with cwd=packages/a
    },
  });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "receipts-mono-")), "r.json");
  const r = runVerify({ dir, base, head, prBody: "closes #1", receiptOut: out });
  assert.equal(r.verdict, "PASS", r.reason + " " + JSON.stringify(r.warnings));
  const labels = r.receipt.commands.map((c) => c.label);
  assert.ok(labels.includes("receipt-red@base [packages/a]"), `package-labeled evidence: ${labels}`);
  assert.ok(labels.includes("suite@head [packages/a]"), "the AFFECTED package's suite ran for G9");
  assert.ok(!labels.some((l) => l.includes("packages/b")), "the untouched package is not re-run");
});

test("monorepo: a package with no usable test_command blocks BY NAME", () => {
  const files = monorepoFixture();
  files["packages/c/receipts.config.json"] = JSON.stringify({ version: 1, verify: { test_command: "REPLACE_ME: set me" } });
  files["packages/c/mod.js"] = modReturning(1);
  const { dir, base, head } = makeRepo({
    baseFiles: files,
    headFiles: { "packages/c/mod.js": modReturning(2), "packages/c/mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /package 'packages\/c'/);
});

test("monorepo: a cross-package fix runs BOTH packages' receipts; one red pollutes neither", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: monorepoFixture(),
    headFiles: {
      "packages/a/mod.js": modReturning(2),
      "packages/a/mod.test.js": testAsserting(2),
      "packages/b/mod.js": modReturning(6),
      "packages/b/mod.test.js": testAsserting(6), // changed test in b too
    },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "PASS", r.reason + " " + JSON.stringify(r.warnings));
});

test("monorepo: refactor with no root suite proves itself on EVERY package suite", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: monorepoFixture(),
    // b has a suite (mod.test.js asserting 5) on base; a gains one plus a rename-ish change.
    headFiles: {
      "packages/a/mod.js": "module.exports=()=>1; // tidied\n",
      "packages/a/mod.test.js": testAsserting(1),
    },
  });
  const r = runVerify({ dir, base, head, prBody: "work-type: refactor" });
  assert.equal(r.verdict, "PASS", r.reason + " " + JSON.stringify(r.warnings));
});
