#!/usr/bin/env bash
# plugin-install-smoke.sh - install the receipts plugin the way a STRANGER does, through
# Claude Code's own plugin manager, and read back what actually registered.
#
# Why this exists: every other check in this repo drives the plugin's scripts directly -
# `node hooks/stop-gates.mjs < payload`, `node --test`, the bench. None of them ever ran
# `claude plugin install`, so a manifest Claude Code rejects, a skill directory it cannot
# see, a hooks.json it does not register, or an MCP bundle it launches that serves stale
# tools would all pass CI and break on the first stranger's install. The bundle DID drift
# from its source for two months (four tools served, five declared) with every job green.
# This script would have gone red on day one.
#
# Usage: scripts/plugin-install-smoke.sh [repo-root]
#   repo-root         the checkout to install FROM (default: this script's own repo). The
#                     root's .claude-plugin/marketplace.json makes the checkout a marketplace.
#   CLAUDE_CONFIG_DIR honored when set (point it at a FRESH dir - a second `marketplace add`
#                     into the same dir is refused); otherwise an isolated temp dir is
#                     created so the run never touches the developer's own ~/.claude.
#
# Portable bash (macOS + ubuntu): no jq, no GNU-only flags. JSON is read with node, which
# the plugin needs anyway.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
ROOT="$(cd "$ROOT" && pwd)" # absolute: the marketplace records this path as its source

if [ -z "${CLAUDE_CONFIG_DIR:-}" ]; then
  CLAUDE_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/receipts-plugin-smoke.XXXXXX")"
  echo "note: CLAUDE_CONFIG_DIR was not set - using an isolated $CLAUDE_CONFIG_DIR"
fi
export CLAUDE_CONFIG_DIR

ok()   { echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# `claude plugin ...` prefixes its status line with a spinner glyph; match the phrase, not the line.
expect() { # expect <label> <needle> <output>
  case "$3" in *"$2"*) ;; *) fail "$1 - expected \"$2\" in output:
$3" ;; esac
}

command -v claude >/dev/null 2>&1 || fail "claude CLI not on PATH (npm install -g @anthropic-ai/claude-code)"
command -v node >/dev/null 2>&1 || fail "node not on PATH"
echo "claude $(claude --version) / node $(node --version) / root $ROOT"

# 1. The checkout itself is the marketplace (.claude-plugin/marketplace.json at the root).
out="$(claude plugin marketplace add "$ROOT" 2>&1)" || fail "marketplace add exited non-zero:
$out"
expect "marketplace add" "Successfully added marketplace" "$out"
ok "marketplace added from $ROOT"

# 2. Install exactly as the README tells a user to.
out="$(claude plugin install receipts@receipts 2>&1)" || fail "plugin install exited non-zero:
$out"
expect "plugin install" "Successfully installed plugin" "$out"
ok "plugin installed: receipts@receipts"

# 3. The manifest passes Claude Code's own validator.
out="$(claude plugin validate "$ROOT/plugin" 2>&1)" || fail "plugin validate exited non-zero:
$out"
expect "plugin validate" "Validation passed" "$out"
ok "plugin validate: passed"

# 4. list --json: exactly one plugin, enabled, with the MCP server registered. Yields the
#    install path so the handshake below runs against the INSTALLED copy, not the checkout.
list_json="$(claude plugin list --json 2>/dev/null)" || fail "plugin list --json exited non-zero"
INSTALL_PATH="$(printf '%s' "$list_json" | node -e '
  const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const die = (m) => { console.error("FAIL: plugin list --json - " + m + "\n" + JSON.stringify(list, null, 2)); process.exit(1); };
  if (!Array.isArray(list) || list.length !== 1) die("expected exactly one installed plugin, got " + (Array.isArray(list) ? list.length : typeof list));
  const p = list[0];
  if (p.id !== "receipts@receipts") die("id is " + JSON.stringify(p.id));
  if (p.enabled !== true) die("enabled is " + JSON.stringify(p.enabled));
  if (!p.mcpServers || !p.mcpServers["trajectory-kb"]) die("mcpServers[\"trajectory-kb\"] is missing");
  if (!p.installPath) die("installPath is missing");
  process.stdout.write(p.installPath);
')" || exit 1
ok "plugin list --json: one entry, id receipts@receipts, enabled, mcpServers.trajectory-kb registered"
ok "installPath: $INSTALL_PATH"

# 5. details: the component inventory names every skill, hook event and MCP server the plugin
#    ships. A skill dir Claude Code cannot see, or a hook event it did not register, shows up
#    here as a wrong count long before a user notices the gate never fired.
details="$(claude plugin details receipts@receipts 2>&1)" || fail "plugin details exited non-zero:
$details"
for needle in "Skills (2)" "gates" "setup" "Hooks (3)" "Stop" "PreToolUse" "SessionStart" "MCP servers (1)" "trajectory-kb"; do
  expect "plugin details" "$needle" "$details"
done
ok "plugin details: Skills (2) gates, setup / Hooks (3) Stop, PreToolUse, SessionStart / MCP servers (1) trajectory-kb"

# 6. Launch the INSTALLED bundle the way Claude Code does (node <installPath>/mcp/.../server.bundle.mjs)
#    and speak the MCP handshake to it. test/server.test.mjs proves the CHECKOUT's bundle matches
#    index.js; this proves the copy a user actually ends up with serves the five tools the README
#    documents. The store is redirected to a temp file so nothing touches ~/.claude.
BUNDLE="$INSTALL_PATH/mcp/trajectory-kb/server.bundle.mjs"
[ -f "$BUNDLE" ] || fail "installed bundle missing: $BUNDLE"
RECEIPTS_TRAJECTORY_STORE="$(mktemp -d "${TMPDIR:-/tmp}/receipts-plugin-smoke-store.XXXXXX")/trajectories.jsonl" \
node -e '
  const { spawn } = require("child_process");
  const bundle = process.argv[1];
  const want = ["append_trajectory", "query_trajectory", "recent_outcomes", "reopen_rate", "list_repos"];
  const child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "", nextId = 1;
  const pending = new Map();
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`no response to ${method} in 10s; server stderr: ${stderr || "(empty)"}`)), 10000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  (async () => {
    const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "receipts-install-smoke", version: "0" } });
    if (!init.result || init.result.serverInfo.name !== "trajectory-kb") throw new Error("initialize: " + JSON.stringify(init));
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const list = await request("tools/list");
    if (!list.result) throw new Error("tools/list: " + JSON.stringify(list));
    const served = list.result.tools.map((t) => t.name);
    const missing = want.filter((n) => !served.includes(n));
    if (missing.length) throw new Error(`installed bundle is missing tools ${JSON.stringify(missing)}; it serves ${JSON.stringify(served)}`);
    console.log("ok: installed bundle handshake - serves " + served.join(", "));
  })().then(() => { child.kill(); process.exit(0); }, (e) => { console.error("FAIL: " + e.message); child.kill(); process.exit(1); });
' "$BUNDLE"

echo "plugin install smoke: PASS"
