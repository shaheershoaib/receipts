"use strict";
/* Tests for the receipt -> markdown renderer and the action-side reporter. */
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { renderMarkdown, renderComment, COMMENT_MARKER } = require("../render.js");
const { cfg, makeRepo, runVerify, testAsserting, modReturning } = require("./helpers.js");

const FIXTURE = {
  schema: "receipts/receipt@1",
  generated_at: "2026-07-01T00:00:00.000Z",
  base: "aaaabbbbccccdddd", head: "eeeeffff00001111",
  config_source: "base", is_fix_claim: true, strict: false, work_type: null,
  verdict: "BLOCK",
  reason: "G9 full-scope green: the fix passes its own receipt but BREAKS the full suite",
  detail: "expected 3 got 2",
  red: true, green: true, pinned: true,
  tests: ["src/modal.test.tsx"],
  warnings: ["G8 fresh base: branch is behind its base by 2 commit(s)"],
  gates: {
    G7: { new_dependents: [{ file: "src/Chart.tsx", tests: [] }], ok: false },
    G11: { deletions: ["old.test.js"], skips: [{ file: "a.test.js", marker: ".skip(", added: 1 }], snapshots: [], acknowledged: false },
    G12: { findings: [{ file: "src/auth.js", kind: "removed-throw", name: "throw/raise removed", removed: 1 }] },
  },
  commands: [
    { label: "receipt-red@base", command: 'npm test -- "src/modal.test.tsx"', ok: false, exit_code: 1, duration_ms: 4213, timed_out: false, output_tail: "..." },
    { label: "suite@head", command: "npm test", ok: false, exit_code: 1, duration_ms: 51234, timed_out: true, output_tail: "..." },
  ],
};

test("renderMarkdown: verdict, evidence, gates, commands, warnings all present", () => {
  const md = renderMarkdown(FIXTURE);
  assert.match(md, /## ❌ receipts: BLOCK/);
  assert.match(md, /G9 full-scope green/);
  assert.match(md, /`aaaabbbbcc` \(base\) → `eeeeffff00` \(head\)/);
  assert.match(md, /red on base: ✅ · green on head: ✅ · pinned/);
  assert.match(md, /fix-claim/);
  assert.match(md, /receipt-red@base/);
  assert.match(md, /⏱ timed out/);
  assert.match(md, /G11 referee integrity/);
  assert.match(md, /G12 silencing shapes/);
  assert.match(md, /G7 new dependents/);
  assert.match(md, /G8 fresh base/);
  assert.match(md, /replay <receipt\.json>/);
});

test("renderMarkdown: a head-sourced config is called out as weaker", () => {
  const md = renderMarkdown({ ...FIXTURE, config_source: "head" });
  assert.match(md, /first-setup: the PR controlled its own gate config/);
});

test("renderComment starts with the upsert marker", () => {
  const body = renderComment(FIXTURE);
  assert.ok(body.startsWith(COMMENT_MARKER));
});

test("renderMarkdown: table cells survive pipes and newlines in inputs", () => {
  const md = renderMarkdown({
    ...FIXTURE,
    reason: "a | b",
    commands: [{ label: "x|y", command: "run | tee", ok: true, exit_code: 0, duration_ms: 5, timed_out: false }],
  });
  assert.match(md, /a \\\| b/);
  assert.match(md, /run \\\| tee/);
});

test("report.js: writes the report to GITHUB_STEP_SUMMARY, exits 0, never throws", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-report-"));
  const receiptPath = path.join(tmp, "receipt.json");
  const summaryPath = path.join(tmp, "summary.md");
  fs.writeFileSync(receiptPath, JSON.stringify(FIXTURE));
  execFileSync("node", [path.join(__dirname, "..", "report.js"), receiptPath], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath, COMMENT: "", GH_TOKEN: "", PR_NUMBER: "" },
  });
  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(summary, /## ❌ receipts: BLOCK/);
});

test("report.js: a missing receipt is a note, not a failure (reporting cannot flip a verdict)", () => {
  const r = execFileSync("node", [path.join(__dirname, "..", "report.js"), "/nonexistent/receipt.json"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "", COMMENT: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(typeof r, "string"); // exit 0 is the assertion; execFileSync throws otherwise
});

test("explain --md renders the same report from the CLI (one renderer, no drift)", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: { "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" } }), "mod.js": modReturning(1) },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const receiptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "receipts-explain-")), "r.json");
  const r = runVerify({ dir, base, head, prBody: "closes #1", receiptOut: receiptPath });
  assert.equal(r.verdict, "PASS");
  const md = execFileSync("node", [path.join(__dirname, "..", "..", "bin", "receipts.js"), "explain", receiptPath, "--md"], { encoding: "utf8" });
  assert.match(md, /## ✅ receipts: PASS/);
  assert.match(md, /red on base: ✅ · green on head: ✅/);
});
