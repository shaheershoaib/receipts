"use strict";
/* E2E tests for `receipts report` (aggregate receipt artifacts) and the runnable demo. */
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { aggregateReceipts } = require("../render.js");

const BIN = path.join(__dirname, "..", "..", "bin", "receipts.js");

const RECEIPTS = [
  { schema: "receipts/receipt@1", verdict: "PASS", red: true, green: true, is_fix_claim: true, pinned: true, reason: "receipt verified", warnings: ["G8 fresh base: behind"], config_source: "base" },
  { schema: "receipts/receipt@1", verdict: "BLOCK", red: false, green: true, is_fix_claim: true, reason: "weak receipt: the test PASSES on the base commit", warnings: [], config_source: "base" },
  { schema: "receipts/receipt@1", verdict: "PASS", is_fix_claim: true, reason: "honest downgrade 'speculative' present - tracked", warnings: [], config_source: "head" },
  { schema: "receipts/receipt@1", verdict: "WARN", work_type: "refactor", reason: "refactor verified", warnings: ["G14 receipt strength: 1/6 mutant(s) SURVIVED"], config_source: "base" },
];

test("aggregateReceipts: the team signals an eng lead actually asks for", () => {
  const agg = aggregateReceipts(RECEIPTS);
  assert.equal(agg.total, 4);
  assert.deepEqual(agg.verdicts, { PASS: 2, WARN: 1, BLOCK: 1, other: 0 });
  assert.equal(agg.real_receipts, 1, "red AND green");
  assert.equal(agg.fix_claims, 3);
  assert.equal(agg.honest_downgrades, 1, "the pressure valve is visible");
  assert.equal(agg.weak_receipts, 1);
  assert.equal(agg.head_configs, 1, "weaker provenance is counted");
  assert.equal(agg.gate_warnings.G8, 1);
  assert.equal(agg.gate_warnings.G14, 1, "G14 parses as its own gate, not G1");
});

test("receipts report: aggregates a directory of artifacts; --json is machine-readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-report-"));
  RECEIPTS.forEach((r, i) => fs.writeFileSync(path.join(dir, `r${i}.json`), JSON.stringify(r)));
  fs.writeFileSync(path.join(dir, "not-a-receipt.json"), '{"hello": 1}'); // skipped, not fatal

  const text = execFileSync("node", [BIN, "report", dir], { encoding: "utf8" });
  assert.match(text, /4 receipt\(s\)/);
  assert.match(text, /PASS 2 · WARN 1 · BLOCK 1/);
  assert.match(text, /1 downgrade\(s\)/);

  const json = JSON.parse(execFileSync("node", [BIN, "report", dir, "--json"], { encoding: "utf8" }));
  assert.equal(json.total, 4);
  assert.equal(json.weak_receipts, 1);
});

test("the demo blocks the wrong-axis fix and passes the exact-value one (docs that execute)", () => {
  const out = execFileSync("node", [path.join(__dirname, "..", "..", "examples", "caught-wrong-fix", "run-demo.js")], { encoding: "utf8" });
  const verdicts = out.split("\n").filter((l) => l.startsWith("receipts: "));
  assert.equal(verdicts.length, 2, out);
  assert.match(verdicts[0], /^receipts: BLOCK - weak receipt/);
  assert.match(verdicts[1], /^receipts: PASS - receipt verified/);
});
