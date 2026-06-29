#!/usr/bin/env node
"use strict";
/*
 * receipts enforcer - re-prove a fix-claim at the PR.
 *
 * The receipt is a red-before / green-after acceptance test the fix carries. This
 * re-runs it: the changed test must FAIL on the base commit (it reproduces the
 * reported bug) and PASS on the head commit (the bug is gone). No receipt AND no
 * honest-downgrade tag => blocked. An honest downgrade tag => tracked, allowed.
 *
 * It also checks two things that keep the green honest in a multi-dev repo:
 *   G8 fresh base - the branch is built on the current base tip, not behind it
 *                   (a green earned on a stale base is green on code that won't ship).
 *   G9 full green - the WHOLE suite passes on head, not only the changed test
 *                   (the regression is often in code the changed test never runs).
 *
 * Zero dependencies (git + the project's own test command, from receipts.config.json).
 * It moves HEAD around to overlay the new test onto the base source, so it refuses
 * to run on a dirty tree and always restores the original checkout.
 *
 * Usage:
 *   node verify.js --base <sha> --head <sha> [--repo <dir>] [--config <path>]
 *                  [--pr-body <text> | --pr-body-file <path>] [--json]
 * Exit: 0 for PASS/WARN, 1 for BLOCK.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TEST_PATH = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|\/__tests__\/|_spec\.)/i;
let ARGS = {};
const WARNINGS = [];

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (["base", "head", "config", "repo", "pr-body", "pr-body-file"].includes(k)) o[k] = argv[++i];
      else o[k] = true;
    } else o._.push(a);
  }
  return o;
}

function git(repo, args) {
  try { return { ok: true, out: execSync(`git -C "${repo}" ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status }; }
}

function runCmd(repo, cmd) {
  try { execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return { ok: true, out: "" }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status }; }
}

function emit(verdict, reason, detail) {
  const warns = WARNINGS.length ? "\n  warnings:\n  - " + WARNINGS.join("\n  - ") : "";
  if (ARGS.json) console.log(JSON.stringify({ verdict, reason, detail: detail || null, warnings: WARNINGS }));
  else console.log(`receipts: ${verdict} - ${reason}` + (detail ? `\n  ${String(detail).trim()}` : "") + warns);
  process.exit(verdict === "BLOCK" ? 1 : 0);
}

function warn(reason) { WARNINGS.push(reason); }
function finish(reason) { emit(WARNINGS.length ? "WARN" : "PASS", reason); }

// A gate runs unless the project's `gates` config turns it off (by ID, G0-G10).
// No `gates` block => all on (backward-compatible).
function gateOn(gates, id) {
  if (!gates) return true;
  if ((gates.disabled || []).includes(id)) return false;
  const en = gates.enabled;
  if (!en || en === "all") return true;
  return Array.isArray(en) ? en.includes(id) : true;
}

// --- G10 rollout compatibility: a generic, zero-dep backward-compat check on changed
// contract artifacts. JSON contracts (OpenAPI/JSON-Schema/AsyncAPI/introspection) get a
// structural breaking-diff (a removed field/path, a removed enum value, a newly-required
// field, a narrowed type); other formats (GraphQL SDL, proto, yaml) get a "changed -
// verify manually" warning rather than false precision. Default verdict is WARN (a
// consumer can opt into block via gates.G10.mode). ---
const CONTRACT_RE = [
  /(^|\/)(openapi|swagger|asyncapi)\.(ya?ml|json)$/i,
  /\.(graphql|gql|proto|avsc)$/i,
  /(^|\/)schema\.(graphql|json)$/i,
];
function globToRe(g) {
  return new RegExp("^" + g.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}
function isContractFile(f, extra) {
  if (CONTRACT_RE.some((re) => re.test(f))) return true;
  return (extra || []).some((g) => { try { return globToRe(g).test(f) || f.includes(g.replace(/\*/g, "")); } catch { return false; } });
}
function walkBreaks(path, a, b, out, depth) {
  if (depth > 8 || out.length > 50) return;
  if (Array.isArray(a)) {
    if (/enum$/i.test(path) && Array.isArray(b))
      for (const v of a) if (typeof v !== "object" && !b.includes(v)) out.push(`removed enum value ${JSON.stringify(v)} at ${path}`);
    return;
  }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object" || Array.isArray(b)) { out.push(`removed or retyped object at ${path || "(root)"}`); return; }
    if (Array.isArray(a.required) && Array.isArray(b.required))
      for (const r of b.required) if (!a.required.includes(r)) out.push(`added required field "${r}" at ${path || "(root)"}`);
    for (const k of Object.keys(a)) {
      const cp = path ? path + "." + k : k;
      if (!(k in b)) { out.push(`removed "${cp}"`); continue; }
      if (k === "type" && typeof a[k] === "string" && typeof b[k] === "string" && a[k] !== b[k])
        out.push(`type changed at ${path || "(root)"}: ${a[k]} -> ${b[k]}`);
      walkBreaks(cp, a[k], b[k], out, (depth || 0) + 1);
    }
  }
}
function contractBreaks(file, baseSrc, headSrc) {
  if (/\.json$/i.test(file) || /^\s*[{[]/.test(baseSrc)) {
    try {
      const out = [];
      walkBreaks("", JSON.parse(baseSrc), JSON.parse(headSrc), out, 0);
      return { parsed: true, breaks: out.map((x) => `${file}: ${x}`) };
    } catch { /* not valid JSON -> unparseable */ }
  }
  return { parsed: false, breaks: [] };
}
function checkContracts(repo, base, head, gates) {
  if (!gateOn(gates, "G10")) return;
  const g10 = (gates && gates.G10) || {};
  const changed = git(repo, `diff --name-only ${base}..${head}`).out.split("\n").map((s) => s.trim()).filter(Boolean);
  const files = changed.filter((f) => isContractFile(f, g10.contract_paths));
  if (!files.length) return;
  const breaks = [], unparseable = [];
  for (const f of files) {
    const bs = git(repo, `show "${base}:${f}"`), hs = git(repo, `show "${head}:${f}"`);
    if (!bs.ok || !hs.ok) continue; // an added/removed file is not a change to an existing contract
    const r = contractBreaks(f, bs.out, hs.out);
    if (r.parsed) breaks.push(...r.breaks); else unparseable.push(f);
  }
  if (breaks.length) {
    const shown = breaks.slice(0, 6).join("; ") + (breaks.length > 6 ? ` (+${breaks.length - 6} more)` : "");
    const msg = `G10 rollout compatibility: potentially BREAKING contract change - ${shown}. A consumer still on the old side breaks during the deploy window; make it backward-compatible, sequence the deploys, or bump the major version.`;
    if ((g10.mode || "warn") === "block") emit("BLOCK", msg);
    warn(msg);
  }
  if (unparseable.length)
    warn(`G10: contract file(s) changed (${unparseable.join(", ")}) - no structural parser for this format; verify backward-compatibility across the deploy window manually.`);
}

function main() {
  ARGS = parseArgs(process.argv.slice(2));
  const repo = path.resolve(ARGS.repo || process.cwd());
  const cfg = JSON.parse(fs.readFileSync(ARGS.config || path.join(repo, "receipts.config.json"), "utf8"));
  const { base, head } = ARGS;
  if (!base || !head) emit("BLOCK", "usage: --base <sha> --head <sha>");
  const prBody = ARGS["pr-body-file"] ? fs.readFileSync(ARGS["pr-body-file"], "utf8") : (ARGS["pr-body"] || "");

  const claim = cfg.claim || {};
  const degrade = cfg.degrade || {};
  const verify = cfg.verify || {};
  const gates = cfg.gates || {};
  // Work type (per-PR): a `work-type:` line in the PR body, else gates.work_type. A
  // refactor/chore changes no behavior, so its receipt inverts (proof = the full suite
  // staying green on head, not a red->green on a new test).
  const workType = ((prBody.match(/work[ _-]?type\s*[:=]\s*([a-z]+)/i) || [])[1] || gates.work_type || "").toLowerCase();
  const inverted = workType === "refactor" || workType === "chore";

  // Not a fix-claim -> nothing to re-verify (only skip when a body was given to check).
  // A work-type-marked PR (e.g. a refactor asserting "no behavior change") IS a claim.
  const issueRe = new RegExp(claim.issue_link || "closes #(\\d+)", "i");
  if (prBody && !issueRe.test(prBody) && !workType) emit("PASS", "not a fix-claim (no issue link) - nothing to re-verify");

  // Honest downgrade -> tracked, not blocked (the honesty ladder).
  const tags = claim.downgrade_tags || ["unverified-reasoned", "speculative", "reverted"];
  const dg = tags.find((t) => new RegExp(t.replace(/-/g, "[- ]?"), "i").test(prBody));
  if (dg) emit("PASS", `honest downgrade '${dg}' present - tracked, not claimed as verified`);

  if (git(repo, "status --porcelain").out.trim())
    emit("BLOCK", "working tree not clean (the enforcer needs a clean checkout)");

  // G8 fresh base: is the branch built on the current base tip, or behind it? A green
  // earned on a stale base is a green against code that will not ship (the densest
  // multi-dev scar: a parallel push moved the base mid-build, or the checkout was behind).
  const freshMode = verify.require_fresh_base || "warn";
  if (gateOn(gates, "G8") && freshMode !== "off") {
    const anc = git(repo, `merge-base --is-ancestor ${base} ${head}`);
    if (!anc.ok && anc.code === 1) {
      const behind = git(repo, `rev-list --count ${head}..${base}`).out.trim() || "some";
      const msg = `G8 fresh base: branch is behind its base by ${behind} commit(s) - this green was earned on a base that differs from what will merge. Rebase onto the current tip and re-run so the receipt is green on the code that ships.`;
      if (freshMode === "block") emit("BLOCK", msg);
      warn(msg);
    } else if (!anc.ok) {
      warn("G8 fresh base: could not determine base freshness (fetch base+head with fetch-depth: 0).");
    }
  }

  // G10 rollout compatibility: flag a backward-incompatible change to a contract artifact.
  checkContracts(repo, base, head, gates);

  // Inverted receipt: a refactor/chore must NOT change behavior, so the proof is the full
  // suite staying green on head - not a red->green on a new test. Don't require (or expect)
  // a carried receipt; run the suite on head instead.
  if (inverted) {
    const suiteCmd = verify.suite_command;
    if (!suiteCmd || /REPLACE_ME/.test(suiteCmd))
      emit(degrade.on_no_receipt === "warn" ? "WARN" : "BLOCK",
        `${workType}: a ${workType} changes no behavior, so its receipt is the FULL suite staying green on head - but verify.suite_command is not set. Set it so the enforcer can prove behavior is unchanged, or tag the PR honestly.`);
    const original = git(repo, "rev-parse HEAD").out.trim();
    let suite;
    try {
      if (!git(repo, `checkout -q -f ${head}`).ok) emit("BLOCK", `cannot checkout head ${head}`);
      suite = runCmd(repo, suiteCmd);
    } finally {
      git(repo, `checkout -q -f ${original}`);
    }
    if (!suite.ok)
      emit("BLOCK", `${workType}: the full suite is NOT green on head - a ${workType} must not change behavior`, (suite.out || "").split("\n").slice(-8).join("\n"));
    finish(`${workType} verified: the full suite is green on head (no behavior change) - G9`);
  }

  // The receipt = test files added/changed between base and head.
  const diff = git(repo, `diff --name-only ${base}..${head}`);
  if (!diff.ok) emit("BLOCK", `cannot diff ${base}..${head}`, diff.out);
  const tests = diff.out.split("\n").map((s) => s.trim()).filter((f) => f && TEST_PATH.test(f));

  if (!tests.length) {
    const mode = degrade.on_no_receipt || "require-downgrade-tag";
    if (mode === "warn") emit("WARN", "no receipt (no test added/changed) - allowed by config, but unverified");
    emit("BLOCK", "no receipt: this fix-claim adds no acceptance test. Add a test that FAILS before and PASSES after the fix, or tag the PR 'unverified-reasoned' / 'speculative'.");
  }

  const testCmd = verify.test_command;
  if (!testCmd || /REPLACE_ME/.test(testCmd))
    emit("BLOCK", "verify.test_command is not set in receipts.config.json (run `receipts init`)");
  const cmdFor = (files) => testCmd.replace("{test}", files.map((f) => `"${f}"`).join(" "));

  const suiteCmd = verify.suite_command;
  const haveSuite = suiteCmd && !/REPLACE_ME/.test(suiteCmd);

  const original = git(repo, "rev-parse HEAD").out.trim();
  let red, green, suite;
  try {
    // RED: base source, with head's receipt test(s) overlaid on top.
    if (!git(repo, `checkout -q -f ${base}`).ok) emit("BLOCK", `cannot checkout base ${base}`);
    git(repo, `checkout -q ${head} -- ${tests.map((f) => `"${f}"`).join(" ")}`);
    red = runCmd(repo, cmdFor(tests)); // expect FAIL = reproduces the bug
    // GREEN: full head (force-discards the overlay).
    git(repo, `checkout -q -f ${head}`);
    green = runCmd(repo, cmdFor(tests)); // expect PASS = bug gone
    // G9 full-scope green: run the WHOLE suite on head, not only the changed test.
    if (green.ok && haveSuite && gateOn(gates, "G9")) suite = runCmd(repo, suiteCmd);
  } finally {
    git(repo, `checkout -q -f ${original}`);
  }

  if (red.ok)
    warn("weak receipt: the test PASSES on the base commit, so it does not prove it reproduced the reported symptom. Make the test assert the actual symptom (G0/G1).");
  if (!green.ok)
    emit("BLOCK", "the fix does not pass its own receipt test on head", (green.out || "").split("\n").slice(-8).join("\n"));
  if (haveSuite && suite && !suite.ok)
    emit("BLOCK", "G9 full-scope green: the fix passes its own receipt but BREAKS the full suite - a regression in code the changed test never exercised. Fix it, or carry a downgrade tag.", (suite.out || "").split("\n").slice(-8).join("\n"));
  if (gateOn(gates, "G9") && !haveSuite)
    warn("G9 full-scope green not checked: set verify.suite_command so the enforcer runs the full suite on head (the regression is often outside the changed test).");
  finish("receipt verified: red on base, green on fix - the symptom is reproduced and now gone");
}

try { main(); }
catch (e) { console.error("receipts enforcer error: " + (e && e.message ? e.message : e)); process.exit(1); }
