# plugin (the Claude Code adapter)

Teaches a Claude Code agent to *produce receipts* as it works, so its fixes clear the
Seven Gates before a PR is ever opened. This is the agent-side half of `receipts`
(the PR-side half is `../enforcer`).

## What it provides

- **`skills/feedback-fix-loop/`** - the gates as an agent skill: reproduce-first
  (G0), pin the exact flow (G2), verify by value on the deployed build (G1), land on
  the surface the reporter sees (G4), drive to the terminal action (G5), sweep the
  twins (G6), confirm the sha (G3). Project-agnostic by design - a project supplies
  its own facts (repos, deploy targets, board) via a separate facts skill; see
  `skills/feedback-fix-loop/references/project-facts-template.md`.
- **`hooks/stop-verification-gate.py`** - the backstop: blocks a "fixed" close-out
  that lacks deployed-build evidence (binding + observation). The local precursor to
  the CI enforcer.
- **`hooks/stop-trajectory-reminder.py`** - nudges the agent to record what was tried
  on a surface and how it turned out, so the memory grows (and captures failures, not
  just wins).
- Pairs with the **`../mcp/trajectory-kb`** server (the verification memory).

## Wiring (today)

The hooks register in the user's `settings.json` under `Stop`; the MCP via
`claude mcp add`; the skill auto-loads from the plugin. Auto-wiring all three through
the plugin manifest needs a pass against the current Claude Code plugin schema -
tracked in the roadmap.

## Before publishing - genericize the project-specifics

Cloned from a battle-tested setup; these carry sensible-but-generic platform defaults
a real product should make config-driven:

- `hooks/stop-verification-gate.py` - the deployed-host patterns (vercel / railway /
  netlify / fly / ...) and the board-status values are platform defaults. Move them
  to a `receipts.config.json` so each project sets its own (see
  `../enforcer/README.md`).
- The skill (`feedback-fix-loop`) is already project-agnostic; keep all
  project-specific facts in the facts skill, never in the generic skill.

## Roadmap

- [ ] `receipts.config.json` for host / board / verify-step overrides.
- [ ] Validate hook + MCP auto-wiring against the current plugin manifest schema.
- [ ] Consider renaming `feedback-fix-loop` to a product-aligned skill name.
