// reopen_rate: does the BAR work, as distinct from whether one fix met it.
//
// The three constraints are the whole design, and each has a failure mode that makes the
// metric actively misleading rather than merely absent:
//   1. the unit is the OBSERVABLE, not the ticket - one flaky surface reopened under five
//      ticket numbers is ONE recurring miss, and counting tickets reports five unrelated ones
//   2. every reopen carries a cause_class - a dominant class is a missing capability
//   3. env-parity is bucketed SEPARATELY and excluded from the headline - the fix was right
//      and the environment was not, so counting it blames the surface for a staging problem
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INDEX = path.join(__dirname, "..", "..", "plugin", "mcp", "trajectory-kb", "index.js");
const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });

const call = (id, name, args) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
  params: { name, arguments: args } });

function run(store, lines) {
  const env = { ...process.env, TRAJECTORY_STORE: store, RECEIPTS_TRAJECTORY_STORE: store };
  return spawnSync("node", [INDEX], { input: [INIT, ...lines].join("\n") + "\n", encoding: "utf8", env, timeout: 60000 });
}

function reopenRate(store, repo) {
  // A SECOND process, deliberately: appends and reads issued in one pipelined batch race,
  // and a test that races reports a different number every run.
  const r = run(store, [call(99, "reopen_rate", { repo })]);
  for (const line of r.stdout.split("\n")) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.id === 99) return JSON.parse(d.result.content[0].text);
  }
  throw new Error("no reopen_rate response\n" + r.stderr);
}

const SEED = [
  { surface: "orders", surface_key: "src/orders/List.tsx", symptom: "totals", outcome: "fixed" },
  { surface: "pdf", surface_key: "src/pdf/Invoice.tsx", symptom: "blank", outcome: "fixed" },
  { surface: "pdf", surface_key: "src/pdf/Invoice.tsx", symptom: "blank2", outcome: "fixed", reopened: true, cause_class: "parallel-twin" },
  { surface: "pdf", surface_key: "src/pdf/Invoice.tsx", symptom: "blank3", outcome: "fixed", reopened: true, cause_class: "wrong-surface" },
  { surface: "settings", surface_key: "src/Settings.tsx", symptom: "stale", outcome: "fixed", reopened: true, cause_class: "env-parity" },
];

function seeded() {
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb-")), "kb.jsonl");
  run(store, SEED.map((s, i) => call(i + 3, "append_trajectory", { repo: "demo", ...s })));
  return store;
}

test("the unit is the observable, not the entry", () => {
  const r = reopenRate(seeded(), "demo");
  assert.equal(r.observables, 3, "three distinct surface_keys across five entries");
});

test("a surface with real reopens is counted once, with its cause classes", () => {
  const r = reopenRate(seeded(), "demo");
  assert.equal(r.observables_reopened, 1);
  assert.equal(r.reopen_events, 2);
  assert.deepEqual(r.by_cause, { "parallel-twin": 1, "wrong-surface": 1 });
});

test("env-parity is excluded from the headline and reported separately", () => {
  const r = reopenRate(seeded(), "demo");
  // Settings reopened once, for env-parity ONLY. If it leaked into the headline the rate
  // would be 0.667 and the worst-offenders list would point at the wrong surface.
  assert.equal(r.reopen_rate, 0.333);
  assert.equal(r.env_parity_excluded.events, 1);
  assert.equal(r.env_parity_excluded.surfaces, 1);
  assert.ok(!r.worst_offenders.some((w) => w.surface_key.includes("settings")),
    "an env-parity-only surface must not be named a worst offender");
});

test("a store with no reopens reports a zero rate, not an error", () => {
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb-")), "kb.jsonl");
  run(store, [call(3, "append_trajectory", { repo: "demo", surface: "a", surface_key: "src/A.tsx", symptom: "x", outcome: "fixed" })]);
  const r = reopenRate(store, "demo");
  assert.equal(r.reopen_rate, 0);
  assert.deepEqual(r.by_cause, {});
});
