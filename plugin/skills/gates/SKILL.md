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
4. Falsify it before you trust it: name a way the symptom could still be present while
   this test stays green. If you can, you are asserting a PROXY - a stand-in (a
   container, attribute, class, or a count of changes) that carries your INTENT while
   the perceived thing (the child that renders it, the pixels, a downstream artifact)
   differs. Move the assertion onto the perceived thing itself.

That red -> green test is the receipt. A passing screenshot, or a green unrelated
suite, is not.

**On the deployed build (G1/G3), make the evidence machine-checkable, not a screenshot.**
When you verify the fix on the live build, run `receipts observe` - it probes the deployed
URL / staging query / installed CLI, checks the output MEETS your expectation, binds the
observation to the build sha, and emits a `LIVE-RECEIPT` line the Stop hook reads as
by-value-bound-to-build proof:
`receipts observe --cmd '<curl/query reading the reporter's value>' --expect '/<the value>/' --sha-cmd '<print the live build sha>'`
(or `--url <https>` for a direct fetch). A `met:true` receipt bound to the build clears the
deployed-build gate; a `met:false` one records that the symptom is NOT gone. See
`references/LIVE-RECEIPT.md`.

## The gates

**Verify gates - did you actually prove it works?** (re-runnable at the PR)
- **G0 Reproduce first.** Observe and record the reported symptom before choosing a
  fix; that observation is the acceptance test it must later show GONE.
- **G1 Assert the VALUE.** Read the actual rendered value (not "an element exists,"
  not a placeholder painting the expected text) - and off the element the consumer
  actually perceives, not a stand-in that reports your intent (a container whose child
  renders it, an attribute mirroring the value, a computed style on a node other than the
  one that paints it). Corollary: assert the POSITIVE
  behavior (the value arrives, the action succeeds) - "the error no longer appears"
  is a receipt a silencing fix (G12) passes.
- **G3 Right build.** Verify on the build that carries YOUR commit (sha-match), never
  a stale deploy. The artifact is code + CONFIG: the right sha under the wrong
  feature-flag bucket is still the wrong build. OBSERVE the live sha - never infer it from
  an upstream success: a merge returning MERGED and every CI job green say nothing about
  whether the deploy rolled, and a FAILED deploy leaves the previous artifact serving, so
  the system stays up and answers on old code while a newly-merged client calls endpoints
  it does not have.
- **G5 Terminal action.** Drive a multi-step flow to its final action (submit /
  activate / save), accepting pre-filled defaults; the state seams between steps are
  where fixed-one-broke-another hides.
- **G9 Trustworthy green.** The receipt's green must be full-scope (the whole suite on
  head, not just the changed test), unmasked (no `cmd; echo; tail` that exits 0 and
  hides a failure), run on a prod-representative engine (real DB / browser, not a
  substitute that passes where prod fails), and repeatable (a flaky red/green proves
  nothing - deflake before you trust it). It must also be ISOLATED: a green earned on a
  resource a concurrent run can mutate (a shared DB/schema, fixture dir, port, seeded
  account) is not green - give the run its own resource or take a lease. Triage rule: when
  a suite fails at implausible scale (hundreds or thousands of failures from a small diff),
  suspect the shared resource BEFORE the code.
  ROUND-TRIP: a test that MOCKS the boundary the fix depends on says nothing about that
  boundary. For any symptom involving data being SAVED, do one create -> persist ->
  read-back against the real store and trace the payload to the column it lands in;
  if there is no column for it, the fix itself is incomplete.
- **G11 Don't shoot the referee.** Never delete a failing test, add `.skip`/`.only`,
  loosen an assertion, or regenerate snapshots to get green - the suite must keep its
  assertion power. A test that genuinely must go is declared honestly
  (`test-removal: <why>` in the PR), never removed quietly.
- **G13 The receipt must exercise the diff.** One narrow receipt does not verify 500
  changed lines. Keep the diff congruent with the claim: split unrelated changes out,
  or cover them - changed lines no test executes are UNVERIFIED changes.
- **G14 The receipt must have teeth.** The enforcer will BREAK your changed lines on
  purpose (flipped comparisons, nudged numbers, knocked-out returns) and your receipt
  must go red against each broken variant. Write assertions that pin EXACT values
  ("=== 6"), never "not the old value" - a receipt that only excludes the old bug
  passes any new one.
- **The receipt lock.** If the PR/issue carries `receipt-lock: <sha256>`, the receipt
  content is APPROVED and pinned - make it pass; do NOT edit, weaken, or replace it
  (the enforcer blocks the mismatch). If you believe the locked test is wrong, say so
  and stop: re-approval belongs to whoever owns the contract, not to you.

**Target gates - did you fix the RIGHT thing, all of it?** (your judgment, as you work)
- **G2 Pin the exact flow.** Apps grow parallel copies of the "same" feature; fix the
  one the reporter actually used - including the reporter's CONTEXT: role/permissions,
  tenant, feature-flag bucket, locale. Reproducing as admin when the bug is
  user-only is the wrong flow.
- **G4 Right surface.** Land on the surface the reporter SEES; if your change is not
  visible there, you fixed the wrong one - revert it.
- **G6 Sweep the twins.** A pattern changed on one surface leaves every sibling
  carrying the old pattern - the next ticket. Sweep them, or note the divergence. For a
  mechanical sweep (codemod / rename / pattern replace), the receipt is a residual query
  returning ZERO old-pattern matches tree-wide, not the count of sites changed - only
  residual-zero proves completeness (and catches sites the matcher was too narrow to reach).
  KEY ON THE OBSERVABLE, not the module: "I checked the invoices area" over-collects into
  a blob that gets skimmed. Enumerate every PRODUCER of the exact field / route / label /
  status the reporter named. READ-side twins = two serializers or endpoints serving the
  value; WRITE-side twins = two STORES of the same state (a row + a denormalized flag) -
  update every writer, or make the read path suppress the stale one (a read-time exclusion
  self-heals rows already written wrong, no backfill). Carry the enumeration QUERY and its
  result as the receipt; if there is one producer, say "single producer confirmed" WITH the
  proving query.
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
  new endpoint is unreachable until its proxy ships too. REACHABILITY is the other axis:
  where the client reaches the server through a per-route registration layer (proxy
  handler, gateway route, URL config, rewrite table), that registration IS part of the
  contract - an unregistered route returns the layer's HTML 404 / app shell to a caller
  expecting JSON, and neither side's unit tests can see it (the server's call the handler
  directly, the client's mock the transport). Exercise the new route once end to end
  through the real routing layer, or assert its registration statically.
- **G12 Fix the cause, not the alarm.** A symptom can be SILENCED: the 403 "fixed" by
  deleting the permission check, the error toast by an empty catch, the rejected input
  by loosening the validator. Before closing, answer: did I repair the invariant or
  mute its detector? If the check itself was the bug, say so explicitly in the PR.
- **G15 Force duplicated facts to agree.** When one fact lives in two places (a shape
  declared twice, a quantity computed in two modules, a literal vs the enum it refers to),
  derive one from the other or add a check that FAILS on divergence. Scope: only where
  divergence is SILENT and the copies are independently edited - if changing one copy
  turns nothing red, this applies. Matching values today is not a check.
- **G16 Repair or disclose existing instances.** A fix usually corrects the PRODUCER, not
  the values already produced. If the symptom is a stored artifact (record, document,
  cached value), state what happens to existing ones - self-heals (name the trigger),
  backfilled (give the count), or permanent (give the reason) - and name the REPORTER'S
  own instance explicitly. They re-test the thing they filed; disclosure satisfies this,
  silence does not.
- **G18 Prove a transform on the DESTINATION, not the source.** Moving or reshaping
  data (migration, backfill, import, ETL): row counts reconciled against the SOURCE
  prove only that you moved the right NUMBER of rows. Derive the contract from the
  DESTINATION - types, enums, ranges, required-ness, referential integrity - and
  validate against it. **A clean load is not evidence when the destination cannot
  reject**: free-text enums, unenforced FKs and permissive parsing accept wrong data
  silently. **Prove the join key identifies the same entity** against an independent
  attribute and state the match rate - and first assert the key is UNIQUE in the
  source (`GROUP BY key HAVING COUNT(*)>1` empty), else join on the surrogate id.
  Reconcile BY VALUE over the FULL population (count mismatches, require zero) -
  row-count parity is not value parity, and a sample is not a reconciliation - a wrong key yields a
  complete-looking result where every row is attached to the wrong thing. ****MUTUALLY EXCLUSIVE states**: when two flags that cannot both be true
  are both set (a success flag set at submit and never cleared on failure, beside the
  authoritative status), declare the PRECEDENCE in business terms and verify the
  destination honoured it for every affected row - detecting the contradiction is the
  easy half. Then fix every downstream reader of the losing flag. Take a
  field's meaning from the producing system's BEHAVIOUR, not its name.** An inferred meaning is
  a hypothesis - write the COUNTEREXAMPLE QUERY (rows where the name predicts one thing
  and the authoritative field says another); zero rows supports it, any rows refute it
  and the count is the blast radius. State
  COVERAGE for COLUMNS as well as rows (a column never carried moves every row with one
  field silently absent - account for each source column as mapped / dropped /
  defaulted), assert the GRAIN survived (a one-to-many collapsed to one-to-one loses
  information while every count still reconciles), state coverage
  (in scope / transformed / skipped + why) and the PROVENANCE + date of any
  hand-supplied mapping file. Scope a reload to tables the transform OWNS - never
  app-managed rows created after cut-over.
- **G19 Fix the whole CLASS, not the reported instance.** A bug arrives as one example;
  that example is a SIGNATURE, not a scope. Write the predicate that makes the reporter's
  case wrong (the query or condition that selects it), run it over the ENTIRE population,
  and fix every match. The receipt asserts the CLASS is empty - the count of still-matching
  rows or call sites is zero - not that one row is now right, because the reporter's next
  example comes from the population you left behind. "Fixed the example, flagged the rest
  as a TODO" is the anti-pattern: narrowing to a subset needs explicit owner sign-off
  naming what is excluded and why, obtained BEFORE closing, never the silent default. Every
  medium: a data defect fixes all matching rows, a code defect fixes every call site (G6's
  twin sweep made mandatory and COUNTED), a migration reconciles the whole table.
- **G17 A repeated downgrade is a missing capability.** Track downgrade reasons across the
  run, keyed by (reason x surface-class). When one reason recurs past the threshold
  (`gates.G17.downgrade_threshold`, default 3), name the missing capability in the run
  summary. Do NOT block the item - blocking just pressures a false "fixed."

G7, G8, and G10 are the multi-dev gates: they only bite because other people push in
parallel and the codebase changes under you. G15-G17 are the durability gates: the change
is correct now and wrong later or elsewhere (copies drift, existing records stay broken, an
honest escape hides a missing capability). G11-G14 are the
optimizing-agent gates: they exist because "make the check green" and "make the code
right" are different objectives - never optimize the first at the expense of the
second. Never special-case the test/CI environment in production code
(`process.env.CI`, `NODE_ENV === 'test'`) - G12 flags it as the gamed-gate shape.

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

Memory now **pushes**: a SessionStart hook (`session-memory.mjs`) injects this repo's prior
scars (failures first, one per surface, capped small) into your context at session start, so
you arrive already warned even before you query - if you see a "receipts trajectory memory"
note listing prior dead ends, treat it as the first thing to not repeat. It is on by default
when a `receipts.config.json` is present (`agent.memory_inject: "off"` disables it). You can
still pull the full picture yourself:

- **At the start**, `query_trajectory({ surface })` - see what was tried on this
  surface before and what failed (a prior wrong-surface trap, pre-recorded). From the
  terminal, `receipts kb recur` shows which surfaces recur and `receipts kb distill`
  turns the pattern into concrete config suggestions.
- **At close-out**, `append_trajectory({ repo, surface, symptom, root_cause, outcome,
  what_worked, what_failed, files })` with the honest outcome - failures included, so
  the next fix on this surface inherits the lesson (and gets pushed into the next session).

## In-session tripwires (guards that fire before the PR)

Two small PreToolUse guards sit BETWEEN the Stop-hook backstop and the CI enforcer, so a
weak agent is caught at the moment of the action, not a stop-cycle or a PR later:

- **commit-without-verification** - a `git commit` right after you edited production source
  with NO test / `receipts observe` run in between is blocked. A commit is a claim it works
  (G0/G9); run the tests first, then commit.
- **G11-live referee** - editing a TEST file whose test you just saw FAILING (no green
  since) is blocked. Fix the code the test caught, not the test.

Both are DENY-by-default with the SAME explicit, greppable escape as the honesty ladder -
never a silent skip. When the block genuinely does not apply, carry the ack IN the command
or the edit:
- `RECEIPTS_ACK='<why>'` prefixed on the command (e.g. `RECEIPTS_ACK='wip checkpoint,
  tests before PR' git commit ...`), or `--no-verify-receipts` in the commit message, or
  `RECEIPTS_TRIPWIRE=off` inline;
- for the referee tripwire, a `test-removal: <why>` note in the edit is the honest,
  reviewed way to change a test that truly must go.

Turn either off or tune the runner list under `agent.tripwires` in `receipts.config.json`.

## What this skill is NOT

It is not a ticket-triage / worktree / PR / deploy pipeline. It is the verification
discipline you apply *within* whatever workflow you already use. Bring your own
pipeline; the gates ride along.
