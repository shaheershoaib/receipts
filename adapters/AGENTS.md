<!-- GENERATED from plugin/skills/gates/SKILL.md by scripts/build-adapters.js - do not hand-edit.
     Target: AGENTS.md / CLAUDE.md - any agent that reads a rules file. Regenerate with: npm run build:adapters -->

When fixing a bug, addressing tester or issue feedback, or about to claim a change is "done" / "fixed" / "working", follow the Gates below and produce a RECEIPT - a re-runnable acceptance test that is red before the fix and green after, asserting the reported symptom. A fix is not done because you say so; it is done when the symptom is observably gone.

# The Gates

When you fix or change something, your job is not to *claim* it works but to *produce a
receipt* that proves it, on the surface the reporter actually sees. This file is the
project-agnostic discipline; the project's facts live in `receipts.config.json`. The deep
material is bundled beside this file - read the piece the situation calls for:

| Need | Read |
|---|---|
| A gate's full mandate, real scar and enforcement | `references/GATES.md` |
| What "surface" / "value" / "terminal action" mean in this medium | `references/MEDIA.md` |
| The receipt for a feature, migration or refactor | `references/WORK-TYPES.md` |
| Every config field and what `init` detects vs asks | `references/INIT.md` |
| Receipt artifacts and live receipts (`receipts observe`) | `references/RECEIPT.md`, `references/LIVE-RECEIPT.md` |

## The config is the answer sheet

`receipts.config.json` (the project root, or `~/.claude/receipts.config.json` for every repo) is
what turns the discipline on: the hooks below enforce only where one exists. Read it before
verifying anything:

- `agent.drive.auth` / `.bypass` / `.data` / `.browser_surfaces` - how an agent REACHES an
  observable state. With a route on record, "auth-walled, could not verify" is not available as
  a reason. `drive.confirmed: false` means nobody was asked: an open question, never evidence a
  surface is unreachable - ask the human, or offer `receipts init --force`.
- `verify.test_command` / `suite_command` - how this project runs one test and the suite. The
  receipt runs through these, never through a command you invent.
- `build.verify_against` + `environments` - the deployed build G3 checks against.
- `gates.enabled` / `disabled` / `medium` and `claim.downgrade_tags` - which gates apply, in
  whose terms, and the exact tags an honest non-fix carries.

No config yet? The `setup` skill owns the interview: `receipts init` asks a human four things
detection cannot find; `init --yes` to get past them is denied outside CI.

## The receipt (the one non-negotiable)

Before claiming a fix, write a red-before / green-after acceptance test in the project's own
framework:

1. It FAILS on the current code - it reproduces the reported bug (G0).
2. It PASSES after your fix - the symptom is gone.
3. It asserts the symptom the REPORTER described, not a proxy: read the node the consumer
   perceives, at the far end of the path; for a "not showing" symptom the rendered surface,
   never the data that feeds it; for a rendered collection the COUNT. Pin exact values
   (`=== 6`), never "not the old value" (G14).
4. Falsify it: name a way the symptom could still be present while the test stays green. If
   you can, retarget the assertion onto the thing the reporter perceives.

On the deployed build, make the evidence machine-checkable rather than a screenshot:
`receipts observe --cmd '<read the reporter's value on the live build>' --expect '/<value>/' --sha-cmd '<print the live sha>'`
(or `--url <https>`) emits a `LIVE-RECEIPT` line the Stop hook accepts as by-value evidence bound
to the build; `met:false` records that the symptom is NOT gone.

The work type shifts what the receipt asserts, never whether there is one: a feature's test is
red until the behavior exists; a migration's fixture includes legacy rows; a refactor inverts to
"the existing suite stays green" - say `work-type: refactor` in the PR body.

## The gates, one line each

**Verify gates - did you prove it works?** (re-runnable at the PR)

| | |
|---|---|
| G0 | Reproduce the reported symptom FIRST; that observation is the acceptance test. |
| G1 | Assert the rendered VALUE at the far end, on the node the consumer perceives; the positive behavior, not "the error is gone". |
| G3 | Verify on the build that carries YOUR commit: observe the live sha, never infer it from a green merge. |
| G5 | Drive a multi-step flow to its TERMINAL action, accepting pre-filled defaults. |
| G9 | Trustworthy green: full suite, unmasked exit, prod-like engine, repeatable, isolated; a mocked boundary proves nothing about that boundary. |
| G11 | Never shoot the referee: no deleted or skipped tests, no loosened assertions, no snapshot regeneration; a removal is declared with `test-removal: <why>`. |
| G13 | The receipt must EXERCISE the diff: changed lines no test runs are unverified changes. |
| G14 | The receipt must have TEETH: it goes red when the changed lines are deliberately broken. |

**Target gates - did you fix the RIGHT thing, all of it?** (your judgment, as you work)

| | |
|---|---|
| G2 | Pin the exact flow AND the reporter's context: role, tenant, flag bucket, locale. |
| G4 | Land on the surface the reporter SEES; a change invisible there is the wrong surface - revert it. |
| G6 | Sweep the twins, keyed on the observable: every producer of the field, route or label, read-side and write-side; the receipt is the enumeration query (residual-zero for a sweep). |
| G7 | Verify the DEPENDENTS of what you changed, above all consumers new since you branched. |
| G8 | Fresh base: build off origin's current tip and re-run green after the rebase. |
| G10 | Rollout compatibility across the deploy window, including route REGISTRATION: an unregistered route returns the layer's HTML 404 to a JSON caller. |
| G12 | Fix the CAUSE, not the alarm: no deleted checks, empty catches or loosened validators; never special-case CI or the test env in production code. |
| G15 | Force two copies of one fact to AGREE: derive one from the other, or add a check that fails on divergence. |
| G16 | Repair or disclose EXISTING instances: name the reporter's own artifact and its disposition. |
| G17 | A downgrade reason recurring past `gates.G17.downgrade_threshold` is a missing capability: name it, never block on it. |
| G18 | Prove a data transform on the DESTINATION: its contract, a unique key with an identity match rate, by-value reconciliation over the FULL population, column and grain coverage, sentinels, in-flight rows, contradictory flags. |
| G19 | Fix the whole CLASS: write the predicate that selects the reporter's case, run it over the population, and assert the class is EMPTY. |

Honor `gates.enabled` / `gates.disabled`: a library disables the deploy-surface gates, a single
repo disables G10. `references/GATES.md` carries the full mandate and the scar behind each gate.

## The honesty ladder

- **fixed** - reproduced and observably gone on the right build. The only success.
- **unverified-reasoned** - real root cause plus a test on the path, but you could not observe
  it; route to someone who can.
- **speculative** - no confirmed cause; loudest flag, human sign-off on money / auth / contracts /
  destructive migrations.
- **reverted** - backed out (e.g. wrong surface).

Carry the rung as a tag (`unverified-reasoned: <why>`) in the close-out and the PR body. "I
could not verify this" is respectable; a false "fixed" is not.

## Trajectory memory

At session start the plugin injects this repo's prior scars (failures first, one per surface):
the first thing not to repeat. Query more with `query_trajectory({ surface })` before pinning a
fix, and at EVERY exit - fixed, downgraded, reverted or blocked - record
`append_trajectory({ repo, surface, symptom, root_cause, outcome, what_worked, what_failed, files })`.

## In-session tripwires

Three PreToolUse guards fire at the risky action, only where a config exists, in the posture the
project chose under `agent.tripwires` (per guard: `deny` | `ask` | `warn` | `off`; the default is
`ask` - the human is prompted with the reason - or `deny` under CI, where nobody can be asked):

- **commit-without-verification** - a `git commit` after editing production source with no test
  or `receipts observe` run since. The project's own `verify.test_command` / `suite_command` and
  the common runners count as a run.
- **G11-live referee** - editing a test that a test RUN just showed FAILING, with no green run
  since. Only runner output arms it; a green re-run of the file or of the suite clears it.
- **init unattended** - `receipts init --yes` without the interview's `--drive-*` answers,
  outside CI. This one runs before any config exists.

When a block genuinely does not apply, carry the ack IN the action, never a silent skip:
`RECEIPTS_ACK='<why>'` before the command, `--no-verify-receipts` in the commit message, or a
`test-removal: <why>` note in the content the edit WRITES (an ack in text being deleted does not
count).

## What this skill is NOT

Not a triage / worktree / PR / deploy pipeline: it is the verification discipline you apply
inside whatever workflow you already use.
