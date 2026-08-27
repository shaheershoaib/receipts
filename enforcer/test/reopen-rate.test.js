// reopen_rate: does the BAR work, as distinct from whether one fix met it.
//
// The three constraints ARE the design, and each has a failure mode that makes the metric
// actively misleading rather than merely absent:
//   1. the unit is the OBSERVABLE, not the entry - one flaky surface reopened under five
//      ticket numbers is ONE recurring miss; counting entries reports five unrelated ones
//   2. every reopen carries a cause_class - a dominant class is a missing capability
//   3. env-parity is bucketed SEPARATELY and excluded from the headline - the fix was right
//      and the environment was not, so counting it blames the surface for a staging problem
//
// Tests the PURE aggregation, deliberately: driving it through the MCP server would need
// that package's dependencies installed, and a test that only runs where someone happened
// to `npm install` is a test that silently does not run in CI. (It did exactly that here.)
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const MOD = path.join(__dirname, "..", "..", "plugin", "mcp", "trajectory-kb", "reopen-rate.js");
const load = () => import(MOD);

const SEED = [
  { id: "1", surface_key: "src/orders/List.tsx", outcome: "fixed" },
  { id: "2", surface_key: "src/pdf/Invoice.tsx", outcome: "fixed" },
  { id: "3", surface_key: "src/pdf/Invoice.tsx", outcome: "fixed", reopened: true, cause_class: "parallel-twin" },
  { id: "4", surface_key: "src/pdf/Invoice.tsx", outcome: "fixed", reopened: true, cause_class: "wrong-surface" },
  { id: "5", surface_key: "src/Settings.tsx", outcome: "fixed", reopened: true, cause_class: "env-parity" },
];

test("the unit is the observable, not the entry", async () => {
  const { computeReopenRate } = await load();
  assert.equal(computeReopenRate(SEED).observables, 3, "three surface_keys across five entries");
});

test("a reopened surface is counted once, with its cause classes", async () => {
  const { computeReopenRate } = await load();
  const r = computeReopenRate(SEED);
  assert.equal(r.observables_reopened, 1);
  assert.equal(r.reopen_events, 2);
  assert.deepEqual(r.by_cause, { "parallel-twin": 1, "wrong-surface": 1 });
});

test("env-parity is excluded from the headline and reported separately", async () => {
  const { computeReopenRate } = await load();
  const r = computeReopenRate(SEED);
  // Settings reopened once, env-parity ONLY. Leaked into the headline it would read 0.667
  // and the worst-offenders list would name the wrong surface.
  assert.equal(r.reopen_rate, 0.333);
  assert.equal(r.env_parity_excluded.events, 1);
  assert.equal(r.env_parity_excluded.surfaces, 1);
  assert.ok(!r.worst_offenders.some((w) => /settings/i.test(w.surface_key)),
    "an env-parity-only surface must never be named a worst offender");
});

test("worst offenders rank by real reopens", async () => {
  const { computeReopenRate } = await load();
  const r = computeReopenRate(SEED);
  assert.equal(r.worst_offenders[0].surface_key, "src/pdf/Invoice.tsx");
  assert.equal(r.worst_offenders[0].reopens, 2);
});

test("no reopens reports a zero rate, not an error", async () => {
  const { computeReopenRate } = await load();
  const r = computeReopenRate([{ id: "1", surface_key: "src/A.tsx", outcome: "fixed" }]);
  assert.equal(r.reopen_rate, 0);
  assert.deepEqual(r.by_cause, {});
});

test("an unclassified reopen still counts, tagged as such", async () => {
  const { computeReopenRate } = await load();
  const r = computeReopenRate([{ id: "1", surface_key: "src/A.tsx", outcome: "fixed", reopened: true }]);
  assert.deepEqual(r.by_cause, { unclassified: 1 });
});

test("the cause vocabulary is exported and contains env-parity", async () => {
  const { CAUSE_CLASSES } = await load();
  assert.ok(CAUSE_CLASSES.includes("env-parity"));
  assert.ok(CAUSE_CLASSES.includes("wrong-surface"));
});
