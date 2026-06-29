"use strict";
/*
 * End-to-end enforcer tests: build a real git repo (base + head), run verify.js as a
 * subprocess, assert the verdict. This is the contract CI and the GitHub Action invoke.
 *
 * Adversarial coverage per the Phase-0 plan: a VALID receipt passes; an INVALID one
 * (no test / weak / fix fails its own test) is blocked; a MALICIOUS one (exit-masking,
 * config neutered from head) is blocked; and the known TRIGGER BYPASSES are pinned as
 * `todo` tests asserting the desired (not the current) behavior.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const {
  cfg, makeRepo, makeDivergedRepo, runVerify, testAsserting, modReturning,
} = require("./helpers.js");

const FIX = "closes #1";

// ── VALID receipt: red on base, green on head, full suite green => clean PASS ─
test("PASS: a real red->green receipt verifies (full suite green)", () => {
  const r = makeRepo({
    baseFiles: {
      "mod.js": modReturning(1),
      "suite.js": "process.exit(0);\n",
      "receipts.config.json": cfg({ verify: { test_command: "node {test}", suite_command: "node suite.js" } }),
    },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "PASS", v.raw);
  assert.match(v.reason, /receipt verified/i);
});

// A valid receipt WITHOUT a suite_command is accepted but WARNs (G9 can't run the
// full suite) - an accept (exit 0), not a clean pass. Pins the PASS/WARN boundary.
test("WARN: valid receipt but no suite_command to prove full-scope green (G9)", () => {
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "WARN", v.raw);
  assert.equal(v.exitCode, 0, "WARN is an accept, exit 0");
  assert.match(v.reason, /receipt verified/i);
});

// ── INVALID receipts ────────────────────────────────────────────────────────
test("BLOCK: fix-claim carries no test (no receipt)", () => {
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2) }, // no *.test.js
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /no receipt/i);
});

test("BLOCK: weak receipt - the test passes on the base commit", () => {
  // head adds a test asserting f()===1, which is already true on base => not reproduced
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(1), "mod.test.js": testAsserting(1) },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /weak receipt|passes on the base/i);
});

test("BLOCK: the fix does not pass its own receipt on head", () => {
  // bug not actually fixed (still 1), but the test demands 2 => red on base, red on head
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(1), "mod.test.js": testAsserting(2) },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /does not pass its own receipt/i);
});

// ── MALICIOUS / trust posture ───────────────────────────────────────────────
test("BLOCK: an exit-masking test_command cannot be trusted (G9)", () => {
  const r = makeRepo({
    baseFiles: {
      "mod.js": modReturning(1),
      "receipts.config.json": cfg({ verify: { test_command: "node {test} ; echo done" } }),
    },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /mask/i);
});

test("config is read from BASE; a head-only config is flagged and strict-defaulted", () => {
  // No config on base; head introduces one that tries to relax the gate. The enforcer
  // must warn (config from head) and force strict defaults rather than trust it.
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1) },
    headFiles: {
      "mod.js": modReturning(2),
      "receipts.config.json": cfg({ degrade: { on_no_receipt: "warn" } }),
      // note: NO test file -> with strict defaults this must still block
    },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.ok(
    (v.warnings || []).some((w) => /config read from the PR head/i.test(w)),
    "expected a 'config from head' warning: " + JSON.stringify(v.warnings));
});

// ── G9 full-scope green: receipt passes but the suite breaks ────────────────
test("BLOCK: receipt is green but the full suite regresses (G9)", () => {
  const r = makeRepo({
    baseFiles: {
      "mod.js": modReturning(1),
      "suite.js": "process.exit(0);\n",
      "receipts.config.json": cfg({ verify: { test_command: "node {test}", suite_command: "node suite.js" } }),
    },
    headFiles: {
      "mod.js": modReturning(2),
      "mod.test.js": testAsserting(2),
      "suite.js": 'console.error("suite regression");process.exit(1);\n', // breaks on head
    },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /full-scope|G9/i);
});

// ── G8 fresh base: head built on a stale base ──────────────────────────────
test("WARN: branch is behind its base (G8 stale base, default warn)", () => {
  const r = makeDivergedRepo({
    rootFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const v = runVerify({ ...r, prBody: FIX });
  // a valid receipt, but earned on a stale base => PASS verdict with a G8 warning
  assert.ok(
    (v.warnings || []).some((w) => /fresh base|behind its base/i.test(w)),
    "expected a G8 stale-base warning: " + JSON.stringify(v.warnings));
});

// ── honest ladder & non-claims ──────────────────────────────────────────────
test("PASS: an honest downgrade tag is tracked, not blocked", () => {
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2) }, // no receipt, but...
  });
  const v = runVerify({ ...r, prBody: FIX + "\n\nunverified-reasoned: cannot repro in CI" });
  assert.equal(v.verdict, "PASS", v.raw);
  assert.match(v.reason, /downgrade/i);
});

// ── Import-vs-assert red (finding #6): a load-error red may not prove the symptom ──

// A receipt whose RED on base is a LOAD error (the test imports a module that only exists on
// head) is, by default, accepted with a warning - blocking it would false-block every feature
// PR (a feature's test is legitimately red until the feature exists).
test("load-error red is a warning by default, not a block (G0 import-vs-assert)", () => {
  const r = makeRepo({
    baseFiles: { "receipts.config.json": cfg() }, // no lib.js on base
    headFiles: {
      "lib.js": "module.exports=()=>2;\n",
      "lib.test.js": 'const f=require("./lib");if(f()!==2)process.exit(1);console.log("ok");\n',
    },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.exitCode, 0, v.raw); // accepted (WARN), not blocked
  assert.ok(
    (v.warnings || []).some((w) => /load \/ collection error/i.test(w)),
    "expected a load-error warning: " + JSON.stringify(v.warnings));
});

// A repo that wants fixes to carry an ASSERTING red opts into block mode.
test("load-error red is blocked under verify.on_load_error_red:block", () => {
  const r = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { test_command: "node {test}", on_load_error_red: "block" } }) },
    headFiles: {
      "lib.js": "module.exports=()=>2;\n",
      "lib.test.js": 'const f=require("./lib");if(f()!==2)process.exit(1);console.log("ok");\n',
    },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /load \/ collection error/i);
});

// ...but even in block mode a feature's load-error red is legitimate (the behavior is absent
// on base by definition), so `work-type: feature` is exempt.
test("load-error red under block mode is allowed for work-type:feature", () => {
  const r = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { test_command: "node {test}", on_load_error_red: "block" } }) },
    headFiles: {
      "lib.js": "module.exports=()=>2;\n",
      "lib.test.js": 'const f=require("./lib");if(f()!==2)process.exit(1);console.log("ok");\n',
    },
  });
  const v = runVerify({ ...r, prBody: FIX + "\nwork-type: feature" });
  assert.equal(v.exitCode, 0, v.raw); // feature red is expected, not a block
});

// ── Trigger scope (finding #2): default vs the opt-in strict trigger ─────────

// Default trigger ("issue-link"): a code change with no issue link is NOT treated as a
// claim - it passes untouched. This is intended back-compat behavior, NOT a clean bill of
// health on the code; the strict trigger below is how a project closes it.
test("default trigger: a code change with no issue link is not re-verified", () => {
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2) }, // real change, no test, no issue link
  });
  const v = runVerify({ ...r, prBody: "fixes the modal width bug" });
  assert.equal(v.verdict, "PASS", v.raw);
  assert.match(v.reason, /not a fix-claim/i);
});

// Strict trigger ("any-source-change"): the same unclaimed code change, with no receipt,
// is now BLOCKED - the bypass is closed.
test("strict trigger: an unclaimed code change carrying no receipt is blocked", () => {
  const r = makeRepo({
    baseFiles: {
      "mod.js": modReturning(1),
      "receipts.config.json": cfg({ claim: { require_receipt_for: "any-source-change" } }),
    },
    headFiles: { "mod.js": modReturning(2) }, // real change, no test, no issue link
  });
  const v = runVerify({ ...r, prBody: "fixes the modal width bug" });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /no receipt/i);
});

// Strict trigger must not over-fire: a docs/test/config-only PR has no production source,
// so there is nothing to re-verify.
test("strict trigger: a docs-only change still passes (no production source)", () => {
  const r = makeRepo({
    baseFiles: {
      "README.md": "old\n",
      "receipts.config.json": cfg({ claim: { require_receipt_for: "any-source-change" } }),
    },
    headFiles: { "README.md": "new\n" },
  });
  const v = runVerify({ ...r, prBody: "tweak the readme" });
  assert.equal(v.verdict, "PASS", v.raw);
  assert.match(v.reason, /no production source/i);
});

// Strict trigger: a valid carried receipt still passes (it does not over-block real fixes).
test("strict trigger: a code change WITH a real receipt passes", () => {
  const r = makeRepo({
    baseFiles: {
      "mod.js": modReturning(1),
      "suite.js": "process.exit(0);\n",
      "receipts.config.json": cfg({
        claim: { require_receipt_for: "any-source-change" },
        verify: { test_command: "node {test}", suite_command: "node suite.js" },
      }),
    },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const v = runVerify({ ...r, prBody: "improve mod" }); // no issue link, but carries a receipt
  assert.equal(v.verdict, "PASS", v.raw);
  assert.match(v.reason, /receipt verified/i);
});

// KNOWN LIMITATION (documented, not a bug): a fix MISLABELED `work-type: refactor` with no
// issue link ships on suite-green alone. This is the hostile-author case the spec explicitly
// disclaims ("not a security boundary against a hostile author" - spec/GATES.md). Pinned so
// the behavior is intentional and visible, not an accident. Human review of the diff is the
// backstop here, as the spec states.
test("known limitation: a fix mislabeled work-type:refactor is not caught (disclaimed)", () => {
  const r = makeRepo({
    baseFiles: {
      "mod.js": modReturning(1),
      "suite.js": "process.exit(0);\n",
      "receipts.config.json": cfg({
        claim: { require_receipt_for: "any-source-change" },
        verify: { test_command: "node {test}", suite_command: "node suite.js" },
      }),
    },
    headFiles: { "mod.js": modReturning(2) }, // behavior CHANGED, labeled refactor, no test
  });
  const v = runVerify({ ...r, prBody: "work-type: refactor" });
  assert.equal(v.verdict, "PASS", v.raw); // suite-green inverted receipt; structurally indistinguishable from a real refactor
  assert.match(v.reason, /refactor verified/i);
});
