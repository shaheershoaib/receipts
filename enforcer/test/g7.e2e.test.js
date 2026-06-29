"use strict";
/*
 * G7 end-to-end: the enforcer re-runs the tests of NEW consumers of the changed surface.
 *
 * Scenario (the scar): a fix changes `field` to return a number; a consumer `chart` that
 * NEWLY routes through `field` (an edge that did not exist at base) now breaks. The carried
 * receipt (field's own test) is green - but chart's test, which the receipt never exercises,
 * fails. G7 catches it.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { cfg, makeRepo, runVerify } = require("./helpers.js");

const FIX = "closes #1";

// field: the changed surface. base returns a string; head returns a number (the "fix").
const FIELD_BASE = 'module.exports={field:()=>"v1"};\n';
const FIELD_HEAD = "module.exports={field:()=>42};\n";
// the carried receipt for the fix: red on base (string !== 42), green on head.
const RECEIPT = 'const {field}=require("./field");if(field()!==42)process.exit(1);console.log("ok");\n';
// chart: a consumer. base does NOT import field; head NEWLY imports it and calls a string
// method on it (breaks when field() is a number).
const CHART_BASE = 'module.exports=()=>"static";\n';
const CHART_HEAD_BREAKS = 'const {field}=require("./field");module.exports=()=>field().toUpperCase();\n';
const CHART_HEAD_STABLE_IMPORT = CHART_HEAD_BREAKS; // same broken body, used for the "stable edge" case
const CHART_TEST = 'const chart=require("./chart");const r=chart();if(typeof r!=="string")process.exit(1);console.log("ok");\n';

function scenario(over = {}, { withChartTest = true, chartBase = CHART_BASE } = {}) {
  const baseFiles = {
    "field.js": FIELD_BASE,
    "chart.js": chartBase,
    "receipts.config.json": cfg(over),
  };
  const headFiles = {
    "field.js": FIELD_HEAD,
    "chart.js": CHART_HEAD_BREAKS,
    "field.test.js": RECEIPT,
  };
  if (withChartTest) { baseFiles["chart.test.js"] = CHART_TEST; } // pre-existing, unchanged
  return makeRepo({ baseFiles, headFiles });
}

test("G7 block: a NEW consumer that breaks fails the gate", () => {
  const r = scenario({ gates: { G7: { mode: "block" } } });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /G7 dependent regression/i);
});

test("G7 warn (default): a NEW consumer that breaks is surfaced, not blocked", () => {
  const r = scenario(); // no G7.mode -> warn
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.exitCode, 0, v.raw);
  assert.ok(
    (v.warnings || []).some((w) => /G7 dependent regression/i.test(w)),
    "expected a G7 regression warning: " + JSON.stringify(v.warnings));
});

test("G7: a NEW consumer with no co-located test is surfaced as a warning", () => {
  const r = scenario({ gates: { G7: { mode: "block" } } }, { withChartTest: false });
  const v = runVerify({ ...r, prBody: FIX });
  // no test to run -> cannot block on a failure; warns that the consumer is unverified
  assert.equal(v.exitCode, 0, v.raw);
  assert.ok(
    (v.warnings || []).some((w) => /no co-located test/i.test(w)),
    "expected a no-test warning: " + JSON.stringify(v.warnings));
});

test("G7 default scope is NEW dependents only: a STABLE consumer is not re-run", () => {
  // chart imports field at BOTH base and head (the edge is not new) -> not a NEW dependent,
  // so G7 does not re-run it (that is the full suite's / G9's job).
  const r = scenario({ gates: { G7: { mode: "block" } } }, { chartBase: CHART_HEAD_STABLE_IMPORT });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.exitCode, 0, v.raw); // not blocked: the stable consumer is out of G7's default scope
  assert.ok(!(v.warnings || []).some((w) => /G7 dependent regression/i.test(w)), v.raw);
});

test("G7 verify_all_dependents widens the scope to a stable consumer too", () => {
  const r = scenario(
    { gates: { G7: { mode: "block", verify_all_dependents: true } } },
    { chartBase: CHART_HEAD_STABLE_IMPORT });
  const v = runVerify({ ...r, prBody: FIX });
  assert.equal(v.verdict, "BLOCK", v.raw); // now the stable consumer's regression is caught
  assert.match(v.reason, /G7 dependent regression/i);
});
