---
name: gates
description: >-
  Use when fixing a bug, addressing a tester or issue report, or about to claim a
  change is "done" / "fixed" / "working". Enforces the Gates: reproduce the
  reported symptom first, fix the surface the reporter actually sees, drive to the
  terminal action, sweep parallel twins, verify the dependents, confirm the right
  build, and above all
  produce a RECEIPT - a re-runnable acceptance test that is red before the fix and
  green after, asserting the reported symptom. A fix is not done because you say so;
  it is done when the symptom is observably gone.
---

# The Gates

The verification discipline behind `receipts`. When you fix or change something your
job is not to *claim* it works - it is to *produce a receipt* that proves it, and to
fix the thing the reporter actually sees.

This skill is the project-agnostic discipline. Project specifics (the test command,
the deploy target, what marks a fix-claim) live in `receipts.config.json` - run
`receipts init` once to create it.

**Which gates apply here:** honor `receipts.config.json` `gates.enabled` / `gates.disabled`
(default: all). A project disables the gates that do not fit it - e.g. G10 in a single
repo with no split deploy, or the deploy-surface gates in a library with no deploy.

**The deep how-to per gate** - the full mandate, the real scar, and the exact enforcement
for each gate - is bundled with this skill in `references/GATES.md`. Read the section for
a gate when you need the detailed procedure (e.g. G8's rebase + migration-leaf check, or
G10's backward-compatible contract change); the list below is the gist.

**Applying the gates in THIS project's medium:** the gates are principles, and what a
"surface" or "value" or "terminal action" means depends on what you ship (a web page vs an
API endpoint vs a library function vs a CLI command vs a data table). `references/MEDIA.md`
maps every gate to the concrete artifact and tool per software type, and gives a template
for any type not listed. Use `receipts.config.json` `gates.medium` as the hint for which
mapping applies; if it is unknown or missing, infer the medium from the stack and apply the
principle. Do NOT default to "use the browser" - read the value where THIS project's
consumer actually sees it.

**Applying the gates by WORK TYPE:** the spec is written for fixes, but the receipt is just
TDD and applies to any change - what shifts is what the receipt asserts (the acceptance
criterion). Determine the work type from the task: a fix reproduces the reported symptom; a
**feature** writes the acceptance test for the new behavior first (red until it exists); a
**migration** tests a fixture incl. legacy rows + expand/contract ordering (G10); a
**refactor** INVERTS the receipt - there is no red-before, the proof is the existing full
suite staying green (G9), so a test that passes on base too is correct, not a weak receipt.
See `references/WORK-TYPES.md`. For a refactor/chore, signal it with a `work-type: refactor`
line in the PR body so the enforcer expects the inverted receipt.

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
- **G9 Trustworthy green.** The receipt's green must be full-scope (the whole suite on
  head, not just the changed test), unmasked (no `cmd; echo; tail` that exits 0 and
  hides a failure), and run on a prod-representative engine (real DB / browser, not a
  substitute that passes where prod fails).

**Target gates - did you fix the RIGHT thing, all of it?** (your judgment, as you work)
- **G2 Pin the exact flow.** Apps grow parallel copies of the "same" feature; fix the
  one the reporter actually used.
- **G4 Right surface.** Land on the surface the reporter SEES; if your change is not
  visible there, you fixed the wrong one - revert it.
- **G6 Sweep the twins.** A pattern changed on one surface leaves every sibling
  carrying the old pattern - the next ticket. Sweep them, or note the divergence.
- **G7 Verify the dependents.** Your change has consumers; a freshly-pulled change may
  now route through what you edited (e.g. your input field is now a chart's data
  source). Enumerate the changed surface's dependents, flag the ones new since you
  branched, and verify those still work - an integration break is neither your surface
  (G4) nor a twin (G6).
- **G8 Fresh base.** Recon and build off origin's CURRENT tip, not a long-lived local
  checkout; rebase onto the live tip and re-run green before merge, and resolve
  migration-number / leaf collisions. A green earned on a stale base is green on code
  that will not ship.
- **G10 Rollout compatibility.** When a change splits across separately-deployed halves
  (BE/FE, two services), make the contract backward-compatible or sequence the deploys -
  the system must not break in the window where one half is new and the other is old. A
  new endpoint is unreachable until its proxy ships too.

G7, G8, and G10 are the multi-dev gates: they only bite because other people push in
parallel and the codebase changes under you.

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
