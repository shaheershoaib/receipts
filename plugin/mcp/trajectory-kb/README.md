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
