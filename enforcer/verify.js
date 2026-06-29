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
 * Trust posture (the enforcer must not be controllable by the PR it checks):
 *  - config is read from the BASE commit, not the PR head, so a PR cannot edit its own
 *    receipts.config.json to neuter the gate (it falls back to head only on first setup,
 *    with a loud warning);
 *  - all git invocations go through execFileSync with an argv array (no shell), so a
 *    crafted filename cannot inject a command; the only shell string is the project's own
 *    test/suite command, and the file list interpolated into it is metacharacter-checked;
 *  - a test/suite command that can mask its own exit code (a trailing ; , || , or pipe) is
 *    rejected (G9): a green from a masked command cannot be trusted.
 *
 * Also: G8 fresh base, G9 full-scope green, G10 contract back-compat, and a work-type
 * inversion (a refactor/chore proves itself with the full suite, not a red->green) - but a
 * fix-claim (closes #N) cannot self-declare `work-type: refactor` to skip the receipt.
 *
 * Usage:
 *   node verify.js --base <sha> --head <sha> [--repo <dir>] [--config <path>]
 *                  [--pr-body <text> | --pr-body-file <path>] [--json]
 * Exit: 0 for PASS/WARN, 1 for BLOCK.
 */
const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TEST_PATH = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|\/__tests__\/|_spec\.)/i;
// JSON keys that are documentation, not contract surface - removing them is not breaking.
const DOC_KEYS = new Set(["description", "summary", "title", "example", "examples", "comment", "$comment", "externalDocs", "deprecated"]);
// A path with any of these would break out of the (shell) test command we interpolate it into.
const UNSAFE_PATH = /["'`$;|&()<>\n\r\\]/;
// A base run that "failed" to LOAD rather than to ASSERT - a red that may not prove the symptom.
const LOAD_ERROR = /cannot find module|module ?not ?found|cannot import|importerror|modulenotfounderror|syntaxerror|no tests? (found|ran|collected)|collected 0 items|0 tests? found/i;

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

// git via execFileSync with an argv ARRAY - no shell, so shas/filenames are never
// interpreted (closes the crafted-filename injection class).
function git(repo, args) {
  try { return { ok: true, out: execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status }; }
}

// The project's own test/suite command - necessarily a shell string. Callers gate the
// interpolated file list with UNSAFE_PATH first, and masksExit() rejects exit-masking.
function runCmd(repo, cmd) {
  try { execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return { ok: true, out: "" }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status }; }
}

// Best-effort lint against ACCIDENTAL exit-masking (the `npm test ; echo` footgun): a `;`
// (sequencing), `||` (or-true), a single `|` (last pipe stage wins), a background `&`, a
// newline (sequencing), a backtick or `$(` (command substitution that can swallow the exit).
// `&&` is fine - it propagates failure. NOT exhaustive: a determined config author can always
// write a command that exits 0 (the threat model - receipts cannot make a branch's own tests
// unsubvertible; see spec/GATES.md "What the Gates do NOT defend against").
function masksExit(cmd) {
  const c = String(cmd || "");
  return /;/.test(c) || /\|\|/.test(c) || /\|/.test(c.replace(/\|\|/g, "")) ||
    /&/.test(c.replace(/&&/g, "")) || /[\n\r]/.test(c) || /`/.test(c) || /\$\(/.test(c);
}

function emit(verdict, reason, detail) {
  const warns = WARNINGS.length ? "\n  warnings:\n  - " + WARNINGS.join("\n  - ") : "";
  if (ARGS.json) console.log(JSON.stringify({ verdict, reason, detail: detail || null, warnings: WARNINGS }));
  else console.log(`receipts: ${verdict} - ${reason}` + (detail ? `\n  ${String(detail).trim()}` : "") + warns);
  process.exit(verdict === "BLOCK" ? 1 : 0);
}

function warn(reason) { WARNINGS.push(reason); }
function finish(reason) { emit(WARNINGS.length ? "WARN" : "PASS", reason); }

function gateOn(gates, id) {
  if (!gates) return true;
  if ((gates.disabled || []).includes(id)) return false;
  const en = gates.enabled;
  if (!en || en === "all") return true;
  return Array.isArray(en) ? en.includes(id) : true;
}

// --- G10 rollout compatibility: a generic, zero-dep backward-compat check on changed
// contract artifacts. JSON contracts get a structural breaking-diff (removed field/path,
// removed enum value, newly-required field, narrowed type, nullable->non-null, removed
// contract file); other formats get a "changed - verify manually" warning. Default WARN;
// gates.G10.mode -> block. This is a HEURISTIC for common object-shape breaks, NOT a complete
// contract differ - deep array / oneOf / anyOf and full OpenAPI semantics are not covered;
// pair with a dedicated tool (e.g. oasdiff) where full coverage matters. ---
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
function typeSet(t) { return new Set([].concat(t).filter((x) => typeof x === "string")); }
const PROP_MAPS = new Set(["properties", "definitions", "$defs", "patternProperties"]);
// inProps = the keys of `a` are field NAMES (a properties/definitions map), not schema
// keywords - so doc-key exclusion and the keyword checks must NOT apply at this level
// (a field literally named "description" or "type" is real contract surface).
function walkBreaks(p, a, b, out, depth, inProps) {
  if (depth > 30 || out.length > 60) return;
  if (Array.isArray(a)) {
    if (/enum$/i.test(p) && Array.isArray(b))
      for (const v of a) if (typeof v !== "object" && !b.includes(v)) out.push(`removed enum value ${JSON.stringify(v)} at ${p}`);
    return;
  }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object" || Array.isArray(b)) { out.push(`removed or retyped object at ${p || "(root)"}`); return; }
    if (!inProps) {
      // A newly-required field is breaking (old callers do not send it). Missing base.required = [].
      if (Array.isArray(b.required)) {
        const baseReq = Array.isArray(a.required) ? a.required : [];
        for (const r of b.required) if (!baseReq.includes(r)) out.push(`added required field "${r}" at ${p || "(root)"}`);
      }
      // nullable: true -> false (OpenAPI 3.0 boolean form) is a narrowing.
      if (a.nullable === true && b.nullable === false) out.push(`nullable removed (now non-null) at ${p || "(root)"}`);
    }
    for (const k of Object.keys(a)) {
      if (DOC_KEYS.has(k) && !inProps) continue; // a doc keyword, not a field literally named so
      const cp = p ? p + "." + k : k;
      if (!(k in b)) { out.push(`removed "${cp}"`); continue; }
      if (k === "type" && !inProps) { // narrowing, handling both "string" and ["string","null"]
        const at = typeSet(a[k]), bt = typeSet(b[k]);
        if (at.size && bt.size) for (const t of at) if (!bt.has(t)) out.push(`type narrowed at ${p || "(root)"}: removed "${t}"`);
      }
      walkBreaks(cp, a[k], b[k], out, (depth || 0) + 1, PROP_MAPS.has(k));
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
  const changed = git(repo, ["diff", "--name-only", `${base}..${head}`]).out.split("\n").map((s) => s.trim()).filter(Boolean);
  const files = changed.filter((f) => isContractFile(f, g10.contract_paths));
  if (!files.length) return;
  const breaks = [], unparseable = [];
  for (const f of files) {
    const bs = git(repo, ["show", `${base}:${f}`]), hs = git(repo, ["show", `${head}:${f}`]);
    if (!bs.ok) continue; // added file - nothing consumed the old version
    if (!hs.ok) { breaks.push(`${f}: contract file REMOVED (a consumer of it breaks)`); continue; }
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
  const { base, head } = ARGS;
  if (!base || !head) emit("BLOCK", "usage: --base <sha> --head <sha>");
  const prBody = ARGS["pr-body-file"] ? fs.readFileSync(ARGS["pr-body-file"], "utf8") : (ARGS["pr-body"] || "");
  // A body ARG was supplied (even if empty) - distinct from "no body to check". An empty
  // body with no issue link is "not a fix-claim", not a missing receipt.
  const bodyProvided = ARGS["pr-body-file"] !== undefined || ARGS["pr-body"] !== undefined;

  // Config from the BASE commit (trusted), NOT the PR head - else a PR can edit its own
  // receipts.config.json to disable the gate. An explicit --config path is local/trusted.
  let cfgRaw, configFromHead = false;
  if (ARGS.config) {
    try { cfgRaw = fs.readFileSync(ARGS.config, "utf8"); } catch { emit("BLOCK", `cannot read --config ${ARGS.config}`); }
  } else {
    const fromBase = git(repo, ["show", `${base}:receipts.config.json`]);
    if (fromBase.ok) cfgRaw = fromBase.out;
    else {
      try { cfgRaw = fs.readFileSync(path.join(repo, "receipts.config.json"), "utf8"); configFromHead = true; }
      catch { emit("BLOCK", "no receipts.config.json on the base commit (run `receipts init` and merge it via a trusted PR first)"); }
    }
  }
  let cfg;
  try { cfg = JSON.parse(cfgRaw); } catch { emit("BLOCK", "receipts.config.json is not valid JSON"); }
  if (configFromHead) {
    warn("config read from the PR head, not the base (receipts.config.json is not on base yet) - once it is merged via a trusted PR, the enforcer reads it from base.");
    // On first setup the PR controls its own config, so do NOT honor head's gate-RELAXING
    // fields - force the strict defaults for the security-relevant ones (issue_link /
    // downgrade tags / on_no_receipt / gate-enablement). Keep verify (the plumbing needed to
    // run the tests at all; masksExit still guards it).
    cfg.claim = {}; cfg.degrade = {}; cfg.gates = {};
  }

  const claim = cfg.claim || {};
  const degrade = cfg.degrade || {};
  const verify = cfg.verify || {};
  const gates = cfg.gates || {};
  const noReceiptMode = degrade.on_no_receipt || "require-downgrade-tag";

  const issueRe = new RegExp(claim.issue_link || "closes #(\\d+)", "i");
  const isFixClaim = issueRe.test(prBody);
  // Work type (per-PR): a `work-type:` line in the PR body, else gates.work_type. A
  // refactor/chore inverts the receipt - BUT a fix-claim (closes #N) is a fix, not a
  // refactor, so it cannot self-declare its way out of carrying a real red->green receipt.
  const workType = ((prBody.match(/work[ _-]?type\s*[:=]\s*([a-z]+)/i) || [])[1] || gates.work_type || "").toLowerCase();
  const inverted = (workType === "refactor" || workType === "chore") && !isFixClaim;

  // Not a fix-claim and no work-type -> nothing to re-verify.
  if (bodyProvided && !isFixClaim && !workType) emit("PASS", "not a fix-claim (no issue link) - nothing to re-verify");

  // Honest downgrade -> tracked, not blocked (the honesty ladder).
  const tags = claim.downgrade_tags || ["unverified-reasoned", "speculative", "reverted"];
  const dg = tags.find((t) => new RegExp(t.replace(/-/g, "[- ]?"), "i").test(prBody));
  if (dg) emit("PASS", `honest downgrade '${dg}' present - tracked, not claimed as verified`);

  if (git(repo, ["status", "--porcelain"]).out.trim())
    emit("BLOCK", "working tree not clean (the enforcer needs a clean checkout)");

  // G8 fresh base: is the branch built on the current base tip, or behind it?
  const freshMode = verify.require_fresh_base || "warn";
  if (gateOn(gates, "G8") && freshMode !== "off") {
    const anc = git(repo, ["merge-base", "--is-ancestor", base, head]);
    if (!anc.ok && anc.code === 1) {
      const behind = git(repo, ["rev-list", "--count", `${head}..${base}`]).out.trim() || "some";
      const msg = `G8 fresh base: branch is behind its base by ${behind} commit(s) - this green was earned on a base that differs from what will merge. Rebase onto the current tip and re-run.`;
      if (freshMode === "block") emit("BLOCK", msg);
      warn(msg);
    } else if (!anc.ok) {
      warn("G8 fresh base: could not determine base freshness (fetch base+head with fetch-depth: 0).");
    }
  }

  // G10 rollout compatibility.
  checkContracts(repo, base, head, gates);

  const diff = git(repo, ["diff", "--name-only", `${base}..${head}`]);
  if (!diff.ok) emit("BLOCK", `cannot diff ${base}..${head}`, diff.out);
  const changed = diff.out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (changed.includes("receipts.config.json"))
    warn("this PR changes receipts.config.json - the enforcer ran with the BASE config (the change takes effect after merge); review the config change.");

  // G9 unmasked: a command that can hide its own exit code cannot be trusted - but only
  // check a command that will actually RUN (test_command on the normal receipt path; suite
  // on the inverted path or when G9 is enabled), so a disabled/unused command is not a false block.
  const testCmd = verify.test_command;
  if (!inverted && testCmd && masksExit(testCmd))
    emit("BLOCK", "verify.test_command can mask its own exit code (; , || , pipe, background &, newline, or command substitution), so a green from it cannot be trusted (G9). Use a single command whose own exit is the test result, or wrap it in a script.");
  if ((inverted || gateOn(gates, "G9")) && verify.suite_command && masksExit(verify.suite_command))
    emit("BLOCK", "verify.suite_command can mask its own exit code - a green cannot be trusted (G9). Use a clean command or a script.");

  // Inverted receipt: a refactor/chore changes no behavior, so the proof is the full suite
  // staying green on head - not a red->green on a new test.
  if (inverted) {
    const suiteCmd = verify.suite_command;
    if (!suiteCmd || /REPLACE_ME/.test(suiteCmd))
      emit(noReceiptMode === "warn" ? "WARN" : "BLOCK",
        `${workType}: a ${workType} changes no behavior, so its receipt is the FULL suite staying green on head - but verify.suite_command is not set. Set it, or tag the PR honestly.`);
    const original = git(repo, ["rev-parse", "HEAD"]).out.trim();
    let suite;
    try {
      if (!git(repo, ["checkout", "-q", "-f", head]).ok) emit("BLOCK", `cannot checkout head ${head}`);
      suite = runCmd(repo, suiteCmd);
    } finally {
      git(repo, ["checkout", "-q", "-f", original]);
    }
    if (!suite.ok)
      emit("BLOCK", `${workType}: the full suite is NOT green on head - a ${workType} must not change behavior`, (suite.out || "").split("\n").slice(-8).join("\n"));
    finish(`${workType} verified: the full suite is green on head (no behavior change) - G9`);
  }

  // The receipt = test files added/changed between base and head.
  const tests = changed.filter((f) => TEST_PATH.test(f));
  if (!tests.length) {
    if (noReceiptMode === "warn") emit("WARN", "no receipt (no test added/changed) - allowed by config, but unverified");
    emit("BLOCK", "no receipt: this fix-claim adds no acceptance test. Add a test that FAILS before and PASSES after the fix, or tag the PR 'unverified-reasoned' / 'speculative'. (A behavior-preserving change: tag it `work-type: refactor`.)");
  }
  // Path safety: these get interpolated into the shell test command (shell metacharacters)
  // and passed as test-runner args / git pathspecs (a leading "-" reads as a flag, a leading
  // ":" as git pathspec magic). Refuse rather than run.
  const unsafe = tests.filter((f) => UNSAFE_PATH.test(f) || /^[-:]/.test(f));
  if (unsafe.length)
    emit("BLOCK", `refusing to run: changed test path(s) are unsafe (shell metacharacters, or a leading - / : a test runner or git pathspec could misread): ${unsafe.join(", ")}`);

  if (!testCmd || /REPLACE_ME/.test(testCmd))
    emit("BLOCK", "verify.test_command is not set in receipts.config.json (run `receipts init`)");
  const cmdFor = (files) => testCmd.replace("{test}", files.map((f) => `"${f}"`).join(" "));

  const suiteCmd = verify.suite_command;
  const haveSuite = suiteCmd && !/REPLACE_ME/.test(suiteCmd);

  const original = git(repo, ["rev-parse", "HEAD"]).out.trim();
  let red, green, suite;
  try {
    // RED: base source, with head's receipt test(s) overlaid on top.
    if (!git(repo, ["checkout", "-q", "-f", base]).ok) emit("BLOCK", `cannot checkout base ${base}`);
    git(repo, ["checkout", "-q", head, "--", ...tests]);
    red = runCmd(repo, cmdFor(tests)); // expect FAIL = reproduces the bug
    // GREEN: full head.
    git(repo, ["checkout", "-q", "-f", head]);
    green = runCmd(repo, cmdFor(tests)); // expect PASS = bug gone
    if (green.ok && haveSuite && gateOn(gates, "G9")) suite = runCmd(repo, suiteCmd);
  } finally {
    git(repo, ["checkout", "-q", "-f", original]);
  }

  if (red.ok)
    // A test that passes on base did not reproduce the symptom - for a fix-claim that is an
    // unproven receipt, not a clean pass. (A behavior-preserving change uses work-type.)
    emit(noReceiptMode === "warn" ? "WARN" : "BLOCK",
      "weak receipt: the test PASSES on the base commit, so it does not prove it reproduced the reported symptom (G0/G1). Make the test assert the actual symptom, tag the PR honestly, or - if no behavior changes - mark it `work-type: refactor`.");
  if (LOAD_ERROR.test(red.out || ""))
    warn("the base run looks like a LOAD / collection error (import / syntax / no-tests), not an assertion failure - the red may not prove the symptom; confirm the test fails on the bug, not on setup.");
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
