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
import readline from "node:readline";

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

// The boundary regexes above treat "\n" as a command boundary, which is right for a
// multi-line shell script and wrong for a HEREDOC: every line inside `cat > f <<'EOF' ... EOF`
// starts after a newline, so a `git commit` written INTO a file (release notes, a runbook, a
// test fixture) read as a commit being RUN and denied it. Strip heredoc bodies first - keep
// the opener and terminator so the command still parses, drop only the data between them.
const HEREDOC_BODY = /(<<-?\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*\n)[\s\S]*?(\n[ \t]*\3[ \t]*)(?=\n|$)/g;
const withoutHeredocBodies = (cmd) => String(cmd || "").replace(HEREDOC_BODY, "$1$4");

// `receipts init` skipping the reachability interview. The interview is the ONLY source of
// agent.drive (auth route, dev bypass, data realism, browser-only surfaces) - detection cannot
// find any of it - and the answers are what let a gate refuse an "auth-walled, could not
// verify" downgrade. An agent that reaches for --yes silently answers those questions with
// "unknown" on the human's behalf, which is exactly the config-shaped hole the gates exist to
// close. Command-boundary anchored so an echo/printf CONTAINING the string is data, not a run.
const INIT_UNATTENDED =
  /(?:^|[;&|]|\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:npx\s+)?(?:receipts(?:-cli)?|node\s+\S*bin\/receipts\.js)\s+init\b[^\n;&|]*\s(?:--yes|-y)\b/;

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

// --- render-receipt tripwire matchers (opt-in; see renderTripwire) --------------------------
// A command that EXERCISES a render: a real browser / component-render runner, or a receipts
// observe of a URL. `receipts observe <query>` is deliberately NOT here - a data-form observe is
// a data read, not a render read (it lands in DATA_ONLY_CMD_SRC below).
const RENDER_OBSERVE_CMD_SRC = [
  "\\bplaywright\\b", "\\bcypress\\b", "\\bpuppeteer\\b", "\\bwebdriver\\b", "\\bselenium\\b",
  "@testing-library", "\\btesting-library\\b", "\\bstorybook\\b", "\\bchromatic\\b", "\\bpa11y\\b",
  "\\bpdftotext\\b", "receipts\\s+observe\\b[^\\n]*(?:--url|https?://)",
];
// A command that reads a VALUE WITHOUT rendering it: HTTP client, a SQL/DB client, or a data-form
// `receipts observe`. Used only to recognise "verified, but data-only" against a render edit.
const DATA_ONLY_CMD_SRC = [
  "\\bcurl\\b", "\\bwget\\b", "\\bhttp(?:ie)?\\b", "\\bpsql\\b", "\\bmysql\\b", "\\bmariadb\\b",
  "\\bsqlite3?\\b", "\\bmongo(?:sh)?\\b", "\\bredis-cli\\b", "\\bselect\\b[^\\n]*\\bfrom\\b",
  "receipts\\s+observe\\b", "receipts-cli\\s+observe\\b",
];
// Test runners (the DEFAULT_TEST_CMD set minus the receipts-observe/verify entries): a runner
// exercises code (incl. component renders via jsdom/RTL), so it counts as "the render was read".
const TEST_RUNNER_CMD_SRC = DEFAULT_TEST_CMD_SRC.filter((s) => !/receipts/.test(s));

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

// glob -> RegExp source: `**` any depth, `*` within a segment, `?` one char. Anchored nowhere
// (a substring match against the path), matching how the enforcer treats surface globs.
function globToRe(glob) {
  return String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*").replace(/\?/g, ".");
}
// The render-feeding source matcher: the UNION of declared render-twin surfaces
// (gates.G6.render_twins[].surfaces) and agent.tripwires.render_source_globs. Returns null when
// nothing is declared, which makes the render tripwire INERT - it is strictly opt-in per project,
// so nothing about any stack is baked in here.
function renderSourceMatcher(cfg) {
  const twins = (((cfg.gates || {}).G6 || {}).render_twins) || [];
  const fromTwins = Array.isArray(twins)
    ? twins.flatMap((t) => (t && Array.isArray(t.surfaces) ? t.surfaces : [])) : [];
  const explicit = (((cfg.agent || {}).tripwires || {}).render_source_globs) || [];
  const globs = [...fromTwins, ...explicit].map((g) => String(g || "").trim()).filter(Boolean);
  if (!globs.length) return null;
  return new RegExp(`(?:${globs.map(globToRe).join("|")})`);
}
function renderExercisedMatcher(cfg) {
  const extra = (((cfg.agent || {}).tripwires || {}).test_command_patterns || [])
    .filter((p) => String(p || "").trim());
  return new RegExp(`(?:${[...TEST_RUNNER_CMD_SRC, ...RENDER_OBSERVE_CMD_SRC, ...extra].join("|")})`, "i");
}
function dataOnlyMatcher() {
  return new RegExp(`(?:${DATA_ONLY_CMD_SRC.join("|")})`, "i");
}

// -------------------------------------------------------------- transcript parse (as stop-gates)

// Ordered walk that captures BOTH tool_use and tool_result, COMPACTED as each is met. A use keeps
// only its name, the edited path (edit-family tools) and the command (Bash) - never the input
// object. A result keeps only the lines that name the file under G11 scrutiny (`opts.fileRe`),
// and is dropped outright when no file is under scrutiny: the commit tripwire reads the commands
// that were INVOKED, never their output. The tripwires interleave "an edit happened" with "a test
// command ran" and "a test failed in output", so results stay first-class in the ORDER - but never
// in bulk: tool output is most of a long session's transcript, and the hook streams the file
// precisely so it never holds that (see parseTranscript).
function walkEvents(obj, out, opts) {
  if (Array.isArray(obj)) { for (const v of obj) walkEvents(v, out, opts); return; }
  if (obj && typeof obj === "object") {
    if (obj.type === "tool_use" && "name" in obj) {
      const name = String(obj.name || ""), input = obj.input ?? {};
      out.push({
        kind: "use", name,
        path: isEditTool(name) ? editedPath(input) : "",
        cmd: name === "Bash" ? String(sget(input, "command") || "") : "",
      });
    } else if (obj.type === "tool_result" && opts.fileRe) {
      const strings = [];
      walkStrings(obj.content, strings);
      const lines = strings.join("\n").split("\n").filter((l) => opts.fileRe.test(l));
      if (lines.length) out.push({ kind: "result", lines });
    }
    for (const v of Object.values(obj)) walkEvents(v, out, opts);
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
    if (e.kind === "use" && isProdSource(e.path)) { lastProdEditIdx = i; lastProdEditFile = e.path; testRanAfterEdit = false; }
    if (i > lastProdEditIdx && lastProdEditIdx >= 0 && e.kind === "use" && e.name === "Bash" && testCmd.test(e.cmd)) {
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

// --------------------------------------------- tripwire 3: producer-without-render-receipt (opt-in)

// The commit-tripwire's blind spot: a render-feeding source was edited AND a verification DID run
// (so commit-without-verification passes), but that verification was DATA-ONLY (a query / curl /
// data-form `receipts observe`) - nothing read the RENDERED surface it feeds. That is the
// "created it, checked the DB, shipped; the surface still drops it" bug. CONSERVATIVE + opt-in:
// fires only when (a) the project declared render surfaces (isRenderSource != null), (b) the last
// render-feeding edit was followed by a data-only probe, and (c) NO test-runner / render-observe
// ran after it. If a runner or a render-observe ran, the render was exercised -> allow.
function renderTripwire(events, isRenderSource, dataOnly, exercised) {
  if (!isRenderSource) return null;             // opt-in: no declared render surfaces -> inert
  let lastIdx = -1, lastFile = "";
  let sawDataOnly = false, sawExercised = false;
  events.forEach((e, i) => {
    if (e.kind === "use" && isProdSource(e.path) && isRenderSource.test(e.path)) {
      lastIdx = i; lastFile = e.path; sawDataOnly = false; sawExercised = false;
    }
    if (i > lastIdx && lastIdx >= 0 && e.kind === "use" && e.name === "Bash") {
      if (exercised.test(e.cmd)) sawExercised = true;      // a runner / real render-observe -> exercised
      else if (dataOnly.test(e.cmd)) sawDataOnly = true;   // a data read only
    }
  });
  if (lastIdx < 0) return null;                 // no render-feeding source edited
  if (sawExercised) return null;                // the render was exercised -> allow
  if (!sawDataOnly) return null;                // no data-only probe either -> commit tripwire owns it
  return { editedFile: lastFile };
}

function renderReason(editedFile) {
  return (
    "TRIPWIRE (producer-without-render-receipt): you are about to `git commit`, but the last " +
    "render-feeding source edit this session (" + (editedFile || "a render source") + ") was " +
    "verified only by a DATA read (a query / curl / data-form `receipts observe`) - nothing read " +
    "the RENDERED surface it feeds. A value can exist in the data and be dropped by the " +
    "render/mapping layer, so a data-side read is the wrong observable for a display change " +
    "(Gates G1 render-count parity, G4 right surface, G6 twins). Do ONE of:\n" +
    "  - read the RENDERED surface - a browser / component-render test, a rendered-PDF check, or " +
    "`receipts observe --url ...` - asserting the value AND, for a collection, the row COUNT " +
    "(rendered_count == source_count), then re-run the commit; or\n" +
    "  - if this edit genuinely does not affect a rendered surface, re-run the commit carrying an " +
    "EXPLICIT ack: prepend `RECEIPTS_ACK='<why no render check>'`, or add `--no-verify-receipts`."
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

// Match the file by its full path if the runner printed it, else by basename. Basename-only is
// still conservative: it must appear in a result line that ALSO carries a fail token. The matcher
// is built BEFORE the transcript is parsed, so parseTranscript keeps only the lines that name it.
function fileMatcher(editedFile) {
  const base = basename(editedFile);
  return base ? new RegExp(escapeRe(editedFile) + "|" + escapeRe(base)) : null;
}

function g11LiveTripwire(events, editedFile) {
  if (!editedFile || !TEST_PATH.test(editedFile)) return null; // only guards edits to TEST files
  let sawFailingForFile = false;
  for (const e of events) {
    if (e.kind !== "result") continue;
    // Line-scoped: the file token and a fail/pass token on the SAME line (a runner's per-file
    // status line), so an unrelated FAIL elsewhere in a long log does not bind to this file.
    for (const line of e.lines) {
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

// The interview is four questions only a human can answer. Relaying them is the agent's job.
function initUnattendedReason() {
  return (
    "`receipts init --yes` SKIPS the reachability interview, and detection cannot find any of " +
    "what it asks. Those four answers are the ONLY thing that lets a gate refuse an " +
    "'auth-walled, could not verify' downgrade later - skipping them writes " +
    "drive.confirmed=false and answers on the human's behalf with 'unknown'.\n\n" +
    "ASK THE HUMAN these four, then run `receipts init` (no --yes) and enter their answers:\n" +
    "  1. How does an agent REACH a signed-in state on the verify environment? " +
    "(test account / dev bypass / none needed)\n" +
    "  2. Any dev-mode shortcut that makes it reachable? (fixed OTP, seeded login, magic link, flag)\n" +
    "  3. Does that environment carry realistic data, or must a surface be seeded first?\n" +
    "  4. Any surfaces that must be driven in a BROWSER rather than by API? (rendered PDFs, print views)\n\n" +
    "Genuinely unattended (CI / a scripted provision)? Set CI=1 and this allows the --yes. " +
    "Or carry an explicit RECEIPTS_ACK=<why nobody can be asked> in the command."
  );
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

  // ---- commit tripwires (Bash `git commit`) --------------------------------------------
  // warn mode is an intentional no-op at PreToolUse (no reliable agent-visible warn channel);
  // deny is the enforcing mode. commit-without-verification defaults deny; the render tripwire
  // defaults off (opt-in: it needs the project to declare render surfaces).
  if (toolName === "Bash") {
    const command = String(sget(toolInput, "command") || "");
    // Unattended init: checked BEFORE the commit early-return, which lets every non-commit
    // Bash command through. CI is the one legitimate caller of --yes; there, nobody can be asked.
    // --drive-* means the questions WERE put to a human and the answers are being relayed
    // (an agent cannot drive init's readline, so this is the supported path) - not a skip.
    const relayedAnswers = /--drive-(?:auth|bypass|data|browser-surfaces)\b/.test(command);
    if (INIT_UNATTENDED.test(withoutHeredocBodies(command)) && !relayedAnswers && !ACK_TAG.test(command) && !process.env.CI &&
        tripwireMode(cfg, "init_unattended", "deny") === "deny") {
      deny(initUnattendedReason()); return;
    }
    if (!GIT_COMMIT.test(withoutHeredocBodies(command))) return;             // not a commit -> allow
    const commitMode = tripwireMode(cfg, "commit_unverified", "deny");
    const renderMode = tripwireMode(cfg, "render_unverified", "off");
    if (commitMode !== "deny" && renderMode !== "deny") return;   // nothing to enforce
    if (ACK_TAG.test(command)) return;                 // one explicit escape covers both -> allow
    if (!tp) return;                                   // no transcript -> fail safe (allow)
    let events;
    try { events = await parseTranscript(tp, { fileRe: null }); } catch { return; }
    if (!events) return;
    if (commitMode === "deny") {                        // "nothing ran the code" - the fundamental miss
      let hit = null;
      try { hit = commitTripwire(events, testCmdMatcher(cfg)); } catch { return; }
      if (hit) { deny(commitReason(hit.editedFile)); return; }
    }
    if (renderMode === "deny") {                        // verified, but data-only against a render edit
      let rhit = null;
      try {
        rhit = renderTripwire(events, renderSourceMatcher(cfg), dataOnlyMatcher(), renderExercisedMatcher(cfg));
      } catch { return; }
      if (rhit) { deny(renderReason(rhit.editedFile)); return; }
    }
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
    const fileRe = fileMatcher(file);
    if (!fileRe) return;
    let events;
    try { events = await parseTranscript(tp, { fileRe }); } catch { return; }
    if (!events) return;
    let hit = null;
    try { hit = g11LiveTripwire(events, file); } catch { return; }
    if (hit && mode === "deny") deny(g11Reason(hit.editedFile));
    return;
  }
  // any other tool -> allow (emit nothing)
}

// Parse the transcript JSONL into an ordered, COMPACT event stream (tool_use + the tool_result
// lines under scrutiny - see walkEvents). Streamed line by line: this hook runs on every commit
// and every test-file edit, and a long session's transcript runs to hundreds of MB, so it must
// never hold the file (or its parsed objects) whole. Returns null on IO failure (caller fails
// safe = allow).
async function parseTranscript(tp, opts) {
  const events = [];
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(tp, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let entry;
      try { entry = JSON.parse(t); } catch { continue; }
      try { walkEvents(entry, events, opts); } catch { /* fail safe */ }
    }
  } catch { return null; }
  return events;
}

main().catch(() => { /* a hook must never crash the pre-tool step */ });
