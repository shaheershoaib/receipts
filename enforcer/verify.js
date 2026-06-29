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
// Not production source: docs, license/changelog, CI workflows, the receipts config itself,
// VCS meta. Used by the "any-source-change" strict trigger to decide whether a non-fix-claim
// PR touched anything that needs a receipt. (Test files are excluded separately via TEST_PATH.)
const DOC_OR_META = /(^|\/)(LICENSE|CHANGELOG)|\.(md|markdown|txt|rst|adoc)$|(^|\/)\.github\/|(^|\/)receipts\.config\.json$|(^|\/)\.gitignore$/i;

let ARGS = {};
const WARNINGS = [];
// 64 MiB: a chatty-but-honest suite can print well past Node's 1 MiB execSync default, and
// blowing the buffer used to surface as ENOBUFS -> a FALSE failure (a green misread as red).
const CMD_MAXBUF = 64 * 1024 * 1024;

// The replayable receipt: machine-readable evidence of what the enforcer re-ran and saw, so a
// verdict is auditable and re-runnable rather than a bare PASS/BLOCK. Accumulated through
// main() and written to --receipt-out (if given) by emit(), regardless of verdict.
const RECEIPT = { schema: "receipts/receipt@1", commands: [], gates: {} };

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (["base", "head", "config", "repo", "pr-body", "pr-body-file", "receipt-out"].includes(k)) o[k] = argv[++i];
      else o[k] = true;
    } else o._.push(a);
  }
  return o;
}

// Last `n` lines of output, for the receipt (full logs can be huge; the tail is what shows
// why a command passed or failed).
function tail(s, n) { return String(s || "").split("\n").slice(-(n || 20)).join("\n"); }

// git via execFileSync with an argv ARRAY - no shell, so shas/filenames are never
// interpreted (closes the crafted-filename injection class).
function git(repo, args) {
  try { return { ok: true, out: execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: CMD_MAXBUF }) }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status }; }
}

// The project's own test/suite command - necessarily a shell string. Callers gate the
// interpolated file list with UNSAFE_PATH first, and masksExit() rejects exit-masking. The
// optional timeout (verify.command_timeout_ms) guards a hung test; default none preserves
// prior behavior. Captures stdout+stderr and duration for the receipt.
function runCmd(repo, cmd, timeoutMs) {
  const t0 = Date.now();
  const opts = { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: CMD_MAXBUF };
  if (timeoutMs && timeoutMs > 0) opts.timeout = timeoutMs;
  try {
    const out = execSync(cmd, opts);
    return { ok: true, out: out || "", ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status, ms: Date.now() - t0, timedOut: e.killed === true || e.signal === "SIGTERM" };
  }
}

// Record one executed command into the receipt (label + the command string + how it exited).
function record(label, cmd, res) {
  RECEIPT.commands.push({
    label, command: cmd, ok: !!res.ok,
    exit_code: res.ok ? 0 : (typeof res.code === "number" ? res.code : null),
    duration_ms: res.ms != null ? res.ms : null,
    timed_out: res.timedOut || false,
    output_tail: tail(res.out, 20),
  });
}

// Write the receipt artifact. Side-effect only - a write failure must never change the
// verdict or the exit code (best-effort, swallow the error after a stderr note).
function writeReceipt(verdict, reason, detail) {
  RECEIPT.verdict = verdict;
  RECEIPT.reason = reason;
  RECEIPT.detail = detail || null;
  RECEIPT.warnings = WARNINGS.slice();
  RECEIPT.generated_at = new Date().toISOString();
  try { fs.writeFileSync(ARGS["receipt-out"], JSON.stringify(RECEIPT, null, 2) + "\n"); }
  catch (e) { process.stderr.write("receipts: could not write receipt to " + ARGS["receipt-out"] + " - " + (e && e.message) + "\n"); }
}

// Best-effort lint against ACCIDENTAL exit-masking (the `npm test ; echo` footgun): a `;`
// (sequencing), `||` (or-true), a single `|` (last pipe stage wins), a background `&`, a
// newline (sequencing), a backtick or `$(` (command substitution that can swallow the exit).
// `&&` propagates failure and shell redirections (2>&1, >&2, &>file) preserve the exit - both
// are fine, so they are stripped first. NOT exhaustive: a determined config author can always
// write a command that exits 0 (the threat model - receipts cannot make a branch's own tests
// unsubvertible; see spec/GATES.md "What the Gates do NOT defend against").
function masksExit(cmd) {
  const s = String(cmd || "").replace(/&&/g, " ").replace(/[0-9]*>&[0-9]*/g, " ").replace(/&>>?/g, " ");
  return /;/.test(s) || /\|\|/.test(s) || /\|/.test(s.replace(/\|\|/g, "")) ||
    /&/.test(s) || /[\n\r]/.test(s) || /`/.test(s) || /\$\(/.test(s);
}

function emit(verdict, reason, detail) {
  if (ARGS["receipt-out"]) writeReceipt(verdict, reason, detail);
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
  // Optional per-command timeout (ms) for the test/suite commands; 0 / unset = no timeout
  // (preserves prior behavior). Guards a hung test from hanging the whole job.
  const cmdTimeout = Number(verify.command_timeout_ms) || 0;
  // Trigger scope. Default ("issue-link"): only a fix-claim (closes #N) must carry a receipt.
  // Opt-in ("any-source-change"): a PR that touches production source without a receipt, an
  // honest downgrade tag, or an explicit work-type is also blocked - closing the "omit the
  // issue link -> silent green" bypass. Default preserves prior behavior for existing users.
  const strict = (claim.require_receipt_for || "issue-link") === "any-source-change";

  const issueRe = new RegExp(claim.issue_link || "closes #(\\d+)", "i");
  const isFixClaim = issueRe.test(prBody);
  // Work type (per-PR): a `work-type:` line in the PR body, else gates.work_type. A
  // refactor/chore inverts the receipt - BUT a fix-claim (closes #N) is a fix, not a
  // refactor, so it cannot self-declare its way out of carrying a real red->green receipt.
  const workType = ((prBody.match(/work[ _-]?type\s*[:=]\s*([a-z]+)/i) || [])[1] || gates.work_type || "").toLowerCase();
  const inverted = (workType === "refactor" || workType === "chore") && !isFixClaim;

  // Receipt metadata (the evidence header). The per-command results are recorded as they run.
  Object.assign(RECEIPT, {
    repo, base, head,
    config_source: ARGS.config ? "explicit" : (configFromHead ? "head" : "base"),
    strict, work_type: workType || null, is_fix_claim: isFixClaim,
  });
  RECEIPT.gates = { enabled: gates.enabled || "all", disabled: gates.disabled || [] };

  // Not a fix-claim and no work-type -> nothing to re-verify (default trigger). Under the
  // strict trigger we do NOT bail here: control falls through to the source-change check
  // below (after the diff is computed), so an unclaimed code change still needs a receipt.
  if (bodyProvided && !isFixClaim && !workType && !strict) emit("PASS", "not a fix-claim (no issue link) - nothing to re-verify");

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

  // Strict trigger: a non-fix-claim with no work-type only reaches here when
  // require_receipt_for is "any-source-change". If it touched no PRODUCTION source (docs /
  // tests / CI / config only) there is nothing to re-verify; otherwise it falls through and
  // must carry a receipt below, exactly like a fix-claim.
  if (strict && bodyProvided && !isFixClaim && !workType) {
    const changedSource = changed.filter((f) => !DOC_OR_META.test(f) && !TEST_PATH.test(f));
    if (!changedSource.length)
      emit("PASS", "no production source changed (docs / tests / config only) - nothing to re-verify");
  }

  // G9 unmasked: a command that can hide its own exit code cannot be trusted. Checked at the
  // point each command actually RUNS (below), so a command that will NOT run - a masked
  // test_command on an inverted or no-receipt path, or a suite_command with G9 off - is never
  // a false block.
  const testCmd = verify.test_command;

  // Inverted receipt: a refactor/chore changes no behavior, so the proof is the full suite
  // staying green on head - not a red->green on a new test.
  if (inverted) {
    const suiteCmd = verify.suite_command;
    if (!suiteCmd || /REPLACE_ME/.test(suiteCmd))
      emit(noReceiptMode === "warn" ? "WARN" : "BLOCK",
        `${workType}: a ${workType} changes no behavior, so its receipt is the FULL suite staying green on head - but verify.suite_command is not set. Set it, or tag the PR honestly.`);
    if (masksExit(suiteCmd))
      emit("BLOCK", "verify.suite_command can mask its own exit code - a green cannot be trusted (G9). Use a clean command or a script.");
    RECEIPT.gates.work_type_inverted = workType;
    const original = git(repo, ["rev-parse", "HEAD"]).out.trim();
    let suite;
    try {
      if (!git(repo, ["checkout", "-q", "-f", head]).ok) emit("BLOCK", `cannot checkout head ${head}`);
      suite = runCmd(repo, suiteCmd, cmdTimeout);
      record(`${workType}-suite@head`, suiteCmd, suite);
    } finally {
      git(repo, ["checkout", "-q", "-f", original]);
    }
    if (!suite.ok)
      emit("BLOCK", `${workType}: the full suite is NOT green on head - a ${workType} must not change behavior`, (suite.out || "").split("\n").slice(-8).join("\n"));
    finish(`${workType} verified: the full suite is green on head (no behavior change) - G9`);
  }

  // The receipt = test files added/changed between base and head.
  const tests = changed.filter((f) => TEST_PATH.test(f));
  RECEIPT.tests = tests;
  if (!tests.length) {
    if (noReceiptMode === "warn") emit("WARN", "no receipt (no test added/changed) - allowed by config, but unverified");
    emit("BLOCK", "no receipt: this change adds no acceptance test. Add a test that FAILS before and PASSES after the change, or tag the PR 'unverified-reasoned' / 'speculative'. (A behavior-preserving change: tag it `work-type: refactor`.)");
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
  // Mask-check only the commands that will now run: the receipt always, the suite if G9 is on.
  if (masksExit(testCmd))
    emit("BLOCK", "verify.test_command can mask its own exit code (; , || , pipe, background &, newline, or command substitution), so a green from it cannot be trusted (G9). Use a single command whose own exit is the test result, or wrap it in a script.");
  if (haveSuite && gateOn(gates, "G9") && masksExit(suiteCmd))
    emit("BLOCK", "verify.suite_command can mask its own exit code - a green cannot be trusted (G9). Use a clean command or a script.");

  const original = git(repo, ["rev-parse", "HEAD"]).out.trim();
  let red, green, suite;
  try {
    // RED: base source, with head's receipt test(s) overlaid on top.
    if (!git(repo, ["checkout", "-q", "-f", base]).ok) emit("BLOCK", `cannot checkout base ${base}`);
    git(repo, ["checkout", "-q", head, "--", ...tests]);
    red = runCmd(repo, cmdFor(tests), cmdTimeout); // expect FAIL = reproduces the bug
    record("receipt-red@base", cmdFor(tests), red);
    RECEIPT.red = !red.ok; // red = the receipt reproduced the symptom on base (it FAILED there)
    // GREEN: full head.
    git(repo, ["checkout", "-q", "-f", head]);
    green = runCmd(repo, cmdFor(tests), cmdTimeout); // expect PASS = bug gone
    record("receipt-green@head", cmdFor(tests), green);
    RECEIPT.green = green.ok; // green = the symptom is gone on head (it PASSED there)
    if (green.ok && haveSuite && gateOn(gates, "G9")) { suite = runCmd(repo, suiteCmd, cmdTimeout); record("suite@head", suiteCmd, suite); }
  } finally {
    git(repo, ["checkout", "-q", "-f", original]);
  }

  if (red.ok)
    // A test that passes on base did not reproduce the symptom - for a fix-claim that is an
    // unproven receipt, not a clean pass. (A behavior-preserving change uses work-type.)
    emit(noReceiptMode === "warn" ? "WARN" : "BLOCK",
      "weak receipt: the test PASSES on the base commit, so it does not prove it reproduced the reported symptom (G0/G1). Make the test assert the actual symptom, tag the PR honestly, or - if no behavior changes - mark it `work-type: refactor`.");
  if (LOAD_ERROR.test(red.out || "")) {
    // The base run FAILED, but as a load/collection error (import / syntax / no-tests-found),
    // not an assertion. That red may not prove the symptom: the test could be red on base
    // merely because it imports code that only exists on head (common and LEGITIMATE for a
    // feature - the behavior is absent until built - but suspicious for a fix, where the code
    // already exists and the symptom should reproduce by assertion). Default: warn. A repo
    // that wants fixes to carry an asserting red sets verify.on_load_error_red: "block".
    const loadMode = verify.on_load_error_red || "warn";
    const msg =
      "weak receipt: the test FAILED on the base commit as a LOAD / collection error (import / " +
      "syntax / no-tests), not an assertion - so this red may not prove it reproduced the symptom " +
      "(it can be red merely because it imports code that only exists on head). For a fix, make " +
      "the test importable on base and assert the actual symptom; for a feature, that red is " +
      "expected - mark the PR `work-type: feature`. ";
    if (loadMode === "block" && workType !== "feature") emit("BLOCK", msg);
    warn(msg);
  }
  if (!green.ok)
    emit("BLOCK", "the fix does not pass its own receipt test on head", (green.out || "").split("\n").slice(-8).join("\n"));
  if (haveSuite && suite && !suite.ok)
    emit("BLOCK", "G9 full-scope green: the fix passes its own receipt but BREAKS the full suite - a regression in code the changed test never exercised. Fix it, or carry a downgrade tag.", (suite.out || "").split("\n").slice(-8).join("\n"));
  if (gateOn(gates, "G9") && !haveSuite)
    warn("G9 full-scope green not checked: set verify.suite_command so the enforcer runs the full suite on head (the regression is often outside the changed test).");
  finish("receipt verified: red on base, green on fix - the symptom is reproduced and now gone");
}

// Run only when invoked as a script. When this file is `require`d (the enforcer's own
// test suite - Phase 0 self-verification), main() must NOT run; only the pure,
// side-effect-free helpers below are exported for direct unit testing.
if (require.main === module) {
  try { main(); }
  catch (e) { console.error("receipts enforcer error: " + (e && e.message ? e.message : e)); process.exit(1); }
}

module.exports = { masksExit, gateOn, globToRe, isContractFile, typeSet, walkBreaks, contractBreaks };
