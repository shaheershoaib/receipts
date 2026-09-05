/*
 * The one place the hooks resolve receipts.config.json.
 *
 * Agent-home (~/.claude/receipts.config.json) is the base and the nearest project config,
 * walked up from the session cwd, merges over it - the split topology (skills + session cwd
 * separate from the code repos) works through the home layer. `found` says whether EITHER
 * layer exists, and it is the opt-in every hook keys enforcement on: no config anywhere means
 * no tripwires, no Stop gate, no memory injection.
 *
 * Three hooks used to carry copies of these functions ("copied, not imported"), and G15 names
 * that shape: two copies of one fact agree the day they are written and drift afterwards.
 * Behaviour-free and dependency-free, so importing it couples a hook to nothing but this rule.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// null if absent; {} if present-but-unreadable (signals "found" so the walk-up stops and the
// caller fails safe to its generic defaults, never crashes).
export function readConfigFile(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return e && e.code === "ENOENT" ? null : {}; }
}

export function deepMerge(base, over) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
      ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function loadReceiptsConfig(start) {
  const homeRaw = readConfigFile(path.join(os.homedir(), ".claude", "receipts.config.json"));
  let proj = null;
  let d = path.resolve(start || ".");
  for (let i = 0; i < 40; i++) {
    const c = readConfigFile(path.join(d, "receipts.config.json"));
    if (c !== null) { proj = c; break; }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return { cfg: deepMerge(homeRaw || {}, proj || {}), found: homeRaw !== null || proj !== null };
}
