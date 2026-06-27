---
name: seven-gates
description: >-
  Use when fixing a bug, addressing a tester or issue report, or about to claim a
  change is "done" / "fixed" / "working". Enforces the Seven Gates: reproduce the
  reported symptom first, fix the surface the reporter actually sees, drive to the
  terminal action, sweep parallel twins, confirm the right build, and above all
  produce a RECEIPT - a re-runnable acceptance test that is red before the fix and
  green after, asserting the reported symptom. A fix is not done because you say so;
  it is done when the symptom is observably gone.
---

# Seven Gates

The verification discipline behind `receipts`. When you fix or change something your
job is not to *claim* it works - it is to *produce a receipt* that proves it, and to
fix the thing the reporter actually sees.

This skill is the project-agnostic discipline. Project specifics (the test command,
the deploy target, what marks a fix-claim) live in `receipts.config.json` - run
`receipts init` once to create it. The full standard with the real scar behind each
gate is in `spec/SEVEN-GATES.md`.

## The receipt (the one non-negotiable)

Before you claim a fix, write a **red-before / green-after acceptance test** in the
project's own test framework:

1. It FAILS on the current code (proving it reproduces the reported bug).
2. It PASSES after your fix (proving the symptom is gone).
3. It asserts the symptom the REPORTER described - not a proxy. A test that only
   checks a height cap does not prove a too-narrow modal got wider.

That red -> green test is the receipt. A passing screenshot, or a green unrelated
suite, is not.

## The gates

**Verify gates - did you actually prove it works?** (re-runnable at the PR)
- **G0 Reproduce first.** Observe and record the reported symptom before choosing a
  fix; that observation is the acceptance test it must later show GONE.
- **G1 Assert the VALUE.** Read the actual rendered value (not "an element exists,"
  not a placeholder painting the expected text).
- **G3 Right build.** Verify on the build that carries YOUR commit (sha-match), never
  a stale deploy.
- **G5 Terminal action.** Drive a multi-step flow to its final action (submit /
  activate / save), accepting pre-filled defaults; the state seams between steps are
  where fixed-one-broke-another hides.

**Target gates - did you fix the RIGHT thing, all of it?** (your judgment, as you work)
- **G2 Pin the exact flow.** Apps grow parallel copies of the "same" feature; fix the
  one the reporter actually used.
- **G4 Right surface.** Land on the surface the reporter SEES; if your change is not
  visible there, you fixed the wrong one - revert it.
- **G6 Sweep the twins.** A pattern changed on one surface leaves every sibling
  carrying the old pattern - the next ticket. Sweep them, or note the divergence.

## The honesty ladder (when you cannot clear a gate)

A gate you cannot clear does not become a silent "fixed." Pick the honest outcome:
- **fixed** - reproduced and observably gone on the right build (the only success).
- **unverified-reasoned** - real root cause + a test on the path, but you genuinely
  could not observe it; ship routed to someone who can, not as "fixed."
- **speculative** - no confirmed cause; loudest flag, human sign-off on high-stakes
  surfaces (money / auth / contracts / destructive migrations).
- **reverted** - you backed the change out (e.g. wrong surface).

"I could not verify this" is a respectable outcome. A false "fixed" is not.

## Trajectory memory (learn across fixes)

If the `trajectory-kb` MCP is available:
- **At the start**, `query_trajectory({ surface })` - see what was tried on this
  surface before and what failed (a prior wrong-surface trap, pre-recorded).
- **At close-out**, `append_trajectory({ repo, surface, symptom, root_cause, outcome,
  what_worked, what_failed, files })` with the honest outcome - failures included, so
  the next fix on this surface inherits the lesson.

## What this skill is NOT

It is not a ticket-triage / worktree / PR / deploy pipeline. It is the verification
discipline you apply *within* whatever workflow you already use. Bring your own
pipeline; the gates ride along.
