#!/usr/bin/env node
/**
 * One-off (idempotent) backfill: stamp `surface_key` onto every existing
 * trajectory entry that lacks one, so the pre-v1.1 corpus is groupable too.
 * Derivation MUST match deriveSurfaceKey() in index.js. Safe to re-run (only
 * touches entries without a surface_key). Make a backup before running.
 *
 *   cp data/trajectories.jsonl data/trajectories.jsonl.bak-<ts>
 *   node backfill-surface-key.mjs
 */
import fs from "fs";
import path from "path";
import os from "os";

const STORE = path.join(os.homedir(), ".claude/mcp-servers/trajectory-kb/data/trajectories.jsonl");

function normKey(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  return s ? [s] : [];
}
function deriveSurfaceKey(src = {}) {
  if (src.surface_key && String(src.surface_key).trim()) return normKey(src.surface_key);
  const s = String(src.surface || "").trim();
  if (s) {
    const cut = s.search(/\s\(|\s\|\s|\s\+\s|\s->\s/);
    return normKey(cut >= 0 ? s.slice(0, cut) : s);
  }
  const f = asList(src.files);
  return f.length ? normKey(f[0]) : null;
}

const raw = fs.readFileSync(STORE, "utf8");
const out = [];
let changed = 0, total = 0, distinct = new Set();
for (const line of raw.split("\n")) {
  const t = line.trim();
  if (!t) continue;
  total++;
  let e;
  try {
    e = JSON.parse(t);
  } catch {
    out.push(t); // keep a corrupt line verbatim
    continue;
  }
  if (!e.surface_key) {
    e.surface_key = deriveSurfaceKey(e);
    changed++;
  }
  if (e.surface_key) distinct.add(e.surface_key);
  out.push(JSON.stringify(e));
}
fs.writeFileSync(STORE, out.join("\n") + "\n");
console.log(`backfilled surface_key on ${changed}/${total} entries; ${distinct.size} distinct keys`);
