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
const g7 = require("./g7.js");
const g6 = require("./g6.js");
const g11 = require("./g11.js");
const g12 = require("./g12.js");
const g13 = require("./g13.js");

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

// Substitute the changed-test set into the project's test command. Three placeholder
// forms, because runners SELECT differently: {test} = the file path(s), quoted - jest /
// pytest / rspec / mix take paths; {test_dirs} = the unique "./dir"s of those files -
// `go test` selects by package, not file; {test_classes} = the basenames sans extension,
// comma-joined - Maven surefire's -Dtest= takes class names. A file path fed to a
// name-selector (-run / -Dtest= / --filter) matches NOTHING and exits 0: a "red" phase
// that ran no test at all, misread as a weak receipt (or worse, trusted as green).
function expandTestPlaceholders(cmd, files) {
  const dirs = [...new Set(files.map((f) => {
    const d = path.posix.dirname(f);
    return d === "." ? "./" : "./" + d;
  }))];
  const classes = [...new Set(files.map((f) => path.posix.basename(f).replace(/\.[^.]+$/, "")))];
  return String(cmd || "")
    .split("{test}").join(files.map((f) => `"${f}"`).join(" "))
    .split("{test_dirs}").join(dirs.map((d) => `"${d}"`).join(" "))
    .split("{test_classes}").join(classes.join(","));
}

// Monorepo grouping: each receipt test runs with the test_command of the NEAREST
// receipts.config.json above it (nested configs are read from the trusted BASE commit,
// same posture as the root config, and contribute ONLY their verify block - the policy
// surface (claim / degrade / gates) stays root-only: one gate, many test runners).
// Returns [{ dir, verify, tests }] with tests RELATIVE to dir (commands run with cwd=dir).
function groupTestsByPackage(tests, pkgVerify, rootVerify) {
  const dirs = [...(pkgVerify || new Map()).keys()].sort((a, b) => b.length - a.length); // deepest first
  const groups = new Map(); // "" = the root group
  for (const t of tests || []) {
    const dir = dirs.find((d) => t.startsWith(d + "/")) || "";
    if (!groups.has(dir)) groups.set(dir, { dir, verify: (dir ? pkgVerify.get(dir) : rootVerify) || {}, tests: [] });
    groups.get(dir).tests.push(dir ? t.slice(dir.length + 1) : t);
  }
  return [...groups.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

// What to restore after the base/head checkout dance: the BRANCH when on one, else the
// sha. Restoring the sha alone leaves a local `receipts verify` run on a detached HEAD -
// the user's next commit then silently misses their branch (found the hard way: an amend
// after a local verify left a PR pointing at the pre-amend commit).
function originalRef(repo) {
  const branch = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return branch.ok && branch.out.trim() ? branch.out.trim() : git(repo, ["rev-parse", "HEAD"]).out.trim();
}

// Per-command timeout resolution: DEFAULT 20 minutes - a hung test must not hold the CI
// job to its own multi-hour ceiling. An explicit 0 opts out (the job's timeout still
// applies); any positive number is honored as-is.
function resolveTimeout(verify) {
  if (verify && verify.command_timeout_ms === 0) return 0;
  const n = Number(verify && verify.command_timeout_ms);
  return n > 0 ? n : 1200000;
}

// Schema-lite key validation. The repo ships a real JSON schema, but validating against
// it would need a dependency - so this mirrors just the KEY SETS. A typo'd key ("gatez",
// "test_comand") silently meaning "default behavior" is exactly the quiet
// misconfiguration a verification tool must not allow. Unknown keys WARN, never block
// (forward-compat: an older enforcer meeting a newer config keeps working, loudly).
const KNOWN_KEYS = {
  "": ["$schema", "version", "claim", "build", "verify", "degrade", "gates", "agent"],
  claim: ["issue_link", "require_receipt_for", "downgrade_tags"],
  build: ["sha_source", "platform", "deploy_host_patterns", "environments", "verify_against"],
  verify: ["test_command", "suite_command", "require_fresh_base", "on_load_error_red", "command_timeout_ms", "receipt_runs", "live_drive"],
  degrade: ["on_no_receipt", "on_unreachable_build"],
  gates: ["medium", "work_type", "enabled", "disabled", "G6", "G7", "G8", "G10", "G11", "G12", "G13"],
  "gates.G6": ["mode", "auto", "surfaces"],
  "gates.G7": ["mode", "graph", "verify_all_dependents"],
  "gates.G8": ["integration_branch"],
  "gates.G10": ["contract_paths", "mode", "contract_pairs"],
  "gates.G11": ["mode"],
  "gates.G12": ["mode"],
  "gates.G13": ["coverage_command", "lcov_path", "mode"],
  agent: ["loop_skills", "staging_query_patterns", "closeout_fixed_statuses", "repo_name", "trajectory_store"],
};
function unknownConfigKeys(cfg) {
  const out = [];
  const walk = (obj, prefix) => {
    const known = KNOWN_KEYS[prefix];
    if (!known || !obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const k of Object.keys(obj)) {
      if (!known.includes(k)) { out.push(prefix ? `${prefix}.${k}` : k); continue; }
      const next = prefix ? `${prefix}.${k}` : k;
      if (KNOWN_KEYS[next]) walk(obj[k], next);
    }
  };
  walk(cfg, "");
  return out;
}

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

  // A typo'd key silently becoming default behavior is a quiet misconfiguration - warn.
  const badKeys = unknownConfigKeys(cfg);
  if (badKeys.length)
    warn(`config: unknown key(s) not read by the enforcer: ${badKeys.join(", ")} - a typo here silently becomes default behavior; check receipts.config.schema.json for the valid keys.`);

  const claim = cfg.claim || {};
  const degrade = cfg.degrade || {};
  const verify = cfg.verify || {};
  const gates = cfg.gates || {};
  const noReceiptMode = degrade.on_no_receipt || "require-downgrade-tag";
  // Per-command timeout for the test/suite commands: default 20 min (a hung test must not
  // hold the CI job to its ceiling); verify.command_timeout_ms overrides, explicit 0 disables.
  const cmdTimeout = resolveTimeout(verify);
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

  // Monorepo: discover nested receipts.config.json files at the trusted BASE commit.
  // Each contributes its verify block for the tests under its directory.
  const pkgVerify = new Map();
  for (const f of git(repo, ["ls-tree", "-r", "--name-only", base]).out.split("\n").map((s) => s.trim())) {
    if (!f.endsWith("/receipts.config.json")) continue;
    const raw = git(repo, ["show", `${base}:${f}`]);
    if (!raw.ok) continue;
    const dir = f.slice(0, -"/receipts.config.json".length);
    try {
      const c = JSON.parse(raw.out);
      if (c && c.verify) pkgVerify.set(dir, c.verify);
    } catch { warn(`monorepo: ${f} is not valid JSON - its package is treated as config-less`); }
  }
  if (pkgVerify.size) RECEIPT.packages = [...pkgVerify.keys()].sort();

  // The PR's changed files - computed early so G6 can run on EVERY PR (fix-claim or not).
  const diff = git(repo, ["diff", "--name-only", `${base}..${head}`]);
  if (!diff.ok) emit("BLOCK", `cannot diff ${base}..${head}`, diff.out);
  const changed = diff.out.split("\n").map((s) => s.trim()).filter(Boolean);
  const changedSource = changed.filter((f) => !DOC_OR_META.test(f) && !TEST_PATH.test(f));
  if (changed.includes("receipts.config.json"))
    warn("this PR changes receipts.config.json - the enforcer ran with the BASE config (the change takes effect after merge); review the config change.");

  // G6 surface coverage (the "sweep the twins" assist): a pattern applied to SOME sibling
  // surfaces but not all - the "claimed app-wide, actually partial" failure. Runs on every PR
  // with a diff (an incomplete rollout is often an unlinked feature), static over base/head -
  // no checkout, no test run. Declared families (any language) + a JS/TS heuristic.
  if (gateOn(gates, "G6")) {
    const g6cfg = (gates && gates.G6) || {};
    const listAt = (c) => git(repo, ["ls-tree", "-r", "--name-only", c]).out.split("\n").map((s) => s.trim()).filter(Boolean);
    const readAt = (c, p) => { const r = git(repo, ["show", `${c}:${p}`]); return r.ok ? r.out : null; };
    let g6res = { findings: [] };
    try {
      g6res = g6.computeG6({ base, head, changed, listAt, readAt, surfaces: g6cfg.surfaces, auto: g6cfg.auto });
    } catch { g6res = { findings: [] }; }
    if (g6res.findings.length) {
      RECEIPT.gates.G6 = { findings: g6res.findings.map((f) => ({ kind: f.kind, name: f.name, marker: f.marker, uncovered: f.uncovered })) };
      const detail = g6res.findings.map((f) =>
        `'${f.marker}'${f.name ? ` (${f.name})` : ""} landed on ${(f.adopters || []).join(", ") || "some surfaces"} but these siblings still lack it: ${f.uncovered.slice(0, 12).join(", ")}${f.uncovered.length > 12 ? ` (+${f.uncovered.length - 12} more)` : ""}`).join(" | ");
      const msg = `G6 incomplete rollout: a pattern landed on some sibling surfaces but not all - an "app-wide" change that is not yet app-wide. ${detail}. Apply it to the missing surfaces, or note the divergence.`;
      if ((g6cfg.mode || "warn") === "block") emit("BLOCK", msg);
      warn(msg);
    }
  }

  // G11 referee-integrity (the "don't shoot the referee" gate): a green earned by DELETING
  // the failing test, SKIPPING it, or regenerating snapshots wholesale is a suite that lost
  // its teeth - G9 verifies the suite passes, G11 watches that it kept its assertion power.
  // Static over the -M name-status diff (renames are not deletions), every PR, like G6.
  if (gateOn(gates, "G11")) {
    const g11cfg = (gates && gates.G11) || {};
    const ns = git(repo, ["diff", "--name-status", "-M", `${base}..${head}`]);
    const nameStatus = !ns.ok ? [] : ns.out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const parts = l.split(/\t/);
      const status = parts[0][0]; // "R100" -> "R"
      return status === "R" ? { status, file: parts[1], to: parts[2] } : { status, file: parts[1] };
    });
    const readAt = (c, p) => { const r = git(repo, ["show", `${c}:${p}`]); return r.ok ? r.out : null; };
    let g11res = { deletions: [], skips: [], snapshots: [] };
    try { g11res = g11.computeG11({ nameStatus, readAt, base, head }); } catch { /* keep empty */ }
    const acknowledged = g11.testRemovalAcknowledged(prBody);
    if (g11res.deletions.length || g11res.skips.length || g11res.snapshots.length)
      RECEIPT.gates.G11 = { deletions: g11res.deletions, skips: g11res.skips, snapshots: g11res.snapshots, acknowledged };
    const hard = [];
    if (g11res.deletions.length) hard.push(`deleted test file(s): ${g11res.deletions.join(", ")}`);
    if (g11res.skips.length) hard.push(`skip/focus marker(s) added: ${g11res.skips.map((s) => `${s.file} (${s.marker} +${s.added})`).join(", ")}`);
    if (hard.length) {
      if (acknowledged) {
        warn(`G11: test removal/skip acknowledged via 'test-removal:' - ${hard.join("; ")} (tracked, not blocked).`);
      } else {
        const msg = `G11 referee integrity: this PR removes or mutes tests - ${hard.join("; ")}. A green earned by shrinking the suite proves nothing: G9 checks that the suite passes, G11 that it kept its teeth. Restore them, or acknowledge honestly with a 'test-removal: <why>' line in the PR body.`;
        if ((g11cfg.mode || "warn") === "block") emit("BLOCK", msg);
        warn(msg);
      }
    }
    if (g11res.snapshots.length)
      // Snapshots update legitimately with intended changes - always warn-only, framed as
      // the question it is.
      warn(`G11: ${g11res.snapshots.length} snapshot file(s) rewritten (${g11res.snapshots.slice(0, 6).join(", ")}${g11res.snapshots.length > 6 ? ` +${g11res.snapshots.length - 6} more` : ""}) - confirm they encode the INTENDED behavior, not a regeneration that makes whatever the code now does the expectation.`);
  }

  // Strict trigger: an unclaimed code change that touched no PRODUCTION source (docs / tests /
  // config only) has nothing to re-verify; otherwise it falls through and must carry a receipt.
  if (strict && bodyProvided && !isFixClaim && !workType && !changedSource.length)
    emit("PASS", "no production source changed (docs / tests / config only) - nothing to re-verify");
  // Not a fix-claim and no work-type (default trigger) -> nothing to re-verify. finish() (not a
  // bare PASS) so a G6 warning above still surfaces as WARN rather than being swallowed.
  if (bodyProvided && !isFixClaim && !workType && !strict) finish("not a fix-claim (no issue link) - nothing to re-verify");

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

  // G12 fix-the-cause-not-the-alarm (the silencing assist): a fix-claim whose diff REMOVES
  // throw/raise statements or ADDS empty catches may have silenced the symptom rather than
  // repaired the invariant - the receipt goes red->green honestly (the alarm IS gone) and
  // the fix is wrong in the worst way. Heuristic, so it ASKS; the judgment is the agent's
  // and the reviewer's (some fixes legitimately remove an over-strict check).
  if (isFixClaim && gateOn(gates, "G12") && changedSource.length) {
    const g12cfg = (gates && gates.G12) || {};
    const readAt = (c, p) => { const r = git(repo, ["show", `${c}:${p}`]); return r.ok ? r.out : null; };
    let g12res = { findings: [] };
    try { g12res = g12.computeG12({ changedSource, readAt, base, head }); } catch { /* keep empty */ }
    if (g12res.findings.length) {
      RECEIPT.gates.G12 = { findings: g12res.findings };
      const detail = g12res.findings.map((f) =>
        f.kind === "removed-throw" ? `${f.file}: ${f.removed} throw/raise removed` : `${f.file}: ${f.name} added`).join("; ");
      const msg = `G12 fix the cause, not the alarm: this fix ${detail}. If the symptom disappeared because its DETECTOR did (a permission check deleted to cure a 403, an exception swallowed to cure an error toast), the bug is still there - now unreported. If the check itself was the bug, say so in the PR; a receipt asserting the POSITIVE behavior (the value arrives, the action succeeds) beats one asserting the complaint is gone.`;
      if ((g12cfg.mode || "warn") === "block") emit("BLOCK", msg);
      warn(msg);
    }
  }

  // G7 dependent-test-selection: compute the NEW dependents of the changed source - consumers
  // that newly route through it (a freshly-added file, or a freshly-added import edge). Their
  // co-located tests get re-run on head below, so an integration break the carried receipt
  // never exercises is caught. Built-in JS/TS scan + an optional gates.G7.graph for any stack.
  const g7cfg = (gates && gates.G7) || {};
  let g7res = { computed: false, newDependents: [] };
  if (gateOn(gates, "G7") && changedSource.length) {
    const listAt = (c) => git(repo, ["ls-tree", "-r", "--name-only", c]).out.split("\n").map((s) => s.trim()).filter(Boolean);
    const readAt = (c, p) => { const r = git(repo, ["show", `${c}:${p}`]); return r.ok ? r.out : null; };
    let graph = null;
    if (g7cfg.graph) { const g = readAt(head, g7cfg.graph); if (g) { try { graph = JSON.parse(g); } catch { /* not JSON */ } } }
    try {
      g7res = g7.computeNewDependents({ base, head, changedSource, listAt, readAt, graph, allDependents: !!g7cfg.verify_all_dependents });
    } catch { g7res = { computed: false, newDependents: [] }; }
    RECEIPT.gates.G7 = { computed: g7res.computed, new_dependents: g7res.newDependents.map((d) => ({ file: d.file, reason: d.reason, tests: d.tests })) };
  }

  // G9 unmasked: a command that can hide its own exit code cannot be trusted. Checked at the
  // point each command actually RUNS (below), so a command that will NOT run - a masked
  // test_command on an inverted or no-receipt path, or a suite_command with G9 off - is never
  // a false block.

  // Inverted receipt: a refactor/chore changes no behavior, so the proof is the full suite
  // staying green on head - not a red->green on a new test. In a monorepo with no root
  // suite, EVERY package suite is the proof (no behavior change anywhere).
  if (inverted) {
    const rootSuiteCmd = verify.suite_command;
    const invRunners = rootSuiteCmd && !/REPLACE_ME/.test(rootSuiteCmd)
      ? [{ dir: "", cmd: rootSuiteCmd }]
      : [...pkgVerify.entries()]
          .filter(([, v]) => v.suite_command && !/REPLACE_ME/.test(v.suite_command))
          .map(([d, v]) => ({ dir: d, cmd: v.suite_command }));
    if (!invRunners.length)
      emit(noReceiptMode === "warn" ? "WARN" : "BLOCK",
        `${workType}: a ${workType} changes no behavior, so its receipt is the FULL suite staying green on head - but verify.suite_command is not set. Set it, or tag the PR honestly.`);
    for (const s of invRunners)
      if (masksExit(s.cmd))
        emit("BLOCK", `verify.suite_command${s.dir ? ` for package '${s.dir}'` : ""} can mask its own exit code - a green cannot be trusted (G9). Use a clean command or a script.`);
    RECEIPT.gates.work_type_inverted = workType;
    const original = originalRef(repo);
    let bad = null;
    try {
      if (!git(repo, ["checkout", "-q", "-f", head]).ok) emit("BLOCK", `cannot checkout head ${head}`);
      for (const s of invRunners) {
        const r = runCmd(path.join(repo, s.dir), s.cmd, cmdTimeout);
        record(s.dir ? `${workType}-suite@head [${s.dir}]` : `${workType}-suite@head`, s.cmd, r);
        if (!r.ok && !bad) bad = r;
      }
    } finally {
      git(repo, ["checkout", "-q", "-f", original]);
    }
    if (bad)
      emit("BLOCK", `${workType}: the full suite is NOT green on head - a ${workType} must not change behavior`, (bad.out || "").split("\n").slice(-8).join("\n"));
    finish(`${workType} verified: the full suite is green on head (no behavior change) - G9`);
  }

  // The receipt = test files added/changed between base and head - unless the PR PINS it:
  // a `receipt: <path>` line in the body names the acceptance test explicitly, separating
  // the real receipt from incidental test churn (a snapshot refresh, a rename) that would
  // otherwise pollute the red run and mis-read as "weak receipt". A pin may also name an
  // UNCHANGED test - the legitimate "my fix makes existing test X flip red->green" case.
  // Parsing is strict-but-forgiving: a single path-looking token is a pin (and is blocked
  // if invalid); a line with prose after the colon is ignored.
  // Excluded from the receipt set: a test DELETED by the PR (it cannot run on head; its
  // absence is G11's finding, not a receipt) and snapshot ARTIFACTS (.snap matches the
  // test-path shape but is not runnable - churn is G11's finding too).
  const changedTests = changed.filter((f) =>
    TEST_PATH.test(f) && !g11.SNAPSHOT_PATH.test(f) && git(repo, ["cat-file", "-e", `${head}:${f}`]).ok);
  const pins = [];
  const pinRe = /^\s*receipt\s*:\s*(\S+)\s*$/gim;
  let pm;
  while ((pm = pinRe.exec(prBody))) pins.push(pm[1]);
  const pathish = [...new Set(pins.filter((p) => /[/.]/.test(p)))];
  for (const p of pathish) {
    if (!TEST_PATH.test(p))
      emit("BLOCK", `pinned receipt '${p}' is not a test file - \`receipt:\` must name the acceptance test that flips red->green`);
    if (!git(repo, ["cat-file", "-e", `${head}:${p}`]).ok)
      emit("BLOCK", `pinned receipt '${p}' does not exist at head`);
  }
  const tests = pathish.length ? pathish : changedTests;
  RECEIPT.tests = tests;
  RECEIPT.pinned = pathish.length > 0;
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

  // Group the receipt tests by their nearest config (monorepo: nested configs supply
  // per-package test runners) and validate every group's runner up front.
  const groups = groupTestsByPackage(tests, pkgVerify, verify);
  for (const gp of groups) {
    const tc = gp.verify.test_command;
    const where = gp.dir ? ` for package '${gp.dir}'` : "";
    if (!tc || /REPLACE_ME/.test(tc))
      emit("BLOCK", `verify.test_command is not set${where} in receipts.config.json (run \`receipts init\`${gp.dir ? " there" : ""})`);
    if (masksExit(tc))
      emit("BLOCK", `verify.test_command${where} can mask its own exit code (; , || , pipe, background &, newline, or command substitution), so a green from it cannot be trusted (G9). Use a single command whose own exit is the test result, or wrap it in a script.`);
  }
  // One labeled command per group; the aggregate is ok only when EVERY group is.
  const runGroups = (gs, label) => {
    const agg = { ok: true, out: "", timedOut: false };
    for (const gp of gs) {
      const cmd = expandTestPlaceholders(gp.verify.test_command, gp.tests);
      const r = runCmd(path.join(repo, gp.dir), cmd, cmdTimeout);
      record(gp.dir ? `${label} [${gp.dir}]` : label, cmd, r);
      agg.ok = agg.ok && r.ok;
      agg.out += r.out || "";
      agg.timedOut = agg.timedOut || !!r.timedOut;
    }
    return agg;
  };

  // G9 suite runners: the root suite when configured; else the AFFECTED packages' suites.
  const suiteCmd = verify.suite_command;
  const suiteRunners = suiteCmd && !/REPLACE_ME/.test(suiteCmd)
    ? [{ dir: "", cmd: suiteCmd }]
    : groups
        .filter((gp) => gp.dir && gp.verify.suite_command && !/REPLACE_ME/.test(gp.verify.suite_command))
        .map((gp) => ({ dir: gp.dir, cmd: gp.verify.suite_command }));
  const haveSuite = suiteRunners.length > 0;
  // G13 claim-scope congruence is opt-in: only with a coverage command configured (root only).
  const g13cfg = (gates && gates.G13) || {};
  const haveG13 = gateOn(gates, "G13") && g13cfg.coverage_command && !/REPLACE_ME/.test(g13cfg.coverage_command);
  // Mask-check only the commands that will now run: the receipt always, the suite if G9 is on.
  if (gateOn(gates, "G9"))
    for (const s of suiteRunners)
      if (masksExit(s.cmd))
        emit("BLOCK", `verify.suite_command${s.dir ? ` for package '${s.dir}'` : ""} can mask its own exit code - a green cannot be trusted (G9). Use a clean command or a script.`);
  if (haveG13 && masksExit(g13cfg.coverage_command))
    emit("BLOCK", "gates.G13.coverage_command can mask its own exit code - its coverage output cannot be trusted (G9). Use a clean command or a script.");

  // G7: the new dependents' co-located tests to re-run on head (path-safe, deduped), and the
  // new dependents that have NO test to re-run (surfaced as a warning, never a silent pass).
  const depTests = [...new Set(g7res.newDependents.flatMap((d) => d.tests))]
    .filter((f) => !(UNSAFE_PATH.test(f) || /^[-:]/.test(f)));
  const depNoTest = g7res.newDependents.filter((d) => !d.tests.length);
  // Dependent tests group like receipt tests; a group whose package has no usable
  // runner is skipped LOUDLY, never silently.
  const depGroups = groupTestsByPackage(depTests, pkgVerify, verify)
    .filter((gp) => {
      const tc = gp.verify.test_command;
      if (tc && !/REPLACE_ME/.test(tc) && !masksExit(tc)) return true;
      warn(`G7: dependent test(s) in ${gp.dir ? `package '${gp.dir}'` : "the root"} skipped - no usable verify.test_command there (${gp.tests.join(", ")}).`);
      return false;
    });

  // Determinism (verify.receipt_runs, default 1): a FLAKY receipt can manufacture a fake
  // red (a green test that flaked red on base) or pass a broken fix (a red that flaked
  // green on head). With N > 1, the red must be red N/N and the green green N/N.
  const receiptRuns = Math.max(1, Math.floor(Number(verify.receipt_runs) || 1));
  const runLabel = (name, i) => (receiptRuns > 1 ? `${name} [${i + 1}/${receiptRuns}]` : name);
  const original = originalRef(repo);
  const reds = [], greens = [];
  let suite, g7run, g13run;
  try {
    // RED: base source, with head's receipt test(s) overlaid on top.
    if (!git(repo, ["checkout", "-q", "-f", base]).ok) emit("BLOCK", `cannot checkout base ${base}`);
    git(repo, ["checkout", "-q", head, "--", ...tests]);
    for (let i = 0; i < receiptRuns; i++) {
      reds.push(runGroups(groups, runLabel("receipt-red@base", i))); // expect FAIL = reproduces the bug
    }
    RECEIPT.red = reds.every((r) => !r.ok); // red = reproduced on base (FAILED there, every run)
    // GREEN: full head.
    git(repo, ["checkout", "-q", "-f", head]);
    for (let i = 0; i < receiptRuns; i++) {
      greens.push(runGroups(groups, runLabel("receipt-green@head", i))); // expect PASS = bug gone
    }
    RECEIPT.green = greens.every((g) => g.ok); // green = gone on head (PASSED there, every run)
    if (RECEIPT.green && haveSuite && gateOn(gates, "G9")) {
      suite = { ok: true, out: "" };
      for (const s of suiteRunners) {
        const r = runCmd(path.join(repo, s.dir), s.cmd, cmdTimeout);
        record(s.dir ? `suite@head [${s.dir}]` : "suite@head", s.cmd, r);
        if (!r.ok && suite.ok) { suite.ok = false; suite.out = r.out || ""; }
      }
    }
    // G7: re-run the new dependents' tests on head - unless a green full suite already covered
    // them (it runs every test, so re-running the subset would be waste).
    if (RECEIPT.green && gateOn(gates, "G7") && depGroups.length && !(suite && suite.ok)) {
      g7run = runGroups(depGroups, "g7-dependents@head");
    }
    // G13: run the coverage command on head (it needs the head tree); the lcov it wrote
    // is read AFTER the checkout dance (an untracked file survives the restore).
    if (RECEIPT.green && haveG13 && changedSource.length) {
      g13run = runCmd(repo, g13cfg.coverage_command, cmdTimeout);
      record("g13-coverage@head", g13cfg.coverage_command, g13run);
    }
  } finally {
    git(repo, ["checkout", "-q", "-f", original]);
  }

  // G13 claim-scope congruence: intersect the lcov's executed lines with the diff's
  // ADDED production lines. Changed lines no test executed are unverified changes -
  // named, warn by default, gates.G13.mode -> block. Degradations are loud, not silent.
  if (haveG13 && changedSource.length) {
    if (!g13run || !g13run.ok) {
      warn(`G13 not evaluated: the coverage command ${g13run ? "failed" : "did not run"} - fix gates.G13.coverage_command or disable the gate; unverified-changed-lines were NOT checked.`);
    } else {
      const lcovPath = path.join(repo, g13cfg.lcov_path || "coverage/lcov.info");
      let lcovText = null;
      try { lcovText = fs.readFileSync(lcovPath, "utf8"); } catch { /* handled below */ }
      if (lcovText == null) {
        warn(`G13 not evaluated: no lcov at ${g13cfg.lcov_path || "coverage/lcov.info"} after the coverage run - point gates.G13.lcov_path at where your tool writes it.`);
      } else {
        const diffU0 = git(repo, ["diff", "-U0", "--no-color", `${base}..${head}`, "--", ...changedSource]);
        const res = g13.computeG13({ addedLines: g13.parseAddedLines(diffU0.out), lcov: g13.parseLcov(lcovText) });
        if (res.findings.length) {
          RECEIPT.gates.G13 = { findings: res.findings };
          const detail = res.findings.slice(0, 8).map((f) =>
            `${f.file}: ${f.uncovered.length}/${f.added} added line(s) never executed${f.no_data ? " (file not loaded by any test)" : ""} [${f.uncovered.slice(0, 12).join(",")}${f.uncovered.length > 12 ? ",…" : ""}]`).join("; ");
          const msg = `G13 claim-scope congruence: the receipt does not EXERCISE the whole diff - ${detail}${res.findings.length > 8 ? ` (+${res.findings.length - 8} more file(s))` : ""}. These changed lines are unverified: cover them, split them out, or carry an honest tag.`;
          if ((g13cfg.mode || "warn") === "block") emit("BLOCK", msg);
          warn(msg);
        }
      }
    }
  }

  const redPasses = reds.filter((r) => r.ok).length;
  if (redPasses === reds.length)
    // A test that passes on base did not reproduce the symptom - for a fix-claim that is an
    // unproven receipt, not a clean pass. (A behavior-preserving change uses work-type.)
    emit(noReceiptMode === "warn" ? "WARN" : "BLOCK",
      "weak receipt: the test PASSES on the base commit, so it does not prove it reproduced the reported symptom (G0/G1). Make the test assert the actual symptom, tag the PR honestly, or - if no behavior changes - mark it `work-type: refactor`.");
  if (redPasses > 0)
    // Mixed red = nondeterministic. Never "allowed by config" - a flake proves nothing.
    emit("BLOCK",
      `flaky receipt: the test passed on the base commit in ${redPasses}/${reds.length} run(s) and failed in the rest - a nondeterministic red cannot prove it reproduced the symptom (G0/G9). Deflake it (pin time / network / ordering), then re-run.`);
  const redOut = (reds.find((r) => !r.ok) || reds[0]).out || "";
  if (LOAD_ERROR.test(redOut)) {
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
  const greenFails = greens.filter((g) => !g.ok);
  if (greenFails.length === greens.length)
    emit("BLOCK", "the fix does not pass its own receipt test on head", (greenFails[0].out || "").split("\n").slice(-8).join("\n"));
  if (greenFails.length > 0)
    // Mixed green = nondeterministic: it "passed" only sometimes. Not a fix you can trust.
    emit("BLOCK",
      `flaky green: the receipt passed on head in only ${greens.length - greenFails.length}/${greens.length} run(s) - a nondeterministic green cannot be trusted as proof the symptom is gone (G9). Deflake the test, then re-run.`,
      (greenFails[0].out || "").split("\n").slice(-8).join("\n"));
  if (haveSuite && suite && !suite.ok)
    emit("BLOCK", "G9 full-scope green: the fix passes its own receipt but BREAKS the full suite - a regression in code the changed test never exercised. Fix it, or carry a downgrade tag.", (suite.out || "").split("\n").slice(-8).join("\n"));
  if (gateOn(gates, "G9") && !haveSuite)
    warn("G9 full-scope green not checked: set verify.suite_command so the enforcer runs the full suite on head (the regression is often outside the changed test).");

  // G7: a NEW consumer of the changed surface whose test fails on head is an integration
  // regression the carried receipt would never catch. Default warn (the reverse-dep set is
  // heuristic); gates.G7.mode -> block. A new consumer with NO test is surfaced, never silent.
  if (gateOn(gates, "G7")) {
    if (g7run && !g7run.ok) {
      const names = g7res.newDependents.filter((d) => d.tests.length).map((d) => d.file).join(", ");
      const msg = `G7 dependent regression: a NEW consumer of the changed surface FAILS its tests on head (${names}). The change broke a downstream dependent the carried receipt never exercised. Fix it, sequence the change, or carry a downgrade tag.`;
      if (RECEIPT.gates.G7) { RECEIPT.gates.G7.ran = true; RECEIPT.gates.G7.ok = false; }
      if ((g7cfg.mode || "warn") === "block") emit("BLOCK", msg, (g7run.out || "").split("\n").slice(-8).join("\n"));
      warn(msg);
    }
    if (depNoTest.length)
      warn(`G7: ${depNoTest.length} new dependent(s) of the changed surface have no co-located test to re-run (${depNoTest.map((d) => d.file).join(", ")}) - verify them manually.`);
  }
  finish("receipt verified: red on base, green on fix - the symptom is reproduced and now gone");
}

// Run only when invoked as a script. When this file is `require`d (the enforcer's own
// test suite - Phase 0 self-verification), main() must NOT run; only the pure,
// side-effect-free helpers below are exported for direct unit testing.
if (require.main === module) {
  try { main(); }
  catch (e) { console.error("receipts enforcer error: " + (e && e.message ? e.message : e)); process.exit(1); }
}

module.exports = { masksExit, gateOn, globToRe, isContractFile, typeSet, walkBreaks, contractBreaks, expandTestPlaceholders, resolveTimeout, unknownConfigKeys, groupTestsByPackage };
