#!/usr/bin/env node
/*
 * Stop hook: BOTH backstops in one transcript pass.
 *
 *   1. VERIFICATION GATE - block an UNVERIFIED "fixed" close-out: a ticket moved to a
 *      fixed status without, after the last merge, BOTH a deploy-binding (you are
 *      pointed at the deployed build) AND an observation (you saw the rendered
 *      value/state). Arriving is not verifying.
 *   2. TRAJECTORY REMINDER - nudge an append_trajectory at a loop exit (clean close-out
 *      OR an honest downgrade / Won't-Fix), so the memory captures failures too.
 *
 * One Node script replaces the two former python3 hooks (stop-verification-gate.py,
 * stop-trajectory-reminder.py): the plugin already requires Node for its MCP server, so
 * this removes the second runtime (python3 is not a given on Windows) and parses the
 * transcript ONCE instead of twice per stop-cycle. If both checks fire, ONE decision is
 * emitted with both reasons.
 *
 * Detection is STRUCTURAL + ORDERED (real tool_use events + their fields, command
 * boundaries): naming a loop skill inside another skill's args, or "gh pr merge" as
 * printf DATA, must not count. Configured fixed-statuses are matched as JSON string
 * VALUES (`: "Pending Retest"`), never as substrings of the whole payload - a ticket
 * COMMENT that merely mentions a status must not read as a close-out (the old
 * substring check could false-fire there). Fails SAFE on any parse problem: a missed
 * nudge beats a spurious block.
 *
 * Project specifics come from receipts.config.json - the agent-home
 * (~/.claude/receipts.config.json) as the base, the nearest project config (walked up
 * from the session cwd) merged over it. Zero-config still works via generic defaults.
 *
 * Input: Stop-hook JSON on stdin ({transcript_path, cwd, stop_hook_active, ...}).
 * Output: {"decision":"block","reason":...} when a check fires; nothing otherwise.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- shared matchers

// `gh pr merge` / `gh issue close` only at a command boundary, so a printf/grep that
// CONTAINS the string as data does not match.
const GH_MERGE = /(?:^|[;&|]|\n)\s*gh\s+pr\s+merge\b/;
const GH_ISSUE_CLOSE = /(?:^|[;&|]|\n)\s*gh\s+issue\s+close\b/;

// Tracker-agnostic close-out NAME shapes: update/transition/resolve/close on an
// issue/ticket/task/story/card/page/item across Notion, Linear, Jira, GitHub, etc.
const TRACKER_WRITE = /(update|set|edit|patch|transition|move|resolve|close)[-_ ]?(issue|ticket|task|story|card|page|item|bug|work[-_ ]?item)/i;
const TRACKER_CLOSE = /(close|resolve)[-_ ]?(issue|ticket|task|bug|item|story|card)/i;
// A Status/State KEY set to a generic closeout VALUE (anchored on the key, so a
// "1. Fixed the..." Resolution Note does not match - that is a different key).
const CLOSEOUT_STATUS = /"(?:bug\s+)?(?:status|state)"\s*:\s*"\s*(?:fixed|closed|verified|done|resolved|complete|completed)\b/i;

// Generic default matcher SOURCES; receipts.config.json extends them per project.
const DEFAULT_DEPLOYED_HOST_SRC =
  "\\.vercel\\.app|\\.railway\\.app|\\.up\\.railway\\.app|\\.netlify\\.app|\\.fly\\.dev|" +
  "\\.onrender\\.com|\\.pages\\.dev|stg\\.|staging|\\.preview\\.";
const DEFAULT_STAGING_QUERY_SRC = "STAGING_DB_URL|DATABASE_URL|db[_-]?proxy|mysql_query|psql";
const DEFAULT_DOWNGRADE_SRC = "unverified[- ]?reasoned|unverified|speculative";
const DEFAULT_FIXED_STATUSES = ["Pending Retest", "Verified"];
const DEFAULT_LOOP_SKILLS = ["gates"];

// A SCREENSHOT of the rendered build / a BY-VALUE read of the rendered DOM/state (G1).
const SCREENSHOT_TOOL = /screenshot|gif_creator/i;
const DOM_READ_TOOL = /read_page|get_page_text|javascript_tool|preview_snapshot|preview_eval|preview_inspect|evaluate_script|browser_snapshot|browser_evaluate|take_snapshot/i;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ------------------------------------------------------------------- config load

function readConfigFile(p) {
  // null if absent; {} if present-but-unreadable (signals "found" so the walk-up
  // stops; fail-safe to generics, never crash).
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
  // Agent-home as the base, nearest project config merged over - the split-repo
  // topology (skills + session cwd separate from the code repos) works via the home layer.
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

// "*.vercel.app" -> "\.vercel\.app" (glob prefix dropped, rest escaped as substring).
function globToSubstr(g) {
  g = String(g || "").trim();
  if (g.startsWith("*")) g = g.slice(1);
  return escapeRe(g);
}
function extend(defaultSrc, extra) {
  const parts = [defaultSrc, ...(extra || []).filter((p) => String(p || "").trim()).map(globToSubstr)];
  return new RegExp(`(?:${parts.join("|")})`, "i");
}

function gateOn(gates, gid) {
  if (!gates) return true;
  if ((gates.disabled || []).includes(gid)) return false;
  const en = gates.enabled;
  if (!en || en === "all") return true;
  return Array.isArray(en) ? en.includes(gid) : true;
}

// -------------------------------------------------------------- transcript parse

function walkToolUses(obj, out) {
  if (Array.isArray(obj)) { for (const v of obj) walkToolUses(v, out); return; }
  if (obj && typeof obj === "object") {
    if (obj.type === "tool_use" && "name" in obj) out.push([String(obj.name || ""), obj.input ?? {}]);
    for (const v of Object.values(obj)) walkToolUses(v, out);
  }
}

const sget = (inp, key) => (inp && typeof inp === "object" && !Array.isArray(inp) ? inp[key] : undefined);
const txt = (inp) => (typeof inp === "string" ? inp : JSON.stringify(inp));

// ------------------------------------------------------- verification-gate pieces

function makeMatchers(cfg) {
  const agent = cfg.agent || {};
  const build = cfg.build && typeof cfg.build === "object" && !Array.isArray(cfg.build) ? cfg.build : {};
  const claim = cfg.claim || {};
  const statuses = (agent.closeout_fixed_statuses || DEFAULT_FIXED_STATUSES).filter(Boolean);
  return {
    deployedHost: extend(DEFAULT_DEPLOYED_HOST_SRC, build.deploy_host_patterns),
    stagingQuery: extend(DEFAULT_STAGING_QUERY_SRC, agent.staging_query_patterns),
    downgrade: extend(DEFAULT_DOWNGRADE_SRC, claim.downgrade_tags),
    // ANCHORED: the configured status must appear at the START of a JSON string
    // VALUE (`: "Pending Retest"`), covering flat ({"status": "..."}), nested
    // (Notion {"select": {"name": "..."}}) shapes, decorated values (a leading
    // emoji/symbol pill like ": \"[x] Pending Retest\"") and a trailing note
    // (": \"Pending Retest - awaiting tester\"") - but NOT a status mentioned
    // mid-prose inside a longer comment string ("moved to Pending Retest
    // earlier"), which has WORD characters between the opening quote and the
    // status and so does not match.
    statusValue: new RegExp(
      `:\\s*"[^"a-zA-Z0-9]*(?:${statuses.map(escapeRe).join("|")})(?![a-zA-Z0-9])`,
      "i",
    ),
  };
}

function isFixedCloseout(name, inp, m) {
  if (name === "Bash" && GH_ISSUE_CLOSE.test(String(sget(inp, "command") || ""))) return true;
  if (!TRACKER_WRITE.test(name || "")) return false;
  if (TRACKER_CLOSE.test(name || "")) return true; // closing/resolving IS the fixed signal
  const s = txt(inp);
  return m.statusValue.test(s) || CLOSEOUT_STATUS.test(s);
}

function isMerge(name, inp) {
  if (name.toLowerCase().includes("merge_pull_request")) return true;
  return name === "Bash" && GH_MERGE.test(String(sget(inp, "command") || ""));
}

function isDeployBinding(name, inp, m) {
  // Evidence you are POINTED AT the deployed build (not which value you saw).
  const n = name.toLowerCase();
  if (n.includes("navigate") && m.deployedHost.test(String(sget(inp, "url") || ""))) return true;
  if (n.includes("claude_preview") || n.includes("preview_")) return true;
  if (n.includes("get_deployment")) return true;
  if (n.includes("mysql_query")) return true;
  if (name === "Bash" && m.stagingQuery.test(String(sget(inp, "command") || ""))) return true;
  // browser_batch wraps its real actions in input.actions - a batched navigate to a
  // deployed host is the same binding as a top-level one.
  if (n.includes("browser_batch")) {
    const actions = txt(inp);
    if (actions.includes("navigate") && m.deployedHost.test(actions)) return true;
  }
  return false;
}

function isObservation(name, inp, m) {
  // Evidence you OBSERVED the rendered value/state (not just arrived).
  const n = name.toLowerCase();
  if (SCREENSHOT_TOOL.test(n)) return true;
  if (DOM_READ_TOOL.test(n)) return true;
  if (n.includes("computer") && txt(inp).toLowerCase().includes("screenshot")) return true;
  if (n.includes("mysql_query")) return true;
  if (name === "Bash" && m.stagingQuery.test(String(sget(inp, "command") || ""))) return true;
  // A batched screenshot / DOM-read counts exactly like a top-level one (the recurring
  // false-positive: the live verify was driven via browser_batch and the hook fired).
  if (n.includes("browser_batch")) {
    const actions = txt(inp);
    if (SCREENSHOT_TOOL.test(actions) || DOM_READ_TOOL.test(actions)) return true;
  }
  return false;
}

function verificationGate(seq, cfg, m) {
  // Stand down when THIS repo has no URL-deployed build to observe: an explicit
  // library/CLI/artifact build block, or G1/G3 disabled. A config with NO build block
  // (an agent-home) keeps enforcing - the split topology's code repos deploy elsewhere.
  const gates = cfg.gates || {};
  if (cfg.build && typeof cfg.build === "object" && !Array.isArray(cfg.build)) {
    const explicitNoUrl = ["none", "ci-artifact"].includes(cfg.build.sha_source);
    if (explicitNoUrl || !(gateOn(gates, "G1") && gateOn(gates, "G3"))) return null;
  }

  let lastCloseout = -1;
  let lastCloseoutDowngraded = false;
  const mergeIdxs = [], bindingIdxs = [], obsIdxs = [];
  seq.forEach(([name, inp], i) => {
    if (isMerge(name, inp)) mergeIdxs.push(i);
    if (isDeployBinding(name, inp, m)) bindingIdxs.push(i);
    if (isObservation(name, inp, m)) obsIdxs.push(i);
    if (isFixedCloseout(name, inp, m)) {
      lastCloseout = i;
      lastCloseoutDowngraded = m.downgrade.test(txt(inp));
    }
  });

  if (lastCloseout < 0) return null; // nothing was claimed fixed this session
  if (lastCloseoutDowngraded) return null; // honestly flagged as unverified -> allowed

  // Require, AFTER the merge that shipped THIS fix and at/before the close-out, BOTH a
  // deploy-binding AND an observation. The relevant merge is the LAST one BEFORE the
  // close-out - a later merge belongs to other work and must not retroactively
  // invalidate an already-verified close-out.
  const floor = Math.max(-1, ...mergeIdxs.filter((x) => x < lastCloseout));
  const hasBinding = bindingIdxs.some((e) => floor < e && e <= lastCloseout);
  const hasObs = obsIdxs.some((e) => floor < e && e <= lastCloseout);
  if (hasBinding && hasObs) return null; // bound AND observed -> allowed

  const gap = hasBinding && !hasObs
    ? "you reached the deployed build (a navigate / get_deployment) but never OBSERVED " +
      "the value there. Arriving is not verifying: a navigate proves you got there, " +
      "get_deployment proves the sha is live - neither shows the reporter's symptom " +
      "GONE. Capture the proof: take a screenshot AND read the rendered value by DOM " +
      "(javascript_tool / read_page) on the deployed app, or for a data ticket run a " +
      "by-value staging query."
    : "this session shows NO by-value verification on the DEPLOYED build after the " +
      "merge. Drive the reporter's exact flow on the deployed app and OBSERVE the " +
      "result, do not stop at CI-green / a passing test / a code or DB read.";
  return (
    "A ticket was moved to a fixed status, but " + gap + " " +
    "(the Gates G0/G1/G3). Before stopping, either: (a) BEHAVIOR/UI ticket -> " +
    "drive the reporter's exact flow on the deployed app (a real browser on your " +
    "staging / production URL), then SCREENSHOT it and read the rendered value; " +
    "or (b) DATA/seed ticket -> run a by-value staging query (DB proxy / API) and a " +
    "get_deployment sha-confirm; or (c) if you truly cannot observe it (NOT 'my first " +
    "try failed', and NEVER for a surface reachable by clicking a visible button), " +
    "re-open the close-out note with an explicit 'unverified-reasoned: <why " +
    "unobservable + the unit test covering it>' tag and route it to the reporter. " +
    "Cite the observed value in the close-out note. Then stop."
  );
}

// ------------------------------------------------------ trajectory-reminder pieces

function exitDispositionRe(tags) {
  // Hyphen/space tolerance: "unverified-reasoned" also matches "unverified reasoned"
  // (or fused), "won't fix" also matches across any whitespace run. escapeRe leaves
  // `-` and ` ` unescaped, so transform those literals AFTER escaping - spaces first
  // (`\s+`), then hyphens (`[- ]?`; the class's own space is inserted after the space
  // pass, so the two replacements cannot interact).
  const alts = tags.filter(Boolean).map((t) => escapeRe(t).replace(/ /g, "\\s+").replace(/-/g, "[- ]?"));
  return alts.length ? new RegExp(alts.join("|"), "i") : /(?!x)x/;
}

function trajectoryReminder(seq, cfg, m) {
  const agent = cfg.agent || {};
  const claim = cfg.claim || {};
  const loops = agent.loop_skills || DEFAULT_LOOP_SKILLS;
  const exitRe = exitDispositionRe([...(claim.downgrade_tags || ["unverified-reasoned", "speculative", "reverted"]), "won't fix"]);

  const isLoop = (name, inp) => name === "Skill" && loops.includes(sget(inp, "skill"));
  const isCloseout = (name, inp) => {
    const n = name.toLowerCase();
    if (n.includes("merge_pull_request")) return true;
    if (name === "Bash" && GH_MERGE.test(String(sget(inp, "command") || ""))) return true;
    if (name === "Bash" && GH_ISSUE_CLOSE.test(String(sget(inp, "command") || ""))) return true;
    if (TRACKER_WRITE.test(name || "")) {
      if (TRACKER_CLOSE.test(name || "")) return true;
      const s = txt(inp);
      return m.statusValue.test(s) || exitRe.test(s) || CLOSEOUT_STATUS.test(s);
    }
    return false;
  };

  let loopSeen = false, lastCloseout = -1, lastAppend = -1;
  seq.forEach(([name, inp], i) => {
    if (isLoop(name, inp)) loopSeen = true;
    if (isCloseout(name, inp)) lastCloseout = i;
    if (name.toLowerCase().includes("append_trajectory")) lastAppend = i;
  });

  if (!(loopSeen && lastCloseout >= 0 && lastAppend < lastCloseout)) return null;
  return (
    "A fix/build loop ran and reached an exit (close-out: PR merge / ticket moved to " +
    "Fixed / Verified, OR a downgrade / Won't-Fix), but no " +
    "trajectory-kb entry was recorded afterward. Per the gates skill, at close-out call " +
    "mcp__trajectory-kb__append_trajectory({repo, surface, symptom, root_cause, " +
    "outcome, what_worked, what_failed, files}) now with the HONEST outcome - 'fixed' " +
    "for a clean fix, or 'unverified-reasoned' / 'speculative' / 'reverted' for a " +
    "downgraded, blocked, or backed-out exit (put the dead-end / blocker in " +
    "what_failed; those failure entries are what stop the next loop hitting the same " +
    "wall) - OR briefly state why it does not apply (e.g. the loop is genuinely " +
    "mid-flight and paused, not exited). Then stop."
  );
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
  if (payload.stop_hook_active) return; // already nudged this stop-cycle; never loop
  const tp = payload.transcript_path;
  if (!tp) return;

  const cfg = loadReceiptsConfig(payload.cwd);
  const m = makeMatchers(cfg);

  let lines;
  try { lines = fs.readFileSync(tp, "utf8").split("\n"); }
  catch { return; }

  // ONE parse of the transcript feeds both checks.
  const seq = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { walkToolUses(JSON.parse(t), seq); } catch { /* skip a corrupt line */ }
  }
  if (!seq.length) return; // no structured tool calls -> fail safe

  const reasons = [];
  try { const r = verificationGate(seq, cfg, m); if (r) reasons.push(r); } catch { /* fail safe */ }
  try { const r = trajectoryReminder(seq, cfg, m); if (r) reasons.push(r); } catch { /* fail safe */ }
  if (reasons.length)
    process.stdout.write(JSON.stringify({ decision: "block", reason: reasons.join("\n\n--- also ---\n\n") }) + "\n");
}

main().catch(() => { /* a hook must never crash the stop-cycle */ });
