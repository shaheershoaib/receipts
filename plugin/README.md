# plugin (the Claude Code adapter)

Teaches a Claude Code agent to *produce receipts* as it works, so its fixes clear the
Seven Gates before a PR is ever opened. This is the agent-side half of `receipts`
(the PR-side half is `../enforcer`).

## What it provides

- **`skills/seven-gates/`** - the gates as an agent skill: reproduce-first (G0),
  pin the exact flow (G2), verify by value on the deployed build (G1), land on the
  surface the reporter sees (G4), drive to the terminal action (G5), sweep the twins
  (G6), confirm the sha (G3), and write the red->green receipt. Project-agnostic by
  design - a project supplies its own facts via `receipts.config.json`.
- **`hooks/stop-verification-gate.py`** - the backstop: blocks a "fixed" close-out
  that lacks deployed-build evidence (binding + observation). The local precursor to
  the CI enforcer.
- **`hooks/stop-trajectory-reminder.py`** - nudges the agent to record what was tried
  on a surface and how it turned out, so the memory grows (and captures failures, not
  just wins).
- Pairs with the **`../mcp/trajectory-kb`** server (the verification memory).

## Wiring

`plugin.json` declares the components: `skills/` (auto-loaded), `hooks/hooks.json`
(the two Stop hooks, referenced via `${CLAUDE_PLUGIN_ROOT}`), and `.mcp.json` (the
`trajectory-kb` server). Installing the plugin registers all three - no hand-editing
of settings.json and no `claude mcp add`. `claude plugin validate` passes.

## Before publishing - genericize the project-specifics

Cloned from a battle-tested setup; these carry sensible-but-generic platform defaults
a real product should make config-driven:

- `hooks/stop-verification-gate.py` - the deployed-host patterns (vercel / railway /
  netlify / fly / ...) and the board-status values are platform defaults. Move them
  to a `receipts.config.json` so each project sets its own (see
  `../enforcer/README.md`).
- The skill (`seven-gates`) is already project-agnostic; keep all project-specific
  facts in `receipts.config.json`, never in the skill.

## Roadmap

- [ ] `receipts.config.json` for host / board / verify-step overrides.
- [ ] Install-test that the hooks + MCP auto-activate from the manifest in a real session.
