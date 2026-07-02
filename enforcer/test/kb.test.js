"use strict";
/*
 * `receipts kb recur` / `receipts kb distill` - analytics over the trajectory memory.
 *
 * Driven as a subprocess (the real CLI contract), reading a seeded temp JSONL store pinned
 * via RECEIPTS_TRAJECTORY_STORE (the same override the MCP server + hook honor). Asserts:
 * recur groups by surface_key + histograms outcomes + sorts by count; --repo scopes it;
 * --json shape; and each distill rule FIRING with evidence AND staying silent when its
 * threshold is not met.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BIN = path.join(__dirname, "..", "..", "bin", "receipts.js");

// Seed a temp store, run `receipts kb <args>` against it, return {stdout, stderr, code}.
function runKb(entries, args) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-kb-"));
  const store = path.join(td, "trajectories.jsonl");
  const body = Array.isArray(entries) ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n" : String(entries);
  fs.writeFileSync(store, body);
  const r = spawnSync(process.execPath, [BIN, "kb", ...args], {
    encoding: "utf8",
    env: { ...process.env, RECEIPTS_TRAJECTORY_STORE: store },
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status };
}

const e = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  ts: over.ts || "2026-01-01T00:00:00.000Z",
  repo: "web-app",
  surface_key: "paymentform",
  symptom: "s",
  root_cause: "rc",
  outcome: "fixed",
  what_worked: [],
  what_failed: [],
  files: [],
  regressed: [],
  tags: [],
  supersedes: null,
  ...over,
});

// ------------------------------------------------------------------- recur

test("kb recur groups by surface_key, histograms outcomes, and sorts by count desc", () => {
  const out = runKb(
    [
      e({ id: "1", surface_key: "paymentform", outcome: "reverted", ts: "2026-01-01T00:00:00.000Z" }),
      e({ id: "2", surface_key: "paymentform", outcome: "unverified-reasoned", ts: "2026-01-02T00:00:00.000Z" }),
      e({ id: "3", surface_key: "usagechart", outcome: "fixed", ts: "2026-01-03T00:00:00.000Z" }),
    ],
    ["recur"],
  );
  assert.equal(out.code, 0, out.stderr);
  // paymentform (2x) must be listed before usagechart (1x)
  const iPay = out.stdout.indexOf("paymentform");
  const iChart = out.stdout.indexOf("usagechart");
  assert.ok(iPay >= 0 && iChart >= 0, out.stdout);
  assert.ok(iPay < iChart, "higher-count surface listed first");
  assert.match(out.stdout, /2x\s+paymentform/, "shows the recurrence count");
  assert.match(out.stdout, /reverted:1/, "histograms outcomes");
  assert.match(out.stdout, /unverified-reasoned:1/);
});

test("kb recur --json emits the grouped shape", () => {
  const out = runKb(
    [e({ id: "1", surface_key: "paymentform", outcome: "reverted", what_failed: ["wrong layer"] })],
    ["recur", "--json"],
  );
  assert.equal(out.code, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.ok(Array.isArray(parsed.groups));
  assert.equal(parsed.groups[0].surface_key, "paymentform");
  assert.equal(parsed.groups[0].count, 1);
  assert.deepEqual(parsed.groups[0].outcomes, { reverted: 1 });
  assert.equal(parsed.groups[0].top_failed, "wrong layer");
});

test("kb recur --repo scopes to one repo", () => {
  const out = runKb(
    [
      e({ id: "1", repo: "web-app", surface_key: "paymentform", outcome: "reverted" }),
      e({ id: "2", repo: "other-app", surface_key: "login", outcome: "fixed" }),
    ],
    ["recur", "--repo", "web-app", "--json"],
  );
  assert.equal(out.code, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.repo, "web-app");
  assert.equal(parsed.groups.length, 1, "only the web-app surface");
  assert.equal(parsed.groups[0].surface_key, "paymentform");
});

test("kb recur on an empty store reports nothing found (exit 0)", () => {
  const out = runKb("", ["recur"]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /no trajectory entries/i);
});

test("kb recur excludes superseded entries", () => {
  const out = runKb(
    [
      e({ id: "old", surface_key: "sk", outcome: "reverted" }),
      e({ id: "new", surface_key: "sk", outcome: "fixed", supersedes: "old" }),
    ],
    ["recur", "--json"],
  );
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.groups[0].count, 1, "the superseded entry does not count");
  assert.deepEqual(parsed.groups[0].outcomes, { fixed: 1 });
});

// ------------------------------------------------------------------- distill: rules FIRE

test("distill R1: a surface_key with >=2 non-fixed outcomes -> recurring-trouble-spot", () => {
  const out = runKb(
    [
      e({ id: "1", surface_key: "paymentform", outcome: "reverted", what_failed: ["wrong layer"] }),
      e({ id: "2", surface_key: "paymentform", outcome: "unverified-reasoned", what_failed: ["still stuck"] }),
    ],
    ["distill"],
  );
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /recurring-trouble-spot/);
  assert.match(out.stdout, /paymentform/);
  assert.match(out.stdout, /G6 family/, "the suggestion names the concrete lever");
  assert.match(out.stdout, /2 non-fixed outcome/, "the evidence line is printed");
});

test("distill R2: a repo with >=2 reverted -> gates.G12.mode block suggestion", () => {
  const out = runKb(
    [
      e({ id: "1", repo: "web-app", surface_key: "a", outcome: "reverted" }),
      e({ id: "2", repo: "web-app", surface_key: "b", outcome: "reverted" }),
    ],
    ["distill"],
  );
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /revert-prone-repo/);
  assert.match(out.stdout, /G12\.mode.*block/i);
  assert.match(out.stdout, /2 entries with outcome "reverted"/);
});

test("distill R3: >=2 what_failed mentioning 'flaky' -> verify.receipt_runs 2", () => {
  const out = runKb(
    [
      e({ id: "1", surface_key: "a", outcome: "unverified-reasoned", what_failed: ["the test is flaky under load"] }),
      e({ id: "2", surface_key: "b", outcome: "unverified-reasoned", what_failed: ["flaky retry masked the real failure"] }),
    ],
    ["distill"],
  );
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /flaky-receipts/);
  assert.match(out.stdout, /receipt_runs:\s*2/);
});

test("distill --json emits the suggestion shape with rule + evidence", () => {
  const out = runKb(
    [
      e({ id: "1", surface_key: "paymentform", outcome: "reverted", what_failed: ["x"] }),
      e({ id: "2", surface_key: "paymentform", outcome: "speculative", what_failed: ["y"] }),
    ],
    ["distill", "--json"],
  );
  const parsed = JSON.parse(out.stdout);
  assert.ok(Array.isArray(parsed.suggestions));
  const r1 = parsed.suggestions.find((s) => s.rule === "recurring-trouble-spot");
  assert.ok(r1, "R1 present");
  assert.equal(r1.subject, "paymentform");
  assert.ok(Array.isArray(r1.evidence) && r1.evidence.length >= 1);
});

// ------------------------------------------------------------- distill: rules do NOT fire

test("distill R1 does NOT fire with only ONE non-fixed outcome on a surface", () => {
  const out = runKb(
    [
      e({ id: "1", surface_key: "paymentform", outcome: "reverted", what_failed: ["x"] }),
      e({ id: "2", surface_key: "paymentform", outcome: "fixed" }), // fixed doesn't count toward the trouble threshold
    ],
    ["distill", "--json"],
  );
  const parsed = JSON.parse(out.stdout);
  assert.ok(!parsed.suggestions.some((s) => s.rule === "recurring-trouble-spot"), "one non-fixed is below threshold");
});

test("distill R2 does NOT fire with a single reverted", () => {
  const out = runKb([e({ id: "1", repo: "web-app", outcome: "reverted" })], ["distill", "--json"]);
  const parsed = JSON.parse(out.stdout);
  assert.ok(!parsed.suggestions.some((s) => s.rule === "revert-prone-repo"), "one revert is below threshold");
});

test("distill R3 does NOT fire with a single flaky mention", () => {
  const out = runKb([e({ id: "1", surface_key: "a", outcome: "unverified-reasoned", what_failed: ["flaky once"] })], ["distill", "--json"]);
  const parsed = JSON.parse(out.stdout);
  assert.ok(!parsed.suggestions.some((s) => s.rule === "flaky-receipts"), "one flaky mention is below threshold");
});

test("distill on a store with only clean fixes yields no suggestions", () => {
  const out = runKb(
    [e({ id: "1", surface_key: "a", outcome: "fixed" }), e({ id: "2", surface_key: "b", outcome: "fixed" })],
    ["distill"],
  );
  assert.equal(out.code, 0);
  assert.match(out.stdout, /no actionable pattern/i);
});

// -------------------------------------------------------------------- usage

test("kb with no subcommand exits 2 with usage", () => {
  const r = spawnSync(process.execPath, [BIN, "kb"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: receipts kb/);
});
