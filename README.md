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
| **G11** a green earned by shrinking the suite proves nothing | verify | PR / CI (static) |
| **G13** the receipt must EXERCISE the diff (opt-in coverage) | verify | PR / CI (re-run) |
| **G14** the receipt must have TEETH (mutation referee) | verify | PR / CI (re-run) |
| **G2** pin the EXACT flow / component | target | agent-side |
| **G4** land on the surface the reporter SEES | target | agent-side |
| **G6** sweep the changed pattern's parallel TWINS | target | agent-side |
| **G7** verify the DEPENDENTS, esp. newly-pulled ones | target | agent-side (+ enforcer) |
| **G8** verify on a base even with origin (fresh base) | target | agent-side (+ enforcer) |
| **G10** a contract change survives the deploy window | target | agent-side (+ enforcer) |
| **G12** fix the CAUSE, not the alarm (no silencing) | target | agent-side (+ enforcer) |

The **verify** gates (did you actually prove it works) are enforceable at the one
chokepoint every team shares regardless of which agent they use: the PR. The
**target** gates (did you fix the *right* thing) live inside the agent's loop, and
ship as adapters. G7, G8, and G10 are the **multi-dev gates**: the failures that
only happen because other people are pushing in parallel and the codebase changes
under you. G9 is amplified by the same reality. G11-G14 are the
**optimizing-agent gates**: G0-G10 defend against an agent that is *wrong*; these
defend against an agent that is *optimizing* - deleting the failing test, silencing
the alarm instead of the cause, shielding a broad diff behind a narrow receipt,
writing a receipt too weak to notice a wrong fix. For the fully untrusted-agent
posture, the **receipt lock** (`receipts lock`, `receipt-lock:` in the PR body) pins
the acceptance test's CONTENT before the agent starts: the agent makes the approved
rubric pass - it does not get to write its own. Weak model + locked receipt + these
gates in block mode is the working recipe for "the agent said it's done, and that is
actually evidence."

**What it is not:** a referee against self-deception and mistakes, not a security boundary
against a hostile author. The enforcer re-runs the branch's own tests, so a PR could in
principle make them lie; receipts closes the easy bypasses (it reads its config from the
trusted base commit, rejects exit-masking test commands, refuses shell-metacharacter paths)
but does not replace human review of the diff or branch protection. It raises the floor on
honesty.

**Conformance.** The spec is versioned `receipts/gates@1.1` (see `spec/GATES.md`). An adapter
for ANY agent framework - not just the Claude Code plugin shipped here - conforms to
`receipts/gates@1.1` iff it passes the three reference suites: the enforcer self-verification
suite (`npm test`), the Stop-hook suite (`node --test plugin/hooks/test/*.test.mjs`), and the
gates-bench (`node bench/run.js`) at **0 undeclared escapes / 0 false-blocks**. There is no
separate conformance checklist to interpret: the suites ARE the conformance test, so "does
your adapter conform" reduces to "does it go green against them."

## What's in here

- **`spec/`** - the Gates standard. The IP. Each gate + its real scar.
- **`enforcer/`** - the universal piece: a GitHub Action that fails a "fixed" PR
  unless it carries, and *survives*, the receipt (the changed test must be red on
  base, green on head). Agent-agnostic - works no matter who or what wrote the code.
- **`plugin/`** - a Claude Code plugin (the agent adapter): teaches your agent to
  produce receipts as it works, so its PRs pass the gate naturally.
- **`plugin/mcp/trajectory-kb/`** - the memory layer: what was tried on a surface and
  how it turned out, so the gates *learn* and stop the team repeating the same trap. The
  memory now **pushes** - a SessionStart hook injects prior scars for the repo into a new
  session so even an agent that never thinks to query the kb arrives already warned.

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
- the **Stop-hook backstop** (`stop-gates.mjs`, Node - no python needed) - it fires on
  every stop-cycle, regardless of the model, and carries both checks in one transcript
  pass: it blocks a "fixed" close-out that lacks deployed-build evidence, and nudges a
  trajectory-kb entry at a loop exit. That deployed-build evidence can be a **live receipt** -
  `receipts observe` probes the live build, checks the output MEETS its expectation, and binds
  it to the build sha (set `agent.evidence: "live-receipt"` to make it the ONLY accepted
  evidence, so "a screenshot happened" no longer clears the gate).
- the **in-session tripwires** (`pre-gates.mjs`, a PreToolUse hook) - two small guards that
  fire AT the risky action, between the Stop hook and the enforcer: a `git commit` right after
  a production-source edit with no test / `receipts observe` run in between is denied
  (commit-without-verification), and editing a TEST file whose test was just seen FAILING is
  denied (G11-live: fix the code, not the referee). Both are deny-by-default with an explicit,
  greppable escape (`RECEIPTS_ACK='<why>'` / `--no-verify-receipts` / a `test-removal:` note) -
  an honest note, never a silent skip; tune under `agent.tripwires`.
- the **`trajectory-kb` MCP** - the verification memory the skill queries and appends.
- the **memory-push** (`session-memory.mjs`, a SessionStart hook) - the kb only helped an
  agent that thought to *query* it; a weak agent never does. This hook flips that: at
  session start it reads the trajectory store, picks up to ~5 most-relevant entries for
  THIS repo (failures first, one per surface_key), and injects a compact (~1500-char-capped)
  summary into the agent's context - so the agent arrives already warned, with no tool call.
  On by default when a `receipts.config.json` is present (a receipts-less repo gets zero
  change); turn off with `agent.memory_inject: "off"`. Inspect the same memory from the
  terminal with `receipts kb recur` (recurrence report) and `receipts kb distill`
  (conservative, rule-based config suggestions).

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
- the focused `gates` agent skill + two Stop-hook backstops (the Claude Code adapter), tracker-agnostic (Notion / Linear / Jira / GitHub)
- the `trajectory-kb` memory MCP, plus **memory-push** at session start (`session-memory.mjs`, a SessionStart hook that injects the repo's prior scars into every session so a weak agent is warned without querying; `agent.memory_inject`) and `receipts kb recur` / `kb distill` to read + distill that memory from the terminal
- `receipts init` - detects stack + deploy target, confirms, writes `receipts.config.json`; published to npm as [`receipts-cli`](https://www.npmjs.com/package/receipts-cli) (`npx receipts-cli init`)
- the **verification engine** as both a **CI enforcer** (`enforcer/`, a GitHub Action) and a **local CLI** (`receipts verify` / `replay` / `explain` / `observe` / `kb`) - one engine, the red->green re-verification at the PR or on your machine
- **replayable receipts** - every verification can emit a machine-readable evidence artifact (`--receipt-out`, schema in `spec/RECEIPT.md`): base/head, verdict, every command run with its exit code, the red->green proof. `receipts replay` re-runs it; `receipts explain` reads it
- **live receipts** (`receipts observe`, schema in `spec/LIVE-RECEIPT.md`) - machine-validated deployed-build evidence for the Stop hook: probe the live build (a deployed URL / staging query / installed CLI), check the output MEETS an expectation, bind it to the build sha, emit one `LIVE-RECEIPT` line. Replaces "a screenshot happened" with a re-runnable value check bound to the build; `agent.evidence: "live-receipt"` makes it mandatory
- **in-session tripwires** (`pre-gates.mjs`, a PreToolUse hook) - a commit-without-verification guard (deny a `git commit` that follows a production-source edit with no test / `receipts observe` in between) and a G11-live referee guard (deny editing a TEST file just seen failing). Deny-by-default with an explicit greppable escape (`RECEIPTS_ACK` / `--no-verify-receipts` / `test-removal:`); tune under `agent.tripwires`
- **G7 dependent-test-selection** - the enforcer re-runs the tests of consumers that newly route through the changed surface (JS/TS scan + an explicit graph for any stack)
- a runnable **caught-wrong-fix demo**: `npm run demo` ([examples/caught-wrong-fix](examples/caught-wrong-fix/)) - the founding scar (a height cap shipped for a too-narrow modal), blocked live by the real enforcer, then the exact-value fix passing
- **`receipts report`** - aggregate the receipt artifacts CI already uploads into team signals: verdicts, real-receipt rate, honesty-ladder usage (a rising downgrade rate is a team drowning), weak/flaky rejections, per-gate findings; `--json` for dashboards
- **generated agent adapters** (`npm run build:adapters`): the gates skill compiled to [adapters/AGENTS.md](adapters/AGENTS.md) (any rules-file agent) and [adapters/cursor/receipts.mdc](adapters/cursor/receipts.mdc) - the enforcer never cared who wrote the code; the teaching layer doesn't either
- a **GitLab CI example** ([enforcer/gitlab-ci.example.yml](enforcer/gitlab-ci.example.yml)) - the engine is CLI-first; the GitHub Action is just one wrapper
- the enforcer **verifies itself**: an adversarial test suite (per gate: valid / invalid / malicious receipt) runs in CI, receipts' enforcer gates receipts' own PRs, and `bench/` measures the whole harness against scripted weak-agent misbehavior (85% catch, 0% false-block, every escape declared)

Next: `verify.live_drive` in CI for symptoms a unit/e2e test can't express (drive the deployed
app from the enforcer, complementing the agent-side `receipts observe`).

## The hotfix playbook (the pressure valve)

Production is down at 2am and the gate wants a receipt? **Ship with the ladder**: put
`speculative:` (or `unverified-reasoned: <why>`) in the PR body and the enforcer passes it -
*tracked as unverified, never counted as a clean fix*. That is the design, not a loophole: a
gate teams cannot bypass under incident pressure gets ripped out the first bad night; a gate
that converts bypasses into visible, queryable debt survives. Next morning: re-verify, land
the real receipt, record the trajectory. `receipts report` over your receipt artifacts shows
the downgrade rate - if it is climbing, that is the signal, not the individual 2am call.

## Receipts accumulate (the regression suite you get for free)

Every merged receipt is the reported symptom's own acceptance test - **leave it in the
suite** (a `tests/receipts/` directory keeps them legible). Then G9 re-proves every past
symptom on every future PR, forever, and G11 makes deleting one a loud, named event. Two
years in, your suite is not "tests someone thought to write" - it is the complete record of
everything that ever actually broke, still standing guard.

## Releasing (maintainer)

`receipts-cli` is on npm. To cut a new version:

1. Bump `version` in `package.json` (and, if the plugin itself changed, `plugin/.claude-plugin/plugin.json` **plus** `.claude-plugin/marketplace.json` - a test keeps that pair in lockstep).
2. If you edited `spec/GATES.md`, run `npm run build:refs` to sync the bundled skill reference (`plugin/skills/gates/references/GATES.md`, the deep how-to the agent reads on a stranger's install), then commit it.
3. If you edited `plugin/mcp/trajectory-kb/index.js`, rebuild the bundled MCP server: `cd plugin/mcp/trajectory-kb && npm run build`, then commit the regenerated `server.bundle.mjs`.
4. `npm publish`.

npm requires an auth token to publish **even with no 2FA** on the account. One-time: create a **Granular Access Token** (npmjs.com -> Access Tokens) with **Packages and scopes = Read and write, "All packages"** (Organizations = No access; no org needed), then `npm config set //registry.npmjs.org/:_authToken=<TOKEN>`. (Classic "Automation" tokens also work where the account still offers them.)

## License

Apache 2.0. (The verification discipline should be free and everywhere.)

Use it, ship it, sell what you build with it. Two asks, both encoded in the license:
keep the `NOTICE` file with your redistribution (§4(d)), and don't market your fork
as `receipts` (§6). The patent grant in §3 is there so adopting this doesn't expose
you to a patent claim over it.
