"use strict";
/*
 * E2E tests for the weak-agent trust chain:
 *   - receipt-lock: the rubric is fixed before the agent starts (tamper = BLOCK)
 *   - G14 mutation referee: the receipt must notice deliberately-broken code
 *   - G12 env-sniff: production code that special-cases CI/tests is flagged
 * Plus unit tests for the pure pieces (canonical hash, mutant generation).
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const path = require("path");
const { cfg, makeRepo, runVerify, testAsserting, modReturning } = require("./helpers.js");
const { computeReceiptLock } = require("../verify.js");
const { maskStrings, mutantsForLine, selectMutants, applyMutant } = require("../g14.js");
const { computeEnvSniff } = require("../g12.js");

// G14 is exercised on purpose per-test; keep it out of the receipt-lock fixtures so each
// feature is tested in isolation.
const NO_G14 = { gates: { disabled: ["G14"] } };

// ------------------------------------------------------------------ receipt lock (unit)

test("computeReceiptLock: stable across ordering, sensitive to content", () => {
  const a = computeReceiptLock({
    files: [{ path: "b.test.js", content: "B" }, { path: "a.test.js", content: "A" }],
    cmds: [{ cmd: "curl x", expect: "ok" }],
  });
  const b = computeReceiptLock({
    files: [{ path: "a.test.js", content: "A" }, { path: "b.test.js", content: "B" }],
    cmds: [{ cmd: "curl x", expect: "ok" }],
  });
  assert.equal(a, b, "order-independent");
  assert.match(a, /^[a-f0-9]{64}$/);
  const c = computeReceiptLock({
    files: [{ path: "a.test.js", content: "A CHANGED" }, { path: "b.test.js", content: "B" }],
    cmds: [{ cmd: "curl x", expect: "ok" }],
  });
  assert.notEqual(a, c, "content-sensitive");
  const d = computeReceiptLock({
    files: [{ path: "a.test.js", content: "A\r\nX" }, { path: "b.test.js", content: "B" }],
    cmds: [],
  });
  const e = computeReceiptLock({
    files: [{ path: "a.test.js", content: "A\nX" }, { path: "b.test.js", content: "B" }],
    cmds: [],
  });
  assert.equal(d, e, "CRLF-normalized");
});

// ------------------------------------------------------------------- receipt lock (e2e)

test("lock: a matching lock PASSes and is recorded; the CLI produces the same hash", () => {
  const receipt = testAsserting(2);
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" }, ...NO_G14 }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": receipt },
  });
  // The CLI is how the contract's owner produces the line (run from the repo root).
  const cliOut = execFileSync("node", [path.join(__dirname, "..", "..", "bin", "receipts.js"), "lock", "mod.test.js"], { cwd: dir, encoding: "utf8" }).trim();
  assert.match(cliOut, /^receipt-lock: [a-f0-9]{64}$/);
  const r = runVerify({ dir, base, head, prBody: `closes #1\n${cliOut}`, receiptOut: path.join(dir, "r.json") });
  assert.equal(r.verdict, "PASS", r.reason + JSON.stringify(r.warnings));
  assert.deepEqual(r.receipt.lock, { present: true, matched: true, hash: cliOut.slice("receipt-lock: ".length) });
});

test("lock: the agent tampered with the approved receipt -> BLOCK (even though red->green still holds)", () => {
  const approved = testAsserting(2); // asserts === 2 (the contract)
  const weakened = `const f=require("./mod");if(f()===1){console.error("still old");process.exit(1)}console.log("ok");\n`; // asserts only "not 1"
  const lockOfApproved = computeReceiptLock({ files: [{ path: "mod.test.js", content: approved }], cmds: [] });
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg(NO_G14), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(7), "mod.test.js": weakened }, // wrong fix + weakened rubric
  });
  const r = runVerify({ dir, base, head, prBody: `closes #1\nreceipt-lock: ${lockOfApproved}` });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /receipt-lock mismatch/);
});

test("lock: require_receipt_lock blocks a claim with no lock; malformed lock blocks by name", () => {
  const files = {
    baseFiles: { "receipts.config.json": cfg({ claim: { require_receipt_lock: true }, ...NO_G14 }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  };
  const a = makeRepo(files);
  const r1 = runVerify({ dir: a.dir, base: a.base, head: a.head, prBody: "closes #1" });
  assert.equal(r1.verdict, "BLOCK");
  assert.match(r1.reason, /requires a receipt-lock/);

  const b = makeRepo(files);
  const r2 = runVerify({ dir: b.dir, base: b.base, head: b.head, prBody: "closes #1\nreceipt-lock: deadbeef" });
  assert.equal(r2.verdict, "BLOCK");
  assert.match(r2.reason, /malformed receipt-lock/);
});

test("lock: covers command receipts too - a reworded receipt-cmd breaks the lock", () => {
  const cmd = `node -e "process.exit(require('./mod')()===2?0:1)"`;
  const lockHash = computeReceiptLock({ files: [], cmds: [{ cmd, expect: null }] });
  const files = {
    baseFiles: { "receipts.config.json": cfg(NO_G14), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2) },
  };
  const a = makeRepo(files);
  const ok = runVerify({ dir: a.dir, base: a.base, head: a.head, prBody: `closes #1\nreceipt-cmd: ${cmd}\nreceipt-lock: ${lockHash}` });
  assert.equal(ok.verdict, "WARN", ok.reason); // WARN = no suite in fixture; the lock matched

  const b = makeRepo(files);
  const weakCmd = `node -e "process.exit(require('./mod')()!==1?0:1)"`; // asserts only "not 1"
  const bad = runVerify({ dir: b.dir, base: b.base, head: b.head, prBody: `closes #1\nreceipt-cmd: ${weakCmd}\nreceipt-lock: ${lockHash}` });
  assert.equal(bad.verdict, "BLOCK");
  assert.match(bad.reason, /receipt-lock mismatch/);
});

test("lock: prose after the colon is ignored (no false block)", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" }, ...NO_G14 }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1\nreceipt-lock: pending sign-off from the tech lead" });
  assert.equal(r.verdict, "PASS", r.reason);
});

// ------------------------------------------------------------------------- G14 (unit)

test("mutantsForLine: operators fire on code, never inside strings or comments", () => {
  const ops = (line) => mutantsForLine(line).map((m) => m.op);
  assert.ok(ops("if (a === b && n < 3) return true;").length >= 4, "===, &&, <, true, 3 all mutable");
  assert.deepEqual(mutantsForLine('console.log("a === b && true");'), [], "string content is not behavior");
  assert.deepEqual(mutantsForLine("// a === b"), [], "comment lines skipped");
  const num = mutantsForLine("return 41;").find((m) => m.op === "number +1");
  assert.equal(num.after, "return 42;");
  const py = mutantsForLine("if a and b:").find((m) => m.op === "and -> or");
  assert.equal(py.after, "if a or b:");
});

test("selectMutants: capped, breadth across files before depth", () => {
  const mk = (file, n) => Array.from({ length: n }, (_, i) => ({ file, line: i + 1, op: "x", before: "", after: "" }));
  const picked = selectMutants([...mk("a.js", 5), ...mk("b.js", 5)], 4);
  assert.deepEqual(picked.map((m) => m.file), ["a.js", "b.js", "a.js", "b.js"]);
});

test("applyMutant: refuses when the line drifted", () => {
  assert.equal(applyMutant("x\ny\n", { line: 1, before: "z", after: "q" }), null);
  assert.equal(applyMutant("x\ny\n", { line: 1, before: "x", after: "q" }), "q\ny\n");
});

// -------------------------------------------------------------------------- G14 (e2e)

test("G14: a weak receipt ('not the old value') lets a mutant survive -> flagged; block mode blocks", () => {
  // The bench's measured escape, reproduced: mod should become 2; the receipt only
  // asserts "not 1". Mutating the fix (2 -> 3) keeps the weak receipt green = survivor.
  const weakReceipt = `const f=require("./mod");if(f()===1){console.error("still old");process.exit(1)}console.log("ok");\n`;
  const files = (over) => ({
    baseFiles: { "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" }, ...(over || {}) }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": weakReceipt },
  });
  const a = makeRepo(files());
  const warn = runVerify({ dir: a.dir, base: a.base, head: a.head, prBody: "closes #1", receiptOut: path.join(a.dir, "r.json") });
  assert.equal(warn.verdict, "WARN", warn.reason);
  assert.ok(warn.warnings.some((w) => /G14 receipt strength/.test(w) && /SURVIVED/.test(w)), JSON.stringify(warn.warnings));
  assert.ok(warn.receipt.gates.G14.survived.length >= 1);

  const b = makeRepo(files({ gates: { G14: { mode: "block" } } }));
  const block = runVerify({ dir: b.dir, base: b.base, head: b.head, prBody: "closes #1" });
  assert.equal(block.verdict, "BLOCK");
  assert.match(block.reason, /G14 receipt strength/);
});

test("G14: a strong receipt (exact value) kills every mutant -> clean PASS, recorded", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" } }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1", receiptOut: path.join(dir, "r.json") });
  assert.equal(r.verdict, "PASS", r.reason + JSON.stringify(r.warnings));
  assert.ok(r.receipt.gates.G14, "a clean run is still recorded");
  assert.deepEqual(r.receipt.gates.G14.survived, []);
  assert.ok(r.receipt.gates.G14.tried >= 1, "at least the number literal was mutated");
});

// ------------------------------------------------------------------- G12 env-sniff

test("G12 env-sniff: production code that special-cases CI is flagged on any verified claim", () => {
  const sniffing = `module.exports=()=>{ if (process.env.CI) { return 2; } return 1; };\n`;
  const files = {
    baseFiles: { "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" }, ...NO_G14 }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": sniffing, "mod.test.js": testAsserting(2) },
  };
  // Only meaningful where CI is set (locally green would fail anyway) - simulate CI.
  const a = makeRepo(files);
  const r = runVerify({ dir: a.dir, base: a.base, head: a.head, prBody: "closes #1", env: { CI: "1" } });
  assert.ok(r.warnings.some((w) => /G12 test-environment sniffing/.test(w) && /mod\.js/.test(w)),
    `flagged: ${r.reason} ${JSON.stringify(r.warnings)}`);

  const b = makeRepo(files);
  const blocked = runVerify({
    dir: b.dir, base: b.base, head: b.head, env: { CI: "1" },
    prBody: "work-type: feature",
  });
  // work-typed claims are also in scope for the sniff (feature agents cheat too)…
  assert.ok(blocked.warnings.some((w) => /G12 test-environment sniffing/.test(w)) || /G12 test-environment/.test(blocked.reason),
    `feature-scope: ${blocked.reason} ${JSON.stringify(blocked.warnings)}`);
});

test("G12 env-sniff: NODE_ENV === 'production' is NOT a sniff; removed sniffs are not flagged", () => {
  const legit = `module.exports=()=>{ if (process.env.NODE_ENV === "production") { return 2; } return 2; };\n`;
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" }, ...NO_G14 }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": legit, "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.ok(!r.warnings.some((w) => /env/.test(w) && /G12/.test(w)), JSON.stringify(r.warnings));

  const sniffUnit = computeEnvSniff({
    changedSource: ["x.js"],
    base: "B", head: "H",
    readAt: (c) => (c === "B" ? "if (process.env.CI) {}" : "clean();"),
  });
  assert.deepEqual(sniffUnit.findings, [], "a REMOVED sniff is an improvement, not a finding");

  const commentUnit = computeEnvSniff({
    changedSource: ["y.js", "z.py"],
    base: "B", head: "H",
    readAt: (c, f) =>
      c === "B" ? "" :
      f === "y.js" ? "// never do: if (process.env.CI) return 2\nreal();\n" :
      "# a note about os.environ.get('CI') pitfalls\nreal()\n",
  });
  assert.deepEqual(commentUnit.findings, [], "a comment MENTIONING a sniff is docs, not behavior");
});
