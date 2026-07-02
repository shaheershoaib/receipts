# trajectory-kb MCP

A queryable, append-only store of dev **trajectories** — *what was tried on a surface and what happened* — so the fix/build loops stop repeating wrong-surface traps and can **retrieve** relevant past fixes at the start of a new one. (Borrowed from Ruflo's "learn from past trajectories" idea, kept lean.)

## Packaging (how it ships in the plugin)
The plugin runs the **bundled** server `server.bundle.mjs` (committed, ~540K, all deps
inlined via esbuild), NOT `index.js`. Claude Code does not `npm install` a plugin's MCP
server, so the raw `index.js` (which imports `@modelcontextprotocol/sdk`) cannot resolve
its dependency from a fresh install. `index.js` is the SOURCE; after editing it, rebuild
with `npm run build` and commit the regenerated `server.bundle.mjs`. `node_modules/` is a
build-time-only dependency and stays gitignored.

## Storage
Append-only JSONL is the source of truth, human-readable and greppable. **Where it
lives decides WHO it serves** (`agent.trajectory_store` in `receipts.config.json`,
resolved by walking up from the session cwd - see `store.mjs`):

- **`home`** (default): `~/.claude/mcp-servers/trajectory-kb/data/trajectories.jsonl` -
  private, per-machine, every entry tagged by `repo` so it aggregates across your repos.
- **`repo`**: `<repo>/.receipts/trajectories.jsonl` - **commit it**, and the whole team
  inherits every recorded trap and dead end (teammate B sees teammate A's wrong-surface
  trap before repeating it). Append-only JSONL merges trivially - concurrent branches
  appending entries never conflict beyond a trivial union.
- any other value: an explicit path, resolved against the config's directory.
- `RECEIPTS_TRAJECTORY_STORE` env var overrides everything (tests, one-off redirects).

Structured/keyword query for v1; semantic/embedding retrieval is a deliberate v2.

## Tools
| Tool | Purpose |
|---|---|
| `append_trajectory` | Record an entry (required: `repo`, `outcome`). Call at **every loop exit** - a clean close-out OR a downgraded / reverted / blocked exit. Record the failures, not just the wins. |
| `query_trajectory` | Retrieve past entries by `repo`/`surface`/`surface_key`/`outcome`/`tag`/`text`. Call at **triage/G2**, before pinning a fix. Excludes superseded by default. |
| `recent_outcomes` | Most recent entries (optionally one repo). |
| `list_repos` | Repos with recorded trajectories + counts. |

### Entry schema
`id` · `ts` · `repo` · `surface` (free human text) · `surface_key` (canonical groupable key - primary file path / component id, **auto-derived** from `surface`/`files` when omitted, or passed explicitly; this is what makes recurrence on one component visible, since free-text `surface` is almost never written identically twice) · `symptom` · `root_cause` · `outcome` (`fixed`/`unverified-reasoned`/`speculative`/`reverted`) · `what_worked[]` · `what_failed[]` (incl. wrong-surface traps) · `files[]` (edited files, for history joins) · `regressed[]` (surfaces this fix broke, the coupling signal) · `tier` (`top`/`cheap`/`mixed`) · `tags[]` · `supersedes` (id).

## Setup
```bash
cd ~/.claude/mcp-servers/trajectory-kb && npm install
claude mcp add --scope user trajectory-kb -- node ~/.claude/mcp-servers/trajectory-kb/index.js
```
Restart the Claude Code session to pick it up.

## Debug (manual JSON-RPC)
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node index.js
```

## How the loops use it
- **Start (triage / G2):** `query_trajectory({ surface })` (substring) or `query_trajectory({ surface_key })` (exact match, for recurrence on one component) to see what was tried before and any wrong-surface trap.
- **Every loop exit (after verify when there is one):** `append_trajectory({ repo, surface, surface_key, symptom, root_cause, outcome, what_worked, what_failed, files })`. Record downgraded / reverted / **blocked** exits too, with the honest `outcome` - a success-only store is survivorship bias that blinds the corpus.

The store is the source of truth; this MCP just enforces the schema and serves structured reads.

## Memory that pushes (SessionStart injection)
Querying the kb only ever helped an agent that *thought* to query it - and the weak agent
that repeats a wrong-surface trap never does. The plugin's **SessionStart hook**
(`plugin/hooks/session-memory.mjs`) flips that from pull to push: at the start of every
session it READS this same JSONL (never writes), picks up to ~5 entries most worth knowing
for the CURRENT repo, and injects a compact summary into the agent's context - so the agent
arrives already warned, with no tool call.

- **Store + repo resolution:** identical to this server (home + optional `repo` store via
  `agent.trajectory_store`, `RECEIPTS_TRAJECTORY_STORE` override). The "current repo" is
  matched case-insensitively against the config's `agent.repo_name`, the git remote basename,
  `package.json` name, and the cwd basename - so a slightly-differently-named tag still lines up.
- **Selection:** failures are the payload, so entries are ranked failures-first (outcome !=
  `fixed`, or a non-empty `what_failed`) then most-recent, de-duplicated **one per
  `surface_key`** (five different traps beat five re-tellings of one), superseded entries
  dropped.
- **Format + cap:** a one-line header + 2-3 lines per entry (`surface_key` · `[outcome]` ·
  the first `what_failed` line, truncated ~200 chars), the whole block HARD-capped at ~1500
  chars because it loads into EVERY session.
- **Default-on, but only with a config:** ON when a `receipts.config.json` is found on the
  walk-up (an opt-in); a repo with NO config gets ZERO injection and zero noise. Empty store /
  no repo match / any error -> emits nothing (fail-open). Turn off with
  `agent.memory_inject: "off"`.

## CLI analytics (`receipts kb`)
Read the same store from the terminal (zero deps; same resolution rules):

- `receipts kb recur [--repo <name>] [--json]` - recurrence report: groups by `surface_key`,
  showing count, an outcomes histogram, the last timestamp, and the top `what_failed` line,
  most-recurring first.
- `receipts kb distill [--repo <name>] [--json]` - conservative, rule-based suggestions
  derived from the data (never auto-applied), printed with their evidence lines:
  - a `surface_key` with **>= 2 non-fixed** outcomes -> *recurring trouble spot* (declare a G6
    family / a `receipt-cmd` probe / a config note);
  - a repo with **>= 2 `reverted`** -> suggest `gates.G12.mode: "block"`;
  - **>= 2** entries whose `what_failed` mentions **`flaky`** -> suggest `verify.receipt_runs: 2`.
