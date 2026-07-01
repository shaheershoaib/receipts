/*
 * Store resolution - where the memory lives decides WHO it serves:
 *   home (default)  ~/.claude/mcp-servers/trajectory-kb/data/trajectories.jsonl -
 *                   private, per-machine, aggregates across every repo you work in.
 *   repo            <repo>/.receipts/trajectories.jsonl - committed with the code, so
 *                   the whole TEAM inherits every trap and dead end (teammate B sees
 *                   teammate A's wrong-surface trap). Append-only JSONL merges trivially.
 *
 * Picked via `agent.trajectory_store` in receipts.config.json ("home" | "repo" | an
 * explicit path resolved against the config's directory), walked up from the server's
 * cwd (Claude Code launches plugin MCP servers at the project root). The
 * RECEIPTS_TRAJECTORY_STORE env var overrides everything (tests, one-off redirection).
 *
 * Dependency-free on purpose: testable without the MCP SDK installed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME_STORE = path.join(os.homedir(), ".claude/mcp-servers/trajectory-kb/data/trajectories.jsonl");

export function resolveStore(startDir, env = process.env) {
  if (env.RECEIPTS_TRAJECTORY_STORE) return path.resolve(env.RECEIPTS_TRAJECTORY_STORE);
  let d = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 40; i++) {
    let cfg = null;
    try { cfg = JSON.parse(readFileSync(path.join(d, "receipts.config.json"), "utf8")); }
    catch (e) { if (e && e.code !== "ENOENT") return HOME_STORE; /* unreadable -> fail safe */ }
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
