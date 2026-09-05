# How receipts works

The README is the pitch and the install. This is the rest: the problem in full, every gate and
where it is enforced, how each piece of the plugin activates, the hotfix playbook, and what the
gates do not defend against.

## The problem

An agent fixes a bug, runs the tests, sees green, and closes the ticket: "Fixed." The tests
passed. The code looks right. CI is happy. And the bug is still there - because the test
exercised the wrong thing, or the fix landed on the wrong surface, or the change painted
correctly in dev and broke in prod, or it patched the symptom and not the cause.

Real example this was built from: a "modal is cut off" report was read as a vertical clip. A
height cap was written, tested, deployed, and "verified" green - while the real bug was the
modal being too *narrow*. The wrong axis shipped. Only a human caught it. Every team using AI
to write code is hitting some version of this, daily.

The missing referee is simple to state and hard to enforce: **a fix is not done because the
agent says so. It is done when the reported symptom is observably gone on the deployed build.**

## The core move: don't trust, re-verify

A "looks fixed" screenshot is not a receipt - an agent can produce one for a bug it never
fixed. A *receipt* is the symptom's own acceptance test, re-run against the real build, coming
back clean. receipts re-runs it. The agent does not get to grade its own homework.

## The Gates

The Gates ([spec/GATES.md](../spec/GATES.md), `receipts/gates@1.5`) are the standard a fix
must clear. Each one exists because skipping it shipped a wrong or unverified "fix" at least
once - every gate carries the real scar that motivated it.

| Gate | Job | Kind | Where it lives |
|---|---|---|---|
| **G0** reproduce the symptom (it IS your acceptance test) | verify | hybrid | agent + PR re-run |
| **G1** assert the rendered VALUE, not a placeholder | verify | hybrid | agent + live receipt |
| **G3** verify on the build that carries YOUR commit | verify | hybrid | live receipt / browser receipt |
| **G5** drive the flow to its TERMINAL action | verify | judgment | agent |
| **G9** trustworthy green: full-scope, unmasked, representative | verify | executable | enforcer |
| **G11** a green earned by shrinking the suite proves nothing | verify | executable | enforcer + PreToolUse hook |
| **G13** the receipt must EXERCISE the diff (opt-in coverage) | verify | executable | enforcer |
| **G14** the receipt must have TEETH (mutation referee) | verify | executable | enforcer |
| **G2** pin the EXACT flow / component and the reporter's context | target | judgment | agent |
| **G4** land on the surface the reporter SEES | target | judgment | agent |
| **G6** sweep the changed pattern's parallel TWINS | target | executable | enforcer (declared families + JS/TS heuristic) |
| **G7** verify the DEPENDENTS, especially newly-pulled ones | target | executable | enforcer re-runs their tests |
| **G8** verify on a base even with origin (fresh base) | target | executable | enforcer |
| **G10** a contract change survives the deploy window | target | executable | enforcer (structural diff) |
| **G12** fix the CAUSE, not the alarm (no silencing) | target | hybrid | agent + enforcer |
| **G15** force duplicated facts to AGREE | durability | judgment | agent |
| **G16** repair or disclose EXISTING instances | durability | judgment | agent |
| **G17** a repeated downgrade is a missing capability | process | agent-judgment | agent (a store-backed tally is the next assist) |
| **G18** prove a transform on the DESTINATION | verify | judgment | agent |
| **G19** fix the whole CLASS, not the reported instance | target | judgment | agent |

The **verify** gates are enforceable at the one chokepoint every team shares regardless of
which agent they use: the PR. The **target** gates live inside the agent's loop and ship as
adapters. G7, G8 and G10 are the **multi-dev gates**: the failures that only happen because
other people are pushing in parallel and the codebase changes under you. G11-G14 are the
**optimizing-agent gates**: G0-G10 defend against an agent that is *wrong*; these defend
against an agent that is *optimizing* - deleting the failing test, silencing the alarm instead
of the cause, shielding a broad diff behind a narrow receipt, writing a receipt too weak to
notice a wrong fix. G15-G17 are the **durability gates**: correct now, wrong later or elsewhere.

For the fully untrusted-agent posture, the **receipt lock** (`receipts lock`, `receipt-lock:` in
the PR body) pins the acceptance test's CONTENT before the agent starts: the agent makes the
approved rubric pass - it does not get to write its own. Weak model + locked receipt + these
gates in block mode is the working recipe for "the agent said it's done, and that is actually
evidence."

**Conformance.** An adapter for ANY agent framework - not just the Claude Code plugin shipped
here - conforms to `receipts/gates@1.5` iff it passes the reference suites: the enforcer
self-verification suite (`npm test`), the hook suite
(`node --test plugin/hooks/test/*.test.mjs plugin/mcp/trajectory-kb/test/*.test.mjs`), and the
gates-bench (`node bench/run.js`) at **0 undeclared escapes / 0 false-blocks**. The suites ARE
the conformance test.

## What is in the repo

- **`spec/`** - the Gates standard, plus the receipt (`RECEIPT.md`) and live-receipt
  (`LIVE-RECEIPT.md`) schemas, the per-medium mapping (`MEDIA.md`) and the work-type mapping
  (`WORK-TYPES.md`). The source of truth; `plugin/skills/gates/references/` is a generated copy.
- **`enforcer/`** - the universal piece: a GitHub Action that fails a "fixed" PR unless it
  carries, and *survives*, the receipt (the changed test must be red on base, green on head).
  Agent-agnostic - works no matter who or what wrote the code. Also a CLI (`receipts verify`).
- **`plugin/`** - the Claude Code plugin (the agent adapter): teaches your agent to produce
  receipts as it works, so its PRs pass the gate naturally.
- **`plugin/mcp/trajectory-kb/`** - the memory layer: what was tried on a surface and how it
  turned out, so the gates *learn* and the team stops repeating the same trap. The memory
  **pushes**: a SessionStart hook injects prior scars for the repo into a new session.
- **`bench/`** - the weak-agent matrix: scripted misbehaviours run through the real enforcer and
  Stop hook, exiting non-zero on any undeclared escape or false block.

## How the plugin activates

Installing the plugin auto-loads everything from the plugin root - no `settings.json` edits, no
`claude mcp add`. Enforcement is **opt-in per repo**: the tripwires and the Stop gate act only
where a `receipts.config.json` exists (in the project walk-up, or `~/.claude/receipts.config.json`
to opt in everywhere). A repo that never ran `receipts init` gets no behaviour change.

- the **`gates` skill** - the agent invokes it when your task matches its description ("fixing
  a bug, addressing a tester/issue report, or about to claim a change is done/fixed/working").
  The skill body is the procedure: reproduce-first, the red->green receipt, one line per gate
  with the full mandates in `references/`, the honesty ladder, the trajectory touchpoints.
- the **`setup` skill** - "set up receipts here": runs the `receipts init` interview (the four
  reachability questions only a human can answer), writes the config, checks it with `doctor`.
- the **in-session tripwires** (`pre-gates.mjs`, a PreToolUse hook) fire AT the risky action:
  a `git commit` right after a production-source edit with no test / `receipts observe` run in
  between (the project's own `verify.test_command` counts), an edit to a test file that a test
  run just showed FAILING with no green run since (G11-live), and `receipts init --yes`
  skipping the interview. Each guard's posture is `agent.tripwires.<name>`: `deny` blocks,
  `ask` raises the user's permission prompt with the reason, `warn` lets the action through and
  tells the agent what it skipped, `off` disables. The default is `ask`, or `deny` under CI.
  Every block carries an explicit, greppable escape (`RECEIPTS_ACK='<why>'`,
  `--no-verify-receipts`, a `test-removal: <why>` note in the content the edit writes).
- the **Stop-hook backstop** (`stop-gates.mjs`) fires on every stop-cycle, regardless of the
  model: it blocks a "fixed" close-out (a tracker status moved to fixed, `gh issue close`, a
  merge) that lacks deployed-build evidence after the merge, and nudges a trajectory-kb entry
  at a loop exit. The evidence can be a **live receipt**: `receipts observe` probes the live
  build, checks the output MEETS its expectation, and binds it to the build sha; set
  `agent.evidence: "live-receipt"` to make it the ONLY accepted evidence. Both hooks stream the
  transcript, so a long session costs nothing to check.
- the **memory push** (`session-memory.mjs`, a SessionStart hook) injects up to five prior
  attempts for THIS repo (failures first, one per surface) plus the recorded way in
  (`agent.drive`), capped at about 1,500 characters, and announces a plugin upgrade the config
  predates. `agent.memory_inject: "off"` disables the memories.
- the **`trajectory-kb` MCP server** - the verification memory the skill queries and appends
  (`append_trajectory`, `query_trajectory`, `recent_outcomes`, `reopen_rate`, `list_repos`).
  `receipts kb recur` and `kb distill` read the same store from the terminal.

These form a gradient: the skill is a model-layer **nudge** (invoked by description-match, not
guaranteed), while the hooks and the CI enforcer are **deterministic** - they hold even if the
agent never invokes the skill. To make the discipline always-on at the model layer too, add one
line to your project's `CLAUDE.md` / `AGENTS.md`:

```
When fixing a bug, addressing tester or issue feedback, or about to claim a change is
"fixed", invoke the `gates` skill first and follow it.
```

## Configuring the repo

`receipts init` detects the stack and deploy target, then ASKS the four things detection
cannot find (auth route, dev bypass, data realism, browser-only surfaces) and writes
`receipts.config.json`. Answer them: a config nobody was asked lets an unverified fix ship
wearing an honest-looking downgrade. `receipts doctor` audits the config later and groups its
findings as STALE / MISSING / NEEDS YOUR ANSWER. It works across any repo because the gate
*logic* ships generic and only the project *plumbing* (how to test, where it deploys, what marks
a fix-claim) is detected per project - see [enforcer/GENERALIZATION.md](../enforcer/GENERALIZATION.md),
[enforcer/INIT.md](../enforcer/INIT.md) and [receipts.config.example.json](../receipts.config.example.json).

**Fork PRs:** GitHub downgrades `GITHUB_TOKEN` to read-only on a pull request from a fork,
regardless of the workflow's `permissions:` block. The gate still runs and still fails the check;
only `comment: true` cannot post, and the report is written to the job summary instead.

## The hotfix playbook (the pressure valve)

Production is down at 2am and the gate wants a receipt? **Ship with the ladder**: put
`speculative:` (or `unverified-reasoned: <why>`) in the PR body and the enforcer passes it -
*tracked as unverified, never counted as a clean fix*. That is the design, not a loophole: a
gate teams cannot bypass under incident pressure gets ripped out the first bad night; a gate
that converts bypasses into visible, queryable debt survives. Next morning: re-verify, land the
real receipt, record the trajectory. `receipts report` over your receipt artifacts shows the
downgrade rate - if it is climbing, that is the signal, not the individual 2am call.

## Receipts accumulate (the regression suite you get for free)

Every merged receipt is the reported symptom's own acceptance test - **leave it in the suite**
(a `tests/receipts/` directory keeps them legible). Then G9 re-proves every past symptom on
every future PR, forever, and G11 makes deleting one a loud, named event. Two years in, your
suite is not "tests someone thought to write" - it is the complete record of everything that
ever actually broke, still standing guard.

## Replayable receipts and reports

Every verification can emit a machine-readable artifact (`--receipt-out`, schema in
[spec/RECEIPT.md](../spec/RECEIPT.md)): base/head, verdict, every command run with its exit
code, the red->green proof, the gate findings. `receipts replay` re-runs it, `receipts explain`
reads it, and `receipts report` aggregates the artifacts CI uploads into team signals: verdicts,
real-receipt rate, honesty-ladder usage (a rising downgrade rate is a team drowning), weak or
flaky rejections, per-gate findings.

## What the Gates do NOT defend against

The enforcer re-runs the fix's own receipt and the project's own tests. That makes it a referee
against **self-deception and mistakes**, not a security boundary against a **hostile author**:
the test command and the code it runs come from the changed branch, so a PR can in principle
make its own tests lie. receipts closes the easy bypasses - it reads its config from the trusted
base commit, rejects exit-masking test commands, refuses shell-metacharacter paths - but it does
not replace human review of the diff or branch protection. It raises the floor on honesty.
