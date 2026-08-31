#!/usr/bin/env node
/*
 * SessionStart hook: MEMORY THAT PUSHES.
 *
 * The trajectory-kb only helped an agent that thought to QUERY it. A weak agent - the
 * exact one that repeats a wrong-surface trap - never asks. This hook flips that: at
 * session start it reads the trajectory store, picks the handful of prior attempts most
 * worth knowing in THIS repo (failures first - a dead end is the payload), and injects
 * them into the agent's context as `additionalContext`. The agent arrives already
 * warned, without a single tool call.
 *
 * It is a READER of the same JSONL the MCP server writes; it never writes. It resolves
 * the store EXACTLY like the server (home + optional repo via `agent.trajectory_store`,
 * walked up from cwd) and mirrors the config walk-up the Stop hook uses (the minimal
 * functions are copied in, not imported - this file must not couple to stop-gates.mjs
 * or store.mjs).
 *
 * DEFAULT-ON only when a receipts.config.json is found on the walk-up. A repo with NO
 * receipts config gets ZERO behavior change (no injection, no noise) - a receipts-less
 * project should not suddenly grow context it never opted into. `agent.memory_inject`
 * ("on" | "off") tunes it; default is ON when a config is present.
 *
 * HARD budget: the injected text is capped (~1500 chars) because it loads into EVERY
 * session - it must be tiny. Empty store / no repo match / any error -> emit NOTHING
 * (fail-open, zero noise): a missed nudge beats a spurious wall of text.
 *
 * Input:  SessionStart JSON on stdin ({ session_id, transcript_path, cwd, source }).
 * Output: {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
 *         printed to stdout when there is something to say; nothing otherwise. Exit 0 always.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ------------------------------------------------------------------ hard budgets
const TOTAL_CAP = 1500; // absolute ceiling on additionalContext (loads into EVERY session)
const MAX_ENTRIES = 5; // at most this many prior attempts
const FAILLINE_CAP = 200; // truncate the first what_failed line to this

// --------------------------------------------------------- config resolution (copied)
// Mirrors stop-gates.mjs's loadReceiptsConfig / deepMerge (copied, not imported, so this
// hook does not couple to that file). Home config as the base, nearest project config
// (walked up from cwd) merged over. Returns { cfg, configFound }: configFound is true iff
// a project-level receipts.config.json was located on the walk-up - the gate for
// default-on. (A home-only config is treated as "found" too: an agent-home IS an opt-in.)

function readConfigFile(p) {
  // null if absent; {} if present-but-unreadable (signals "found" so the walk-up stops
  // and we fail safe to defaults, never crash).
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return e && e.code === "ENOENT" ? null : {};
  }
}

function deepMerge(base, over) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
        ? deepMerge(out[k], v)
        : v;
  }
  return out;
}

function loadConfig(start) {
  const homePath = path.join(os.homedir(), ".claude", "receipts.config.json");
  const homeRaw = readConfigFile(homePath);
  const home = homeRaw || {};
  let proj = null;
  let d = path.resolve(start || ".");
  for (let i = 0; i < 40; i++) {
    const c = readConfigFile(path.join(d, "receipts.config.json"));
    if (c !== null) {
      proj = c;
      break;
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  // "found" = a project config on the walk-up OR a home config. Either is a deliberate
  // opt-in; a repo with NEITHER gets zero behavior change.
  const configFound = proj !== null || homeRaw !== null;
  return { cfg: deepMerge(home, proj || {}), configFound };
}

// ---------------------------------------------------------- store resolution (mirrors store.mjs)
// Home by default; `agent.trajectory_store` ("home" | "repo" | explicit path) redirects,
// resolved against the directory that holds the config on the walk-up. RECEIPTS_TRAJECTORY_STORE
// overrides everything (tests, one-off redirection) - identical to the server.

const HOME_STORE = path.join(os.homedir(), ".claude/mcp-servers/trajectory-kb/data/trajectories.jsonl");

function resolveStore(startDir, env) {
  env = env || process.env;
  if (env.RECEIPTS_TRAJECTORY_STORE) return path.resolve(env.RECEIPTS_TRAJECTORY_STORE);
  let d = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 40; i++) {
    let cfg = null;
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(d, "receipts.config.json"), "utf8"));
    } catch (e) {
      if (e && e.code !== "ENOENT") return HOME_STORE; // unreadable -> fail safe to home
    }
    if (cfg) {
      const want = cfg.agent && cfg.agent.trajectory_store;
      if (!want || want === "home") return HOME_STORE;
      if (want === "repo") return path.join(d, ".receipts", "trajectories.jsonl");
      return path.resolve(d, String(want));
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return HOME_STORE;
}

// ---------------------------------------------------------------- repo identity
// The store's `repo` is a free string the agent supplied per append (e.g. "example-app").
// To match "the CURRENT repo" we build the same candidate names the rest of receipts uses:
// the config's canonical tag (agent.repo_name - what the appends are told to use), the git
// remote basename, package.json name, and the directory basename (bin/receipts.js line 143
// uses `pkg.name || basename(dir)`). Match is case-insensitive against any candidate, so a
// slightly-differently-cased or remote-vs-dir name still lines up.

function gitRemoteBasename(cwd) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!url) return null;
    // strip trailing slash + .git, take the last path/scp segment
    const cleaned = url.replace(/\/+$/, "").replace(/\.git$/i, "");
    const seg = cleaned.split(/[/:]/).filter(Boolean).pop();
    return seg || null;
  } catch {
    return null;
  }
}

function repoCandidates(cwd) {
  const out = [];
  const push = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (s) out.push(s);
  };
  // config tag (walk up for the nearest receipts.config.json's agent.repo_name)
  let d = path.resolve(cwd || ".");
  for (let i = 0; i < 40; i++) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(d, "receipts.config.json"), "utf8"));
      if (c && c.agent && c.agent.repo_name) push(c.agent.repo_name);
      break;
    } catch (e) {
      if (e && e.code !== "ENOENT") break;
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  push(gitRemoteBasename(cwd));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (pkg && pkg.name) push(pkg.name);
  } catch {
    /* no package.json */
  }
  push(path.basename(path.resolve(cwd || ".")));
  return [...new Set(out)];
}

// ------------------------------------------------------------------- store read
function readEntries(storePath) {
  let raw;
  try {
    raw = fs.readFileSync(storePath, "utf8");
  } catch {
    return []; // no store yet -> nothing to inject
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* tolerate a corrupt line, like the server's readAll */
    }
  }
  return out;
}

const firstStr = (v) => {
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = String(x || "").trim();
      if (s) return s;
    }
    return "";
  }
  return String(v || "").trim();
};

// Superseding entries retire the ones they correct - never surface a superseded attempt.
function supersededIds(all) {
  const s = new Set();
  for (const e of all) if (e && e.supersedes) s.add(e.supersedes);
  return s;
}

// ---------------------------------------------------------------- selection
// Up to MAX_ENTRIES, biased to the PAYLOAD (failures) and de-duplicated per surface_key:
//   1. drop superseded entries and entries with no failure signal AND a clean outcome
//      last, i.e. RANK: (a) failures first - outcome != "fixed" OR a non-empty what_failed;
//      (b) most recent within that.
//   2. one per surface_key (the recurrence group) - the most-relevant of each key wins,
//      so five DIFFERENT traps beat five re-tellings of one.
function selectEntries(entries, candidates) {
  const superseded = supersededIds(entries);
  const cand = new Set(candidates);
  const mine = entries.filter((e) => {
    if (!e || typeof e !== "object") return false;
    if (e.id && superseded.has(e.id)) return false;
    const repo = String(e.repo || "").trim().toLowerCase();
    return repo && cand.has(repo);
  });
  if (!mine.length) return [];

  const isFailure = (e) => (e.outcome && e.outcome !== "fixed") || firstStr(e.what_failed).length > 0;
  const ts = (e) => String(e.ts || "");
  // Sort: failures first, then most-recent. Stable enough for our purpose.
  mine.sort((a, b) => {
    const fa = isFailure(a) ? 0 : 1;
    const fb = isFailure(b) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return ts(b).localeCompare(ts(a));
  });

  // Dedupe by surface_key (fall back to a per-entry unique token when a key is absent, so
  // key-less entries are NOT all collapsed into one bucket).
  const seenKey = new Set();
  const picked = [];
  for (const e of mine) {
    const key = String(e.surface_key || "").trim().toLowerCase() || ` ${e.id || picked.length}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    picked.push(e);
    if (picked.length >= MAX_ENTRIES) break;
  }
  return picked;
}

// ---------------------------------------------------------------- render
const truncate = (s, n) => {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
};

// A compact block: a header + 2-3 lines per entry. HARD-capped at TOTAL_CAP: entries are
// appended whole and the FIRST that would breach the cap stops the loop (so we never emit a
// half-line). At least the header + one entry always fit (an entry is bounded well under the cap).
function render(entries) {
  if (!entries.length) return "";
  const header = "receipts trajectory memory - prior attempts in this repo (failures first; do not repeat these):";
  const lines = [header];
  let used = header.length + 1;
  for (const e of entries) {
    const keyLabel = String(e.surface_key || e.surface || "(unknown surface)").trim() || "(unknown surface)";
    const outcome = String(e.outcome || "?").trim() || "?";
    const block = [`- ${truncate(keyLabel, 80)}  [${outcome}]`];
    const failed = firstStr(e.what_failed);
    if (failed) block.push(`    dead end: ${truncate(failed, FAILLINE_CAP)}`);
    else {
      // No recorded failure (a clean fix surfaced only because it is recent): show the root
      // cause so the line still teaches something.
      const rc = firstStr(e.root_cause) || firstStr(e.symptom);
      if (rc) block.push(`    ${truncate(rc, FAILLINE_CAP)}`);
    }
    const chunk = block.join("\n");
    if (used + chunk.length + 1 > TOTAL_CAP && lines.length > 1) break;
    lines.push(chunk);
    used += chunk.length + 1;
  }
  let text = lines.join("\n");
  if (text.length > TOTAL_CAP) text = text.slice(0, TOTAL_CAP - 1).trimEnd() + "…";
  return text;
}

// ------------------------------------------------------------------------- main
async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// The reachability answers `receipts init` collected from a human (agent.drive). Injected at
// EVERY session start so the agent uses the recorded way in rather than rediscovering the auth
// wall mid-verification and downgrading to "could not verify". Independent of trajectory
// memories: on a fresh project there are none, which is exactly when these matter most.
const DRIVE_CAP = 500;

// The version of the PLUGIN this hook ships inside. Compared against the version stamped into
// the config by `receipts init`, so an upgrade announces itself instead of relying on the user
// remembering to re-check every repo after every update.
function pluginVersion() {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT ||
      path.join(path.dirname(new URL(import.meta.url).pathname), "..");
    return JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")).version || null;
  } catch { return null; }
}

// One line, once per session, only when the versions actually disagree. Silent when they match,
// so a current project never pays for this.
function upgradeNotice(cfg) {
  const running = pluginVersion();
  if (!running) return "";
  const wrote = (cfg.agent || {}).receipts_version;
  if (wrote === running) return "";
  if (!wrote)
    return `RECEIPTS - this project's receipts.config.json does not record which version wrote ` +
      `it, and you are running ${running}. Run \`receipts doctor\` (npx -y receipts-cli@latest ` +
      `doctor) to see what this version expects that the config predates, and tell the user what ` +
      `it reports - do not silently skip it.`;
  return `RECEIPTS - this project's receipts.config.json was written by version ${wrote}; you are ` +
    `running ${running}. An upgrade can add fields an older config predates. Run \`receipts doctor\` ` +
    `(npx -y receipts-cli@latest doctor), tell the user what it reports, and put any questions it ` +
    `raises to them - a config nobody re-confirmed is how an unverified fix ships wearing an ` +
    `honest downgrade.`;
}
function driveContext(cfg) {
  const d = ((cfg.agent || {}).drive) || {};
  const lines = [
    d.auth && `- auth route: ${d.auth}`,
    d.bypass && `- dev shortcut: ${d.bypass}`,
    d.data && `- data: ${d.data}`,
    (d.browser_surfaces || []).length && `- browser-only surfaces: ${d.browser_surfaces.join(", ")}`,
  ].filter(Boolean);
  if (lines.length)
    return ("RECEIPTS - how to reach an observable state in this project (from " +
      "receipts.config.json). Use these before reporting a surface unreachable:\n" +
      lines.join("\n")).slice(0, DRIVE_CAP);
  if (d.confirmed === false)
    return "RECEIPTS - nobody has recorded how to reach a signed-in state here: `receipts init` " +
      "ran with --yes and skipped the reachability interview. Ask the human for the auth route " +
      "and any dev bypass before reporting a surface unverifiable, and offer to re-run " +
      "`receipts init --force` to record the answers.";
  return "";
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // no/garbage stdin -> silent (fail-open)
  }
  const cwd = payload && payload.cwd ? payload.cwd : process.cwd();

  const { cfg, configFound } = loadConfig(cwd);
  // Zero behavior change for a receipts-less repo: no config anywhere -> emit nothing.
  if (!configFound) return;
  const mode = String(((cfg.agent || {}).memory_inject) || "on").toLowerCase();
  if (mode === "off") return; // explicitly disabled

  const storePath = resolveStore(cwd);
  const entries = readEntries(storePath);
  const candidates = repoCandidates(cwd);
  // Either source can carry the session: recorded trajectories for THIS repo, and/or the
  // project's reachability facts. Previously no trajectories meant no output at all.
  const picked = entries.length && candidates.length ? selectEntries(entries, candidates) : [];
  const memories = picked.length ? render(picked) : "";
  // TOTAL_CAP is the ceiling on the WHOLE injection, not just the memories block - this loads
  // into every session. The upgrade notice and drive facts are bounded and go first (they are
  // the actionable part); memories absorb the truncation.
  const parts = [upgradeNotice(cfg), driveContext(cfg), memories].filter(Boolean);
  let additionalContext = parts.join("\n\n");
  if (additionalContext.length > TOTAL_CAP)
    additionalContext = additionalContext.slice(0, TOTAL_CAP - 1).trimEnd() + "…";
  if (!additionalContext) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }) + "\n",
  );
}

// A hook must never crash the session-start cycle; any failure = silent (fail-open).
main().catch(() => {
  /* fail open: emit nothing */
});
