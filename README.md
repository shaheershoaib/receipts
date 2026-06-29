# receipts

[![npm](https://img.shields.io/npm/v/receipts-cli)](https://www.npmjs.com/package/receipts-cli)

**Agents need receipts.**

Your AI coding agent just told you it fixed the bug. Did it?

`receipts` is a verification layer for AI-written code. It does not make your agent
faster or more autonomous - the whole industry is already building that. It does the
opposite: it **re-proves the agent's claim before you trust it.** An agent can type
"Fixed ✅"; it cannot fake the reported symptom still being there when `receipts`
re-runs it.

> Everyone is shipping gas: faster agents, bigger swarms. This ships brakes.

---

## The problem

An agent fixes a bug, runs the tests, sees green, and closes the ticket: "Fixed."
The tests passed. The code looks right. CI is happy. And the bug is still there -
because the test exercised the wrong thing, or the fix landed on the wrong surface,
or the change painted correctly in dev and broke in prod, or it patched the symptom
and not the cause.

Real example this was built from: a "modal is cut off" report was read as a vertical
clip. A height cap was written, tested, deployed, and "verified" green - while the
real bug was the modal being too *narrow*. The wrong axis shipped. Only a human
caught it. Every team using AI to write code is hitting some version of this, daily.

The missing referee is simple to state and hard to enforce: **a fix is not done
because the agent says so. It is done when the reported symptom is observably gone
on the deployed build.**

## The core move: don't trust, re-verify

A "looks fixed" screenshot is not a receipt - an agent can produce one for a bug it
never fixed. A *receipt* is the symptom's own acceptance test, re-run against the
real build, coming back clean. `receipts` re-runs it. The agent does not get to
grade its own homework.

## How it works: the Gates

The Gates (`spec/GATES.md`) are the standard a fix must clear. Each one
exists because skipping it shipped a wrong or unverified "fix" at least once - every
gate carries the real scar that motivated it.

They split into two kinds:

| Gate | Job | Where it lives |
|---|---|---|
| **G0** reproduce the symptom (it IS your acceptance test) | verify | PR / CI (re-run) |
| **G1** assert the rendered VALUE, not a placeholder | verify | PR / CI (re-run) |
| **G3** verify on the build that carries YOUR commit | verify | PR / CI |
| **G5** drive the flow to its TERMINAL action | verify | PR / CI (re-run) |
| **G9** trustworthy green: full-scope, unmasked, representative | verify | PR / CI (re-run) |
| **G2** pin the EXACT flow / component | target | agent-side |
| **G4** land on the surface the reporter SEES | target | agent-side |
| **G6** sweep the changed pattern's parallel TWINS | target | agent-side |
| **G7** verify the DEPENDENTS, esp. newly-pulled ones | target | agent-side (+ enforcer) |
| **G8** verify on a base even with origin (fresh base) | target | agent-side (+ enforcer) |
| **G10** a contract change survives the deploy window | target | agent-side (+ enforcer) |

The **verify** gates (did you actually prove it works) are enforceable at the one
chokepoint every team shares regardless of which agent they use: the PR. The
**target** gates (did you fix the *right* thing) live inside the agent's loop, and
ship as adapters. G7, G8, and G10 are the **multi-dev gates**: the failures that
only happen because other people are pushing in parallel and the codebase changes
under you. G9 is amplified by the same reality.

## What's in here

- **`spec/`** - the Gates standard. The IP. Each gate + its real scar.
- **`enforcer/`** - the universal piece: a GitHub Action that fails a "fixed" PR
  unless it carries, and *survives*, the receipt (the changed test must be red on
  base, green on head). Agent-agnostic - works no matter who or what wrote the code.
- **`plugin/`** - a Claude Code plugin (the agent adapter): teaches your agent to
  produce receipts as it works, so its PRs pass the gate naturally.
- **`plugin/mcp/trajectory-kb/`** - the memory layer: what was tried on a surface and
  how it turned out, so the gates *learn* and stop the team repeating the same trap.

## Install

Two halves - the **agent adapter** (your agent produces receipts) and the **PR enforcer**
(they get checked). Use either alone or both. Set up per repo, step by step:

**1. Add the plugin** - teaches your Claude Code agent the Gates:
```bash
claude plugin marketplace add shaheershoaib/receipts
claude plugin install receipts
```

**2. Configure the repo** - detects your stack + deploy target, confirms, writes `receipts.config.json`:
```bash
npx receipts-cli init
# or run the latest unreleased from source: npx github:shaheershoaib/receipts init
```

**3. Enforce at the PR** - re-runs each fix-claim's receipt (RED on the base commit, GREEN on the fix). Add `.github/workflows/receipts.yml`:
```yaml
# full template: enforcer/example-workflow.yml
on: pull_request
jobs:
  receipts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4    # + your deps install (swap per stack)
      - uses: shaheershoaib/receipts/enforcer@main
```

It works across any repo because the gate *logic* ships generic and only the project
*plumbing* (how to test, where it deploys, what marks a fix-claim) is detected per
project. See [enforcer/GENERALIZATION.md](enforcer/GENERALIZATION.md) for how,
[enforcer/INIT.md](enforcer/INIT.md) for what `init` detects vs asks, and
[receipts.config.example.json](receipts.config.example.json) for the output.

## How it activates (and making it always-on)

Installing the plugin auto-loads three things from the plugin root - no `settings.json`
edits, no `claude mcp add`:

- the **`gates` skill** - the agent invokes it when your task matches its description
  ("fixing a bug, addressing a tester/issue report, or about to claim a change is
  done/fixed/working"). The skill *body* is the procedure: reproduce-first, the
  red->green receipt, the gate list, the honesty ladder, the trajectory touchpoints.
- the **two Stop hooks** - they fire on every stop-cycle, regardless of the model: one
  blocks a "fixed" close-out that lacks deployed-build evidence, the other nudges a
  trajectory-kb entry at a loop exit.
- the **`trajectory-kb` MCP** - the verification memory the skill queries and appends.

These form a gradient: the skill is a model-layer **nudge** (it is invoked by
description-match, not guaranteed), while the Stop hooks and the [CI enforcer](enforcer/)
are **deterministic** - they hold even if the agent never invokes the skill. The skill
*teaches* the discipline; the hooks and the enforcer *enforce* it.

To make the discipline always-on at the model layer too (not just nudged), add one line
to your project's `CLAUDE.md` / `AGENTS.md`:

```
When fixing a bug, addressing tester or issue feedback, or about to claim a change is
"fixed", invoke the `gates` skill first and follow it.
```

Or register a `SessionStart` hook that injects the same instruction. Even without this,
the deterministic backstops still apply - this just hardens the model-layer trigger.

## Status

Honest: the *discipline* is battle-tested - it has run a production codebase's bug
pipeline for months and caught real money-path regressions.

Built and working today:
- the Gates spec (`spec/GATES.md`)
- the focused `gates` agent skill + two Stop-hook backstops (the Claude Code adapter)
- the `trajectory-kb` memory MCP
- `receipts init` - detects stack + deploy target, confirms, writes `receipts.config.json`; published to npm as [`receipts-cli`](https://www.npmjs.com/package/receipts-cli) (`npx receipts-cli init`)
- the **CI enforcer** (`enforcer/`) - the red->green re-verification at the PR, as a GitHub Action

Next: `verify.live_drive` for symptoms a test can't express (drive the deployed app),
and an `examples/` demo of a caught wrong-fix.

## Releasing (maintainer)

`receipts-cli` is on npm. To cut a new version:

1. Bump `version` in `package.json` (and `plugin/.claude-plugin/plugin.json` too if the plugin itself changed).
2. If you edited `plugin/mcp/trajectory-kb/index.js`, rebuild the bundled MCP server: `cd plugin/mcp/trajectory-kb && npm run build`, then commit the regenerated `server.bundle.mjs`.
3. `npm publish`.

npm requires an auth token to publish **even with no 2FA** on the account. One-time: create a **Granular Access Token** (npmjs.com -> Access Tokens) with **Packages and scopes = Read and write, "All packages"** (Organizations = No access; no org needed), then `npm config set //registry.npmjs.org/:_authToken=<TOKEN>`. (Classic "Automation" tokens also work where the account still offers them.)

## License

MIT. (The verification discipline should be free and everywhere.)
