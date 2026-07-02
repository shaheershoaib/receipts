#!/usr/bin/env node
/*
 * PreToolUse hook: in-session TRIPWIRES - small guards that fire at the moment of the
 * risky action, BETWEEN the two heavy enforcement points (the Stop-hook backstop and the
 * CI enforcer). They raise the weak-agent floor without waiting for a stop-cycle or a PR:
 *
 *   1. COMMIT-WITHOUT-VERIFICATION (Bash `git commit`): a commit that lands right after a
 *      production-source edit with NO test / receipt-ish command run in between is the
 *      classic "coded it, committed it, never ran it" move. Deny with a cheap, EXPLICIT
 *      escape (run the tests, or carry an honesty ack) - the ack is greppable, never silent.
 *   2. G11-LIVE referee integrity (Edit/Write/MultiEdit on a TEST file): editing a test that
 *      was just seen FAILING - with no intervening green - is the "shoot the referee" move
 *      G11 names (fix the code, not the test). Deny with the G11 mandate + the same ack escape.
 *
 * Detection is STRUCTURAL + ORDERED over the transcript (real tool_use / tool_result events,
 * command boundaries), the same discipline as stop-gates.mjs: a `git commit` inside a
 * printf/string is DATA, not a commit; a status named mid-prose is not a close-out. It fails
 * SAFE on any parse/IO problem (a missed tripwire beats a spurious deny that jams the agent).
 *
 * Project specifics come from receipts.config.json (agent-home base, nearest project config
 * merged over) - the SAME resolution stop-gates uses. Tripwire behavior + patterns live under
 * `agent.tripwires`; zero-config works via generic defaults.
 *
 * Input:  PreToolUse JSON on stdin ({tool_name, tool_input, transcript_path, cwd, ...}).
 * Output: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 *          "permissionDecisionReason":"..."}} to block; nothing (exit 0) to allow.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ------------------------------------------------------------ shared matchers/heuristics
//
// Deliberately DUPLICATED from stop-gates.mjs (small, stable primitives) rather than shared
// through an import: the two hooks run as independent processes and must not couple, and
// keeping stop-gates byte-for-byte unchanged protects its test suite. Any drift here is
// contained to the PreToolUse path.

// `git commit` only at a command boundary (line/`;`/`&&`/`||`/`|` start, optional env
// assignments before it), so a printf/echo/grep that CONTAINS "git commit" as data does not
// match. Env-var prefixes (FOO=bar git commit) are skipped so an inline RECEIPTS_ACK=... still
// reads as a commit.
const GIT_COMMIT = /(?:^|[;&|]|\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*git\s+commit\b/;

// Canonical path classes, mirrored from enforcer/verify.js so a file is classified the SAME
// way here as at the PR (test files, docs/meta). Everything else is treated as production source.
const TEST_PATH = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|\/__tests__\/|_spec\.)/i;
const DOC_OR_META = /(^|\/)(LICENSE|CHANGELOG)|\.(md|markdown|txt|rst|adoc)$|(^|\/)\.github\/|(^|\/)receipts\.config\.json$|(^|\/)\.gitignore$/i;

// A command that RUNS the code / produces a receipt: a test run, or a receipts probe. The
// default set is generic-but-broad; agent.tripwires.test_command_patterns EXTENDS it. Matched
// at a loose word boundary (not command-anchored) - running the tests ANYWHERE in a compound
// command counts.
const DEFAULT_TEST_CMD_SRC = [
  "\\bnpm\\s+(?:run\\s+)?test\\b", "\\bnpm\\s+t\\b", "\\bpnpm\\s+(?:run\\s+)?test\\b", "\\byarn\\s+test\\b",
  "\\bnode\\s+--test\\b", "\\bvitest\\b", "\\bjest\\b", "\\bmocha\\b", "\\bplaywright\\s+test\\b",
  "\\bpytest\\b", "\\bpy\\.test\\b", "\\bmanage\\.py\\s+test\\b", "\\btox\\b", "\\bnox\\b",
  "\\bgo\\s+test\\b", "\\bcargo\\s+test\\b", "\\bmvn\\b[^\\n]*\\btest\\b", "\\bgradle\\b[^\\n]*\\btest\\b",
  "\\brspec\\b", "\\bmix\\s+test\\b", "\\bphpunit\\b", "\\bdotnet\\s+test\\b", "\\bctest\\b", "\\bbats\\b",
  "\\breceipts\\s+(?:observe|verify)\\b", "receipts-cli\\s+(?:observe|verify)\\b",
];

// The explicit, greppable escape (an honesty tag, like the downgrade tags): an agent that
// deliberately commits/edits without the check says so IN the command, never silently. Matched
// case-insensitively; a reason after `=`/`:` is encouraged but not required.
//   RECEIPTS_ACK=<reason>   RECEIPTS_ACK:<reason>   RECEIPTS_TRIPWIRE=off   --no-verify-receipts
const ACK_TAG = /RECEIPTS_ACK\s*[:=]|RECEIPTS_TRIPWIRE\s*=\s*off|--no-verify-receipts\b/i;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ------------------------------------------------------------------- config load (as stop-gates)

function readConfigFile(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return e && e.code === "ENOENT" ? null : {}; }
}
function deepMerge(base, over) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
      ? deepMerge(out[k], v) : v;
  }
  return out;
}
function loadReceiptsConfig(start) {
  const home = readConfigFile(path.join(os.homedir(), ".claude", "receipts.config.json")) || {};
  let proj = {};
  let d = path.resolve(start || ".");
  for (let i = 0; i < 40; i++) {
    const c = readConfigFile(path.join(d, "receipts.config.json"));
    if (c !== null) { proj = c; break; }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return deepMerge(home, proj);
}

// One tripwire's mode, honoring `off`. Unknown values fall back to the default.
function tripwireMode(cfg, key, dflt) {
  const t = ((cfg.agent || {}).tripwires) || {};
  const v = String(t[key] || "").toLowerCase();
  return v === "off" || v === "warn" || v === "deny" ? v : dflt;
}
function testCmdMatcher(cfg) {
  const t = ((cfg.agent || {}).tripwires) || {};
  const extra = (t.test_command_patterns || []).filter((p) => String(p || "").trim());
  const parts = [...DEFAULT_TEST_CMD_SRC, ...extra];
  return new RegExp(`(?:${parts.join("|")})`, "i");
}

// -------------------------------------------------------------- transcript parse (as stop-gates)

// Ordered walk that captures BOTH tool_use (name + input) and tool_result (the output text a
// prior tool produced). The commit tripwire needs to interleave "an edit happened" with "a test
// command ran" and "a test failed in output", so tool_results are first-class here (stop-gates
// only needed tool_uses + the embedded live-receipt markers).
function walkEvents(obj, out) {
  if (Array.isArray(obj)) { for (const v of obj) walkEvents(v, out); return; }
  if (obj && typeof obj === "object") {
    if (obj.type === "tool_use" && "name" in obj) {
      out.push({ kind: "use", name: String(obj.name || ""), input: obj.input ?? {} });
    } else if (obj.type === "tool_result") {
      const strings = [];
      walkStrings(obj.content, strings);
      out.push({ kind: "result", text: strings.join("\n") });
    }
    for (const v of Object.values(obj)) walkEvents(v, out);
  }
}
function walkStrings(obj, out) {
  if (typeof obj === "string") { out.push(obj); return; }
  if (Array.isArray(obj)) { for (const v of obj) walkStrings(v, out); return; }
  if (obj && typeof obj === "object") for (const v of Object.values(obj)) walkStrings(v, out);
}

const sget = (inp, key) => (inp && typeof inp === "object" && !Array.isArray(inp) ? inp[key] : undefined);

// The file path an edit-family tool touched (Edit/Write/MultiEdit and common MCP variants all
// key it `file_path`; some use `path`/`filePath`). Returns "" when absent.
function editedPath(inp) {
  return String(sget(inp, "file_path") || sget(inp, "path") || sget(inp, "filePath") || "");
}
const isEditTool = (name) => /(?:^|_)(edit|write|multiedit)$/i.test(String(name || "")) ||
  ["Edit", "Write", "MultiEdit"].includes(name);

const isProdSource = (p) => !!p && !TEST_PATH.test(p) && !DOC_OR_META.test(p);
const basename = (p) => String(p || "").split(/[\\/]/).pop() || "";

// ------------------------------------------------------------------- tripwire 1: commit

// Scan the events up to now: find the LAST production-source edit, and whether any test/receipt
// COMMAND ran strictly AFTER it. The signal is the Bash command that was INVOKED (test_command
// patterns) - matched on the command string, not on a runner's output text, which is format-
// dependent and could false-allow from prose. Returns { editedFile } to deny, else null.
function commitTripwire(events, testCmd) {
  let lastProdEditIdx = -1, lastProdEditFile = "";
  let testRanAfterEdit = false;
  events.forEach((e, i) => {
    if (e.kind === "use" && isEditTool(e.name)) {
      const f = editedPath(e.input);
      if (isProdSource(f)) { lastProdEditIdx = i; lastProdEditFile = f; testRanAfterEdit = false; }
    }
    if (i > lastProdEditIdx && lastProdEditIdx >= 0 &&
        e.kind === "use" && e.name === "Bash" && testCmd.test(String(sget(e.input, "command") || ""))) {
      testRanAfterEdit = true;
    }
  });
  if (lastProdEditIdx < 0) return null;        // nothing risky was edited this session
  if (testRanAfterEdit) return null;           // the code was exercised after the edit
  return { editedFile: lastProdEditFile };
}

function commitReason(editedFile) {
  return (
    "TRIPWIRE (commit-without-verification): you are about to `git commit`, but the last " +
    "production-source edit this session (" + (editedFile || "a source file") + ") was NOT " +
    "followed by any test or receipt command - nothing ran the code you changed. A commit is a " +
    "claim it works; per the Gates (G0/G9) that claim needs a red->green receipt, not a hopeful " +
    "commit. Do ONE of:\n" +
    "  - run the tests (e.g. `npm test` / `pytest` / `go test ...`) or `receipts observe ...`, " +
    "then re-run the commit; or\n" +
    "  - if the tests genuinely do not apply (docs-only follow-up, WIP checkpoint you will verify " +
    "before the PR), re-run the commit carrying an EXPLICIT ack in the command: prepend " +
    "`RECEIPTS_ACK='<why no test>'` (e.g. `RECEIPTS_ACK='wip checkpoint, tests before PR' git commit ...`), " +
    "or add `--no-verify-receipts` to the message. The ack is greppable on purpose - an honest " +
    "note, never a silent skip."
  );
}

// ------------------------------------------------------- tripwire 2: G11-live (edit the referee)

// A test was seen FAILING in output, then the agent goes to EDIT that same test file with no
// intervening passing run: the "weaken the referee to win" move. CONSERVATIVE - it fires only
// when the edited test file's exact path (or, failing an absolute-path echo, its basename) is
// named in a failing tool_result AND no later result shows that same file passing/green. When
// unsure, allow.
//
// Failing/passing signals are read from tool_result text (a runner's stdout lands there). We do
// NOT try to fully parse every runner; we look for the file token co-located with a generic
// FAIL/PASS token, which is enough to be conservative without false denies.
const FAIL_TOKEN = /\b(FAIL|FAILED|failing|✕|✗|×|not ok|AssertionError|assert(?:ion)?\s+failed|Error:|✘)\b/;
const PASS_TOKEN = /\b(PASS|PASSED|passing|✓|✔|ok\b|tests?\s+passed|0\s+fail(?:ing|ed|ures)?)\b/i;

function g11LiveTripwire(events, editedFile) {
  if (!editedFile || !TEST_PATH.test(editedFile)) return null; // only guards edits to TEST files
  const base = basename(editedFile);
  if (!base) return null;
  // Match the file by its full path if the runner printed it, else by basename. Basename-only is
  // still conservative: it must appear in a result line that ALSO carries a fail token.
  const fileRe = new RegExp(escapeRe(editedFile) + "|" + escapeRe(base));
  let sawFailingForFile = false;
  for (const e of events) {
    if (e.kind !== "result") continue;
    const text = e.text || "";
    if (!fileRe.test(text)) continue;
    // Line-scoped: the file token and a fail/pass token on the SAME line (a runner's per-file
    // status line), so an unrelated FAIL elsewhere in a long log does not bind to this file.
    for (const line of text.split("\n")) {
      if (!fileRe.test(line)) continue;
      if (FAIL_TOKEN.test(line)) sawFailingForFile = true;
      else if (PASS_TOKEN.test(line)) sawFailingForFile = false; // an intervening green re-arms nothing
    }
  }
  if (!sawFailingForFile) return null;
  return { editedFile };
}

function g11Reason(editedFile) {
  return (
    "TRIPWIRE (G11 referee integrity): a test in " + editedFile + " was seen FAILING earlier " +
    "this session with no passing run since, and you are about to edit that test file. The Gates " +
    "G11: the suite is the referee - fix the CODE the test is catching, not the test. Do not " +
    "delete/skip/`.only`/loosen the assertion to turn it green; a green earned by weakening the " +
    "referee proves nothing. If this test genuinely must change (a dead feature, a wrong " +
    "expectation the reporter confirmed), proceed by carrying an EXPLICIT ack in the edit's " +
    "content or via env: a `test-removal: <why>` note (the honest, reviewed removal) or " +
    "`RECEIPTS_ACK='<why the test itself is wrong>'`. The ack is greppable on purpose - an " +
    "honest, reviewable decision, never a quiet one."
  );
}

// The edit-family tools also carry the ack inline (the new content, the message, or an env-ish
// string): let an ack in the edit's OWN payload clear the G11 tripwire, same escape as the commit.
function editCarriesAck(inp) {
  const bag = [sget(inp, "new_string"), sget(inp, "content"), sget(inp, "old_string")]
    .filter((s) => typeof s === "string").join("\n");
  return ACK_TAG.test(bag) || /test-removal\s*:/i.test(bag);
}

// ------------------------------------------------------------------------- output helpers

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }) + "\n");
}

// ------------------------------------------------------------------------- main

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let payload;
  try { payload = JSON.parse(await readStdin()); }
  catch { return; }
  const toolName = String(payload.tool_name || "");
  const toolInput = payload.tool_input ?? {};
  const tp = payload.transcript_path;

  const cfg = loadReceiptsConfig(payload.cwd);

  // ---- commit tripwire (Bash `git commit`) ----------------------------------------------
  if (toolName === "Bash") {
    const command = String(sget(toolInput, "command") || "");
    if (!GIT_COMMIT.test(command)) return;             // not a commit -> allow
    const mode = tripwireMode(cfg, "commit_unverified", "deny");
    if (mode === "off") return;
    if (ACK_TAG.test(command)) return;                 // explicit escape carried -> allow
    if (!tp) return;                                   // no transcript -> fail safe (allow)
    let events;
    try { events = parseTranscript(tp); } catch { return; }
    if (!events) return;
    let hit = null;
    try { hit = commitTripwire(events, testCmdMatcher(cfg)); } catch { return; }
    if (hit && mode === "deny") deny(commitReason(hit.editedFile));
    // mode === "warn": PreToolUse has no reliable agent-visible warn channel, so a warn is an
    // intentional no-op here (documented). The deny mode is the enforcing one.
    return;
  }

  // ---- G11-live tripwire (Edit/Write/MultiEdit on a test file) --------------------------
  if (isEditTool(toolName)) {
    const file = editedPath(toolInput);
    if (!file || !TEST_PATH.test(file)) return;        // only test-file edits are guarded
    const mode = tripwireMode(cfg, "g11_live", "deny");
    if (mode === "off") return;
    if (editCarriesAck(toolInput)) return;             // explicit ack in the edit -> allow
    if (!tp) return;
    let events;
    try { events = parseTranscript(tp); } catch { return; }
    if (!events) return;
    let hit = null;
    try { hit = g11LiveTripwire(events, file); } catch { return; }
    if (hit && mode === "deny") deny(g11Reason(hit.editedFile));
    return;
  }
  // any other tool -> allow (emit nothing)
}

// Parse the transcript JSONL into an ordered event stream (tool_use + tool_result). Returns null
// on IO failure (caller fails safe = allow).
function parseTranscript(tp) {
  let lines;
  try { lines = fs.readFileSync(tp, "utf8").split("\n"); }
  catch { return null; }
  const events = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let entry;
    try { entry = JSON.parse(t); } catch { continue; }
    try { walkEvents(entry, events); } catch { /* fail safe */ }
  }
  return events;
}

main().catch(() => { /* a hook must never crash the pre-tool step */ });
