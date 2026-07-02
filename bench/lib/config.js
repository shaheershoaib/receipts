"use strict";
/*
 * Build a receipts.config.json string for a bench fixture.
 *
 * Unlike enforcer/test/helpers.js's cfg(), this injects NO default test_command: each
 * stack supplies its own (node / python3 / bash), and the data/no-test-runner stack
 * supplies NONE on purpose - that is the whole point of that stack (it documents the gap
 * Phase 1 closes). A behavior can then deep-override any block (verify / degrade / gates)
 * to flip a gate to block mode, relax the no-receipt degrade, etc.
 */

// Shallow-per-block deep merge: the top-level blocks a fixture tweaks (claim / build /
// verify / degrade / gates) merge one level down; everything else replaces. Mirrors the
// merge semantics of the enforcer's test cfg() so behaviors read the same way.
function mergeCfg(base, over) {
  const merged = { ...base, ...over };
  for (const k of ["claim", "build", "verify", "degrade", "gates"]) {
    if (over && over[k]) merged[k] = { ...(base[k] || {}), ...over[k] };
  }
  return merged;
}

// over: { verify, degrade, gates, claim, build } - deep-merged one level down.
function buildConfig(over = {}) {
  const base = {
    version: 1,
    claim: {
      issue_link: "closes #(\\d+)",
      downgrade_tags: ["unverified-reasoned", "speculative", "reverted"],
    },
    build: { sha_source: "none", platform: "none" },
    verify: {}, // NO default test_command - each stack sets its own (data sets none)
    degrade: {},
    gates: { enabled: "all", disabled: [] },
  };
  return JSON.stringify(mergeCfg(base, over), null, 2) + "\n";
}

// The "receipts OFF" transform: rewrite a config JSON string to approximate a repo WITHOUT
// the harness's optional gates and without the no-receipt block. This is the A/B baseline
// the README predicts against: disable every optional gate (G6-G13), relax the no-receipt
// and load-error degrades to warn, and drop the strict any-source-change trigger. What
// REMAINS on is only the enforcer's irreducible SPINE - the red-on-base / green-on-head
// receipt check itself - because that is not a "gate" you can toggle; it is what a receipt
// verifier fundamentally does. So this baseline shows the gate-attributable catches
// evaporating while the spine still catches a fix that fails its own test. (A repo with NO
// enforcer at all accepts everything - the trivial 100%-escape end state; this transform
// models the more instructive "enforcer present, optional gates off" middle.)
function toGatesOff(cfgJsonString) {
  let cfg;
  try { cfg = JSON.parse(cfgJsonString); } catch { return cfgJsonString; }
  cfg.gates = { enabled: "none", disabled: ["G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13"] };
  cfg.degrade = { ...(cfg.degrade || {}), on_no_receipt: "warn" };
  cfg.verify = { ...(cfg.verify || {}), on_load_error_red: "warn", require_fresh_base: "off" };
  if (cfg.claim) cfg.claim = { ...cfg.claim, require_receipt_for: "issue-link" };
  return JSON.stringify(cfg, null, 2) + "\n";
}

module.exports = { buildConfig, mergeCfg, toGatesOff };
