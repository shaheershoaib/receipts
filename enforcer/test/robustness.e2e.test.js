"use strict";
/*
 * E2E tests for the robustness layer: the receipt pin (`receipt:` in the PR body),
 * N-run determinism (verify.receipt_runs), the default command timeout, and the
 * unknown-config-key warning. Same harness as e2e.test.js: real git repos, the
 * enforcer run as a subprocess.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cfg, makeRepo, runVerify, testAsserting, modReturning, git } = require("./helpers.js");

const receiptPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "receipts-rcpt-")), "receipt.json");

// ---------------------------------------------------------------------------- receipt: pin

test("pin: a pure-churn PR is a weak receipt without the pin, PASS with a pin to an unchanged flipping test", () => {
  // old.test.js exists on base (red there: mod=1), is untouched by the PR; the PR "fixes"
  // mod and only touches an incidental churn test that passes on both sides.
  const files = {
    baseFiles: {
      "receipts.config.json": cfg({ verify: { suite_command: "node old.test.js" } }),
      "mod.js": modReturning(1),
      "old.test.js": testAsserting(2), // the real acceptance test, red on base
      "churn.test.js": "console.log('cosmetic, passes everywhere');\n",
    },
    headFiles: {
      "mod.js": modReturning(2), // the fix
      "churn.test.js": "console.log('cosmetic, passes everywhere - reformatted');\n",
    },
  };
  const a = makeRepo(files);
  const without = runVerify({ dir: a.dir, base: a.base, head: a.head, prBody: "closes #1" });
  assert.equal(without.verdict, "BLOCK", "churn-only receipt passes on base => weak receipt");
  assert.match(without.reason, /weak receipt/);

  const b = makeRepo(files);
  const withPin = runVerify({
    dir: b.dir, base: b.base, head: b.head,
    prBody: "closes #1\nreceipt: old.test.js",
    receiptOut: receiptPath(),
  });
  assert.equal(withPin.verdict, "PASS", `pinned unchanged test flips red->green: ${withPin.reason}`);
  assert.deepEqual(withPin.receipt.tests, ["old.test.js"]);
  assert.equal(withPin.receipt.pinned, true);
});

test("pin: a pin that is not a test file is blocked", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg(), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1\nreceipt: mod.js" });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /not a test file/);
});

test("pin: a pin that does not exist at head is blocked", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg(), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1\nreceipt: gone.test.js" });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /does not exist at head/);
});

test("pin: a prose 'receipt:' line (multiple words) is ignored, not parsed as a pin", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" } }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({
    dir, base, head,
    prBody: "closes #1\nreceipt: red on base, green on head - see CI",
  });
  assert.equal(r.verdict, "PASS", `prose after 'receipt:' must not block: ${r.reason}`);
});

// ------------------------------------------------------------------- receipt_runs (flake)

// A test that alternates fail/pass across runs via an untracked counter file.
const FLAKY_TEST = `const fs=require("fs");
const n=(fs.existsSync("cnt")?+fs.readFileSync("cnt","utf8"):0)+1;
fs.writeFileSync("cnt",String(n));
if(n%2===1){console.error("odd run fails");process.exit(1)}
console.log("even run passes");
`;

test("receipt_runs: a red that flakes green on base is a flaky-receipt BLOCK", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { receipt_runs: 2 } }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "flaky.test.js": FLAKY_TEST },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /flaky receipt/);
  assert.match(r.reason, /1\/2 run/);
});

// Solid red on base (asserts the symptom first), flaky on head (parity flake after).
const GREEN_FLAKE_TEST = `const f=require("./mod");
if(f()!==2){console.error("symptom present");process.exit(1)}
const fs=require("fs");
const n=(fs.existsSync("cnt2")?+fs.readFileSync("cnt2","utf8"):0)+1;
fs.writeFileSync("cnt2",String(n));
if(n%2===0){console.error("head flake on even run");process.exit(1)}
console.log("ok");
`;

test("receipt_runs: a green that flakes red on head is a flaky-green BLOCK, not a pass", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { receipt_runs: 2 } }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "green.test.js": GREEN_FLAKE_TEST },
  });
  const out = receiptPath();
  const r = runVerify({ dir, base, head, prBody: "closes #1", receiptOut: out });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /flaky green/);
  // Every run is its own evidence entry.
  const labels = r.receipt.commands.map((c) => c.label);
  assert.ok(labels.includes("receipt-red@base [1/2]") && labels.includes("receipt-green@head [2/2]"),
    `per-run labels recorded, got: ${labels.join(", ")}`);
});

// ----------------------------------------------------------------------- command timeout

test("timeout: a hung receipt is killed and recorded as timed_out, not trusted", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { command_timeout_ms: 800 } }), "mod.js": modReturning(1) },
    headFiles: {
      "mod.js": modReturning(2),
      // Red: asserts the symptom (fast fail on base). Green: assertion passes, then hangs.
      "slow.test.js": `const f=require("./mod");if(f()!==2){console.error("FAIL");process.exit(1)}setInterval(()=>{},1000);\n`,
    },
  });
  const out = receiptPath();
  const r = runVerify({ dir, base, head, prBody: "closes #1", receiptOut: out });
  assert.equal(r.verdict, "BLOCK", `a hung green is not a pass: ${r.reason}`);
  assert.ok(r.receipt.commands.some((c) => c.timed_out === true),
    "the killed command is marked timed_out in the receipt");
});

// ------------------------------------------------------------------ branch restoration

test("local verify restores the BRANCH, not a detached sha", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg(), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  runVerify({ dir, base, head, prBody: "closes #1" });
  // symbolic-ref exits non-zero on a detached HEAD - the regression this guards.
  assert.doesNotThrow(
    () => git(dir, ["symbolic-ref", "--short", "HEAD"]),
    "verify must leave the repo on the branch it found (an amend after a detached-HEAD verify silently misses the branch)"
  );
});

// ------------------------------------------------------------------- unknown config keys

test("config: unknown keys warn by name (a typo must not silently mean defaults)", () => {
  const raw = cfg();
  const withTypos = JSON.stringify(
    Object.assign(JSON.parse(raw), { gatez: { enabled: "all" } }),
    null, 2
  );
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": withTypos, "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "WARN", `unknown keys degrade PASS to WARN: ${r.reason}`);
  assert.ok(r.warnings.some((w) => /unknown key/.test(w) && /gatez/.test(w)),
    `the typo'd key is named: ${JSON.stringify(r.warnings)}`);
});
