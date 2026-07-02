"use strict";
/*
 * E2E tests for COMMAND receipts (Phase 1: "a receipt is any re-runnable command with an
 * expected outcome"). A `receipt-cmd: <command>` line in the PR body IS the receipt - for
 * software with no test runner (an API curl, a SQL count, a CLI stdout check, an infra
 * plan-diff). The command must FAIL its expectation on base (reproduce the symptom) and MEET
 * it on head (symptom gone) - the same red->green law as a file receipt, through the same
 * exec machinery. Same harness as e2e.test.js: real git repos, the enforcer as a subprocess.
 *
 * No test runner is used here: the "acceptance test" is a bare `node -e` process whose exit
 * code (and, for the regex cases, whose stdout) is read directly - the whole point of a
 * command receipt is that it needs no framework.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cfg, makeRepo, runVerify } = require("./helpers.js");

const FIX = "closes #1";
const receiptPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "receipts-cmd-")), "receipt.json");

// A command that reads repo file `flag.txt` and exits 0 iff it says "GOOD" - no test runner.
const FLAG_EXIT = `node -e "process.exit(require('fs').readFileSync('flag.txt','utf8').trim()==='GOOD'?0:1)"`;
// A command that PRINTS the contents of `count.txt` (for the expect: regex cases).
const PRINT_COUNT = `node -e "process.stdout.write(require('fs').readFileSync('count.txt','utf8'))"`;

// A repo with NO real test runner: verify.test_command is left as the init placeholder, so if
// the enforcer tried to run a file receipt it would BLOCK - proving the command receipt path
// runs without any test framework at all.
const noRunnerCfg = () => cfg({ verify: { test_command: "REPLACE_ME: no test runner here" } });

// (a) the happy path: a command receipt goes RED on base (exit 1) -> GREEN on head (exit 0) -> PASS.
test("cmd-receipt: red on base, green on head verifies (no test runner)", () => {
  const r = makeRepo({
    baseFiles: { "flag.txt": "BAD\n", "receipts.config.json": noRunnerCfg() },
    headFiles: { "flag.txt": "GOOD\n" }, // the "fix"
  });
  const out = receiptPath();
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: ${FLAG_EXIT}`, receiptOut: out });
  assert.equal(v.verdict, "WARN", v.raw); // WARN only because no suite_command (G9), an accept
  assert.equal(v.exitCode, 0, "a met command receipt is an accept");
  assert.match(v.reason, /receipt verified/i);
  // the receipt records the command receipt and its red/green
  assert.equal(v.receipt.red, true, "not-met on base = reproduced");
  assert.equal(v.receipt.green, true, "met on head = gone");
  assert.deepEqual(v.receipt.command_receipts, [{ command: FLAG_EXIT, expect: null }]);
  const labels = v.receipt.commands.map((c) => c.label);
  assert.ok(labels.some((l) => /receipt-red@base \[cmd\]/.test(l)), labels.join(","));
  assert.ok(labels.some((l) => /receipt-green@head \[cmd\]/.test(l)), labels.join(","));
});

// (b) the falsifier: a command receipt that ALREADY meets its expectation on base did not
// reproduce the symptom => the existing weak-receipt BLOCK path.
test("cmd-receipt: already met on base is a weak-receipt BLOCK", () => {
  const r = makeRepo({
    baseFiles: { "flag.txt": "GOOD\n", "receipts.config.json": noRunnerCfg() }, // already GOOD on base
    headFiles: { "src.js": "// some change, but the receipt-cmd was already green on base\n" },
  });
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: ${FLAG_EXIT}` });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /weak receipt/i);
  assert.match(v.reason, /MEETS its expectation/i);
});

// the fix that does not actually meet on head is a BLOCK (red on base, still red on head).
test("cmd-receipt: not met on head is a BLOCK", () => {
  const r = makeRepo({
    baseFiles: { "flag.txt": "BAD\n", "receipts.config.json": noRunnerCfg() },
    headFiles: { "flag.txt": "STILL-BAD\n" }, // not fixed
  });
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: ${FLAG_EXIT}` });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /does not MEET its own receipt-cmd/i);
});

// (c) the stdout-regex expectation, MEETING: count goes 3 -> 0, expect:/^0$/ meets only on head.
test("cmd-receipt: expect:/re/ - count fixed to 0 flips fail->meet => PASS", () => {
  const r = makeRepo({
    baseFiles: { "count.txt": "3\n", "receipts.config.json": cfg({ verify: { test_command: "REPLACE_ME", suite_command: "node -e \"process.exit(0)\"" } }) },
    headFiles: { "count.txt": "0\n" },
  });
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: ${PRINT_COUNT} expect:/^0$/` });
  assert.equal(v.verdict, "PASS", v.raw); // suite_command set => clean PASS, no G9 warning
  assert.match(v.reason, /receipt verified/i);
});

// (c) the stdout-regex expectation, FAILING on head: the command exits 0 both sides (it just
// prints), so the ONLY signal is the regex - if head still does not match, that is not a fix.
test("cmd-receipt: expect:/re/ - exit 0 but head output never matches is a BLOCK", () => {
  const r = makeRepo({
    baseFiles: { "count.txt": "3\n", "receipts.config.json": noRunnerCfg() },
    headFiles: { "count.txt": "1\n" }, // still not 0
  });
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: ${PRINT_COUNT} expect:/^0$/` });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /does not MEET|expect: regex/i);
});

// the regex is what makes it RED on base: a print-only command exits 0 on base, so without the
// regex it would meet on base (weak); WITH expect:/^0$/ it does NOT meet on base (count is 3).
test("cmd-receipt: expect:/re/ provides the red - a print-only cmd would otherwise be weak", () => {
  const r = makeRepo({
    baseFiles: { "count.txt": "3\n", "receipts.config.json": noRunnerCfg() },
    headFiles: { "count.txt": "3\n", "src.js": "// change so the diff is non-empty\n" }, // NOT fixed
  });
  // Sanity: without the regex the command exits 0 on base -> weak receipt (proves the regex is
  // load-bearing for the red).
  const weak = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: ${PRINT_COUNT}` });
  assert.equal(weak.verdict, "BLOCK", weak.raw);
  assert.match(weak.reason, /weak receipt/i);
});

// (d) N-run determinism: a flaky command receipt (alternating exit) blocks at receipt_runs>1.
// The flaky logic lives in a committed script (a single `node flaky.js` invocation) - a `node
// -e "...;..."` one-liner would trip the exit-masking lint on the JS `;` inside the quotes.
const FLAKY_JS = `const fs=require("fs")
const n=(fs.existsSync("cnt")?+fs.readFileSync("cnt","utf8"):0)+1
fs.writeFileSync("cnt",String(n))
process.exit(n%2===1?1:0)
`;
test("cmd-receipt: a flaky command blocks under receipt_runs>1 (determinism)", () => {
  const r = makeRepo({
    baseFiles: { "flaky.js": FLAKY_JS, "receipts.config.json": cfg({ verify: { test_command: "REPLACE_ME", receipt_runs: 2 } }) },
    headFiles: { "src.js": "// a change so the diff is non-empty\n" },
  });
  const out = receiptPath();
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: node flaky.js`, receiptOut: out });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /flaky receipt/i);
  // per-run evidence for the command receipt
  const labels = v.receipt.commands.map((c) => c.label);
  assert.ok(labels.some((l) => /receipt-red@base \[1\/2\] \[cmd\]/.test(l)), labels.join(","));
});

// masksExit still guards a command receipt: a green earned by a masked exit cannot be trusted.
test("cmd-receipt: an exit-masking command is blocked (G9)", () => {
  const r = makeRepo({
    baseFiles: { "receipts.config.json": noRunnerCfg() },
    headFiles: { "src.js": "// change\n" },
  });
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: node -e "process.exit(1)" ; echo done` });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /mask/i);
});

// an invalid expect regex is blocked up front, with a clear message.
test("cmd-receipt: an invalid expect regex is blocked", () => {
  const r = makeRepo({
    baseFiles: { "receipts.config.json": noRunnerCfg() },
    headFiles: { "src.js": "// change\n" },
  });
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: echo hi expect:/[unterminated/` });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /not a valid regex/i);
});

// file receipt AND command receipt together: both must flip red->green (ANDed).
test("cmd-receipt: a file receipt AND a command receipt both run and are ANDed", () => {
  const r = makeRepo({
    baseFiles: {
      "mod.js": "module.exports=()=>1;\n",
      "flag.txt": "BAD\n",
      "receipts.config.json": cfg({ verify: { test_command: "node {test}", suite_command: "node -e \"process.exit(0)\"" } }),
    },
    headFiles: {
      "mod.js": "module.exports=()=>2;\n",
      "flag.txt": "GOOD\n",
      "mod.test.js": `const f=require("./mod");if(f()!==2)process.exit(1);console.log("ok");\n`,
    },
  });
  const out = receiptPath();
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd: ${FLAG_EXIT}`, receiptOut: out });
  assert.equal(v.verdict, "PASS", v.raw);
  const labels = v.receipt.commands.map((c) => c.label);
  assert.ok(labels.includes("receipt-red@base") || labels.some((l) => /receipt-red@base$/.test(l)), labels.join(","));
  assert.ok(labels.some((l) => /receipt-red@base \[cmd\]/.test(l)), "the command receipt ran too: " + labels.join(","));
});

// a bare `receipt-cmd:` with no command is blocked.
test("cmd-receipt: an empty receipt-cmd line is blocked", () => {
  const r = makeRepo({
    baseFiles: { "receipts.config.json": noRunnerCfg() },
    headFiles: { "src.js": "// change\n" },
  });
  const v = runVerify({ ...r, prBody: `${FIX}\nreceipt-cmd:   ` });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /no command after the colon/i);
});
