#!/usr/bin/env node
/**
 * trajectory-kb MCP Server
 *
 * A queryable, append-only store of dev "trajectories" — what was tried on a
 * surface and what happened — so the fix/build loops stop repeating wrong-surface
 * traps and can RETRIEVE relevant past fixes at the start of a new one.
 *
 * Borrowed from Ruflo's "agents learn from past trajectories" idea, but kept lean:
 * append-only JSONL is the source of truth (human-readable, greppable), global and
 * repo-tagged so it aggregates across repos. Structured/keyword query for v1;
 * semantic/embedding retrieval is a deliberate v2.
 *
 * v1.1: every entry carries a canonical `surface_key` (auto-derived) so the same
 * component can be GROUPED across loops - the prerequisite for recurrence-aware
 * retrieval and any future repeat-pain detection. Raw `surface` is free human
 * text and is almost never written identically twice, so it cannot be grouped on.
 *
 * Store: ~/.claude/mcp-servers/trajectory-kb/data/trajectories.jsonl
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

const STORE_DIR = path.join(os.homedir(), ".claude/mcp-servers/trajectory-kb/data");
const STORE = path.join(STORE_DIR, "trajectories.jsonl");

const VALID_OUTCOMES = ["fixed", "unverified-reasoned", "speculative", "reverted"];
const VALID_TIERS = ["top", "cheap", "mixed"];

const nowIso = () => new Date().toISOString();

async function ensureStore() {
  await fs.mkdir(STORE_DIR, { recursive: true });
  try {
    await fs.access(STORE);
  } catch {
    await fs.writeFile(STORE, "");
  }
}

async function readAll() {
  await ensureStore();
  const raw = await fs.readFile(STORE, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip a corrupt line rather than fail the whole read */
    }
  }
  return out;
}

function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  return s ? [s] : [];
}

// Canonical, groupable key for a surface. Recurrence detection + reliable
// retrieval need a STABLE key, but `surface` is free human text that is almost
// never written identically twice (39/40 distinct in a recent sample), so the
// raw field cannot be grouped on. Derivation: an explicit `surface_key` wins;
// else strip the descriptive suffix from `surface` (everything from the first
// " (", " | ", " + ", or " -> "); else fall back to the primary file path.
function normKey(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
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

function supersededIds(all) {
  return new Set(all.map((e) => e.supersedes).filter(Boolean));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

async function appendTrajectory(args) {
  const repo = String(args.repo || "").trim();
  if (!repo) throw new Error("`repo` is required.");
  const outcome = String(args.outcome || "").trim();
  if (!VALID_OUTCOMES.includes(outcome)) {
    throw new Error(`Invalid outcome "${outcome}". Must be one of: ${VALID_OUTCOMES.join(", ")}.`);
  }
  if (args.tier && !VALID_TIERS.includes(args.tier)) {
    throw new Error(`Invalid tier "${args.tier}". Must be one of: ${VALID_TIERS.join(", ")} (or omit).`);
  }
  const entry = {
    id: randomUUID(),
    ts: nowIso(),
    repo,
    surface: String(args.surface || "").trim() || null,
    surface_key: deriveSurfaceKey(args),
    symptom: String(args.symptom || "").trim() || null,
    root_cause: String(args.root_cause || "").trim() || null,
    outcome,
    what_worked: asList(args.what_worked),
    what_failed: asList(args.what_failed),
    files: asList(args.files),
    regressed: asList(args.regressed),
    tier: args.tier || null,
    tags: asList(args.tags),
    supersedes: String(args.supersedes || "").trim() || null,
  };
  await ensureStore();
  await fs.appendFile(STORE, JSON.stringify(entry) + "\n");
  return { ok: true, stored: entry };
}

async function queryTrajectory(args = {}) {
  const all = await readAll();
  const superseded = supersededIds(all);
  const repo = args.repo ? String(args.repo).toLowerCase() : null;
  const surface = args.surface ? String(args.surface).toLowerCase() : null;
  const surfaceKey = args.surface_key ? normKey(args.surface_key) : null;
  const outcome = args.outcome ? String(args.outcome) : null;
  const tag = args.tag ? String(args.tag).toLowerCase() : null;
  const text = args.text ? String(args.text).toLowerCase() : null;
  const includeSuperseded = !!args.include_superseded;
  const limit = Number.isInteger(args.limit) ? args.limit : 20;

  let rows = all.filter((e) => {
    if (!includeSuperseded && superseded.has(e.id)) return false;
    if (repo && String(e.repo || "").toLowerCase() !== repo) return false;
    if (surface && !String(e.surface || "").toLowerCase().includes(surface)) return false;
    if (surfaceKey) {
      // Fall back to deriving the key for entries written before v1.1 / not yet
      // backfilled, so an exact-key query still matches them.
      const ek = e.surface_key || deriveSurfaceKey(e);
      if (normKey(ek || "") !== surfaceKey) return false;
    }
    if (outcome && e.outcome !== outcome) return false;
    if (tag && !(e.tags || []).map((t) => String(t).toLowerCase()).includes(tag)) return false;
    if (text) {
      const hay = [e.symptom, e.root_cause, ...(e.what_worked || []), ...(e.what_failed || [])]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const total = rows.length;
  rows = rows.slice(0, limit);
  return { count: rows.length, total_matches: total, results: rows };
}

async function recentOutcomes(args = {}) {
  const all = await readAll();
  const superseded = supersededIds(all);
  const repo = args.repo ? String(args.repo).toLowerCase() : null;
  const n = Number.isInteger(args.n) ? args.n : 10;
  let rows = all.filter(
    (e) => !superseded.has(e.id) && (!repo || String(e.repo || "").toLowerCase() === repo)
  );
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return { count: Math.min(rows.length, n), results: rows.slice(0, n) };
}

async function listRepos() {
  const all = await readAll();
  const counts = {};
  for (const e of all) counts[e.repo] = (counts[e.repo] || 0) + 1;
  return {
    repos: Object.entries(counts)
      .map(([repo, entries]) => ({ repo, entries }))
      .sort((a, b) => b.entries - a.entries),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "trajectory-kb", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "append_trajectory",
      description:
        "Record what was tried on a surface and what happened, so future loops don't repeat wrong-surface traps. Call at loop close-out AND at any NON-clean exit too - downgraded (unverified-reasoned / speculative), reverted, or left blocked: the failures are the most valuable entries (a success-only store is survivorship bias that blinds retrieval). Put the dead-end / blocker in `what_failed`. Append-only; supports `supersedes` to correct an earlier entry.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repo name, e.g. 'web-app'." },
          surface: { type: "string", description: "Component/route/file the work touched (free human text)." },
          surface_key: { type: "string", description: "Canonical, groupable key (primary file path or a component/route id). Auto-derived from surface/files when omitted; pass it explicitly for reliable recurrence grouping across loops." },
          symptom: { type: "string", description: "The reported/observed symptom." },
          root_cause: { type: "string", description: "The identified root cause." },
          outcome: { type: "string", enum: VALID_OUTCOMES, description: "fixed | unverified-reasoned | speculative | reverted. Record the HONEST outcome - blocked/unverified exits are 'unverified-reasoned' or 'speculative', not omitted." },
          what_worked: { type: ["string", "array"], items: { type: "string" }, description: "What fixed it (string or list)." },
          what_failed: { type: ["string", "array"], items: { type: "string" }, description: "Dead ends / wrong-surface traps / what blocked it (string or list)." },
          files: { type: ["string", "array"], items: { type: "string" }, description: "Files the fix edited - for history-aware tiering and precise joins (string or list)." },
          regressed: { type: ["string", "array"], items: { type: "string" }, description: "Other surfaces/files this fix BROKE - the 'fixing A broke B' coupling signal (string or list)." },
          tier: { type: "string", enum: VALID_TIERS, description: "Model tier used (optional)." },
          tags: { type: ["string", "array"], items: { type: "string" }, description: "Optional tags." },
          supersedes: { type: "string", description: "Id of an earlier entry this corrects (optional)." },
        },
        required: ["repo", "outcome"],
      },
    },
    {
      name: "query_trajectory",
      description:
        "Retrieve past trajectories BEFORE pinning a fix. Filter by repo/surface/surface_key/outcome/tag/text. Excludes superseded entries by default. Call at triage/G2 (start of a loop).",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          surface: { type: "string", description: "Substring match on the free-text surface." },
          surface_key: { type: "string", description: "Exact (normalized) canonical-key match - for grouping recurrence on one component. Use `surface` for substring." },
          outcome: { type: "string", enum: VALID_OUTCOMES },
          tag: { type: "string" },
          text: { type: "string", description: "Substring search across symptom/root_cause/what_worked/what_failed." },
          include_superseded: { type: "boolean" },
          limit: { type: "integer" },
        },
      },
    },
    {
      name: "recent_outcomes",
      description: "Most recent trajectories (optionally for one repo). Quick situational awareness.",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string" }, n: { type: "integer" } },
      },
    },
    {
      name: "list_repos",
      description: "List repos with recorded trajectories and their entry counts.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    switch (name) {
      case "append_trajectory":
        result = await appendTrajectory(args);
        break;
      case "query_trajectory":
        result = await queryTrajectory(args);
        break;
      case "recent_outcomes":
        result = await recentOutcomes(args);
        break;
      case "list_repos":
        result = await listRepos();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("uncaughtException", (err) => {
  process.stderr.write(`trajectory-kb: uncaught exception: ${err.message}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`trajectory-kb: unhandled rejection: ${String(reason)}\n`);
  process.exit(1);
});

const transport = new StdioServerTransport();
await server.connect(transport);
