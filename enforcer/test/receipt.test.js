"use strict";
/*
 * Replayable receipt artifact (Phase 1) + command-execution hardening (finding #5).
 *
 * The enforcer can emit a machine-readable receipt (--receipt-out): base/head, verdict,
 * the commands it ran with their exit codes and durations, red/green, the carried tests.
 * That is the proof-of-verification artifact - auditable and re-runnable, not a bare verdict.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cfg, makeRepo, runVerify, testAsserting, modReturning } = require("./helpers.js");

const FIX = "closes #1";
const receiptPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "receipts-out-")), "receipt.json");

test("receipt: a verified fix emits a full evidence artifact", () => {
  const r = makeRepo({
    baseFiles: {
      "mod.js": modReturning(1),
      "suite.js": "process.exit(0);\n",
      "receipts.config.json": cfg({ verify: { test_command: "node {test}", suite_command: "node suite.js" } }),
    },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const out = receiptPath();
  const v = runVerify({ ...r, prBody: FIX, receiptOut: out });
  assert.equal(v.verdict, "PASS", v.raw);

  const rec = v.receipt;
  assert.ok(rec, "a receipt file should be written");
  assert.equal(rec.schema, "receipts/receipt@1");
  assert.equal(rec.verdict, "PASS");
  assert.equal(rec.base, r.base);
  assert.equal(rec.head, r.head);
  assert.equal(rec.config_source, "base");
  assert.equal(rec.is_fix_claim, true);
  assert.equal(rec.red, true, "red = reproduced on base");
  assert.equal(rec.green, true, "green = gone on head");
  assert.deepEqual(rec.tests, ["mod.test.js"]);
  assert.ok(typeof rec.generated_at === "string");

  // the commands actually run, with their exit codes
  const labels = rec.commands.map((c) => c.label);
  assert.ok(labels.includes("receipt-red@base"), labels.join(","));
  assert.ok(labels.includes("receipt-green@head"), labels.join(","));
  assert.ok(labels.includes("suite@head"), labels.join(","));
  const red = rec.commands.find((c) => c.label === "receipt-red@base");
  const green = rec.commands.find((c) => c.label === "receipt-green@head");
  assert.notEqual(red.exit_code, 0, "red command failed on base");
  assert.equal(green.exit_code, 0, "green command passed on head");
  assert.ok(typeof green.duration_ms === "number");
});

test("receipt: a BLOCK is recorded too (evidence of the failure)", () => {
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(1), "mod.test.js": testAsserting(2) }, // fix doesn't pass its own test
  });
  const out = receiptPath();
  const v = runVerify({ ...r, prBody: FIX, receiptOut: out });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.ok(v.receipt, "a receipt is written even on BLOCK");
  assert.equal(v.receipt.verdict, "BLOCK");
  assert.equal(v.receipt.green, false, "green failed on head");
  const green = v.receipt.commands.find((c) => c.label === "receipt-green@head");
  assert.notEqual(green.exit_code, 0);
});

// Finding #5: a chatty-but-honest suite that prints past Node's 1 MiB execSync default must
// not be misread as a failure (ENOBUFS). 2 MiB of output, then a clean pass.
test("a >1MiB chatty test is not a false failure (execSync maxBuffer)", () => {
  const big = "const f=require(\"./mod\");process.stdout.write(\"x\".repeat(2*1024*1024));" +
    "if(f()!==2)process.exit(1);console.log(\"ok\");\n";
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": big },
  });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.exitCode, 0, "chatty green must be accepted, not ENOBUFS-blocked: " + v.raw);
  assert.match(v.reason, /receipt verified/i);
});

// ---------------------------------------------------------------- issue #44
// Data/fixture files under a tests/ dir are INPUTS to tests, never receipts.
// On a real PR they (a) tripped the metacharacter refusal on their filenames and
// (b) polluted the receipt-lock hash. Both must be structurally impossible.

// Like testAsserting, but living under tests/ (requires ../mod).
const NESTED_TEST = (expected) =>
  `const f=require("../mod");const v=f();if(v!==${expected}){console.error("FAIL got "+v);process.exit(1)}console.log("ok");\n`;
const V2_TEST = (expected) => NESTED_TEST(expected) + "// v2: receipt updated with the fix\n";

test("non-runnable fixtures under tests/ never enter the receipt set (issue #44)", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: {
      "receipts.config.json": cfg({ verify: { suite_command: "node tests/mod.test.js" } }),
      "mod.js": modReturning(1),
      "tests/mod.test.js": NESTED_TEST(1),
    },
    headFiles: {
      "mod.js": modReturning(2),
      "tests/mod.test.js": V2_TEST(2),
      // HOSTILE-NAMED data fixtures riding along under tests/.
      "tests/fixtures/PR APRIL - Popeyes, LLC (8663).pdf": "%PDF-1.7 fake",
      "tests/fixtures/expected values.json": '{"gross": 100}',
      "tests/fixtures/sample.xlsx": "PK fake xlsx",
    },
  });
  const receiptOut = path.join(os.tmpdir(), `receipt-44-${process.pid}.json`);
  const r = runVerify({ dir, base, head, prBody: "closes #1", receiptOut });
  // No metacharacter refusal, no fixture pollution: the verdict PASSes on the real
  // receipt and the receipt set contains ONLY the runnable test source.
  assert.equal(r.verdict, "PASS", r.reason);
  const rec = JSON.parse(fs.readFileSync(receiptOut, "utf8"));
  assert.deepEqual(rec.tests, ["tests/mod.test.js"], "fixtures must not be receipts");
  fs.rmSync(receiptOut, { force: true });
});

test("the receipt lock hashes only runnable receipts, so fixtures cannot invalidate it (issue #44)", () => {
  const { computeReceiptLock } = require("../verify.js");
  const lockJustTest = computeReceiptLock({
    files: [{ path: "tests/mod.test.js", content: V2_TEST(2) }],
    cmds: [],
  });
  const { dir, base, head } = makeRepo({
    baseFiles: {
      "receipts.config.json": cfg({ verify: { suite_command: "node tests/mod.test.js" } }),
      "mod.js": modReturning(1),
      "tests/mod.test.js": NESTED_TEST(1),
    },
    headFiles: {
      "mod.js": modReturning(2),
      "tests/mod.test.js": V2_TEST(2),
      "tests/fixtures/data (v2).pdf": "%PDF fake",
    },
  });
  const r = runVerify({ dir, base, head, prBody: `closes #1\nreceipt-lock: ${lockJustTest}` });
  assert.equal(r.verdict, "PASS", `lock over the runnable receipt must match: ${r.reason}`);
});

test("pinning a data file as the receipt blocks by name (issue #44)", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: {
      "receipts.config.json": cfg({ verify: { suite_command: "node tests/mod.test.js" } }),
      "mod.js": modReturning(1),
      "tests/mod.test.js": NESTED_TEST(1),
    },
    headFiles: {
      "mod.js": modReturning(2),
      "tests/fixtures/expected.json": "{}",
    },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1\nreceipt: tests/fixtures/expected.json" });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /not a RUNNABLE test source/);
});
