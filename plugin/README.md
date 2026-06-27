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

Claude Code AUTO-DISCOVERS the components from the plugin root: `skills/`,
`hooks/hooks.json` (the two Stop hooks, referenced via `${CLAUDE_PLUGIN_ROOT}`), and
`.mcp.json` (the `trajectory-kb` server). The manifest does NOT declare these standard
paths - declaring a path that resolves to an auto-loaded file fails the load with a
"Duplicate ... detected" error, so `plugin.json` carries metadata only. Installing the
plugin registers all three - no hand-editing of settings.json and no `claude mcp add`.
`claude plugin validate` passes (note: it checks manifest SYNTAX, not the load-time
duplicate-path error, which only surfaces in `claude plugin list`).

## Project-specifics are config-driven (no hand-editing)

The hooks ship sensible generic defaults and MERGE config overrides from
`receipts.config.json` - the agent-home `~/.claude/receipts.config.json` as a base,
with the nearest project `receipts.config.json` (walked up from the session cwd)
merged over it. So a clean install + `receipts init` tunes them with no hand-editing,
and a **split repo** - skills + session cwd separate from the code repos (e.g. a
central skills project + several code repos) - is supported via the agent-home layer
(run `receipts init` there to write an agent-only config; the code repos get the
enforcer's verify/build config). With no config found the hooks fall back to the
generic defaults, so a zero-config install still works:

- `hooks/stop-verification-gate.py` extends, from config: the deployed-host patterns
  (`build.deploy_host_patterns`), the by-value-query patterns
  (`agent.staging_query_patterns`), the fixed-status values
  (`agent.closeout_fixed_statuses`), and the downgrade tags (`claim.downgrade_tags`).
- `hooks/stop-trajectory-reminder.py` reads which skills are fix/build loops from
  `agent.loop_skills` (the shipped `seven-gates` plus any project loops), so the
  reminder watches the project's actual loops, not just the bundled one.
- `skills/seven-gates/` stays project-agnostic. For a project with its own loop,
  `receipts init` registers it in `agent.loop_skills`; for a project with none, `init`
  scaffolds one from `templates/loop-skill/SKILL.md.tmpl` (filled with the project's
  facts) so the trajectory-kb is driven out of the box.

## Roadmap

- [x] `receipts.config.json` for host / loop-skill / fixed-status overrides - the hooks read it.
- [x] `receipts init` detects + registers loop skills and scaffolds a harness when none exists; `receipts doctor` reports drift.
- [ ] Install-test that the hooks + MCP auto-activate from the manifest in a real session.
