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
