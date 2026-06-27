---
name: feedback-fix-loop
description: >-
  Run a feedback/bug ticket end to end: triage the ticket AND its comments, pin
  the exact flow the reporter means, fix in an isolated worktree, gate, deploy,
  browser-verify the fix BY VALUE on the deployed build, then close the ticket
  with an in-thread reply. Use for any tracker-driven fix cycle (Notion, Jira,
  GitHub issues, Linear) on any project - "fix this ticket", "address the
  comments on #NN", "the tester reopened X", "run the loop". Project facts
  (repos, branches, deploy targets, ticket board, commit identities) come from
  the project's own skill/CLAUDE.md/memory - this skill is the project-agnostic
  skeleton plus the guardrails that prevent false "fixed" claims.
---

# Feedback fix loop

The standard pipeline for turning a feedback ticket - or a reporter's follow-up
comment - into a shipped, verified, closed fix. The mechanical steps are easy;
the guardrails are the point. Every one of them exists because skipping it has
shipped a wrong or unverified "fix" at least once.

**Project facts live elsewhere.** Before running, load the project's facts from
(in order): a project-level skill (e.g. `<project>/.claude/skills/*`), the
project CLAUDE.md, and auto-memory. You need: repo paths + integration
branches, gate commands, commit identity rules, deploy target + how to confirm
a deploy, the ticket board + status taxonomy, and the staging URL. If any of
these is missing, ask - do not guess. **Bootstrapping a new project?** Copy
`references/project-facts-template.md` (in this skill's directory) to
`<project>/.claude/skills/<project>-loop/SKILL.md` and fill in the
placeholders - it carries the section skeleton this loop expects, including
the G5 terminal-action and G6 twin-surface hooks.

---

## The guardrails (more important than the steps)

### G0 - Reproduce the reported symptom FIRST; the observed failure IS your acceptance test
Before choosing a fix, OBSERVE the symptom the reporter described and capture what
you saw - that observation is the exact thing your by-value check (G1, step 9) must
later show GONE. "My change is deployed/live" is NOT verification: your change being
live is not the same as the reporter's symptom being resolved. (Proof: a "modal cut
off" report was read as a vertical footer-clip; a height cap was built, gated,
deployed, and "verified by value" that the cap was applied - all green - while the
real bug was the modal being too NARROW. The wrong axis shipped; only the reporter
caught it.) This gate is the SYMPTOM side - reproduce the observable so step 9 can
show it GONE; finding WHY (so the fix addresses the cause, not the symptom) is a
SEPARATE discipline, `superpowers:systematic-debugging` at step 4, which REUSES this
same reproduction. Shorthand: G0 makes you verify the right thing; systematic-debugging
makes you fix the right thing - they share only the reproduce step, not the job.

The escape hatches below REPLACE a hard rule with judgment, so each is defaulted-
STRICT and STRUCTURED (the skeptical-default shape you use in coupling_review) -
never a free-text afterthought, which is a loophole, not a gate. The litmus: could
someone reading the ticket in six weeks tell, without ambiguity, exactly what WAS and
was NOT verified and why, with a tracked path to close any gap? If not, you have not
implemented the gate.

**(A) Ambiguous symptom word** ("cut off", "broken", "weird", "thin", "slow",
"doesn't work") - pin the exact observable BEFORE building: reproduce it, or ask ONE
clarifying question. Never infer which symptom they mean.

**(B) Repro-gate: default = REPRODUCE; skipping is the recorded exception.**
- Skipping requires a one-line reason a reviewer can challenge - not a silent call.
- "Obvious enough to skip" = obvious CAUSE + an unambiguous, graphify-confirmed fix
  LOCATION, NOT an obvious-looking symptom. The classic wrong-fix is "looked obvious,
  patched the obvious thing, missed that the real cause was a different surface" (the
  G4 wrong-surface miss graphify exists to catch).
- Reporter/tester-sourced symptom -> repro is MANDATORY, never skipped (same rigor as
  read-the-full-thread / pin-the-exact-flow).
- Skipping end-to-end repro is NOT skipping evidence: a cheap regression/unit test
  that exercises the fixed code path is the substitute.

**(C) Can't reproduce - separate the two flavors; never blur them:**
- PRECONDITION before ANY downgrade - "can't observe" means you EXHAUSTED the available
  automation, NOT that your first method failed. Try the browser MCP against the user's
  LIVE authenticated session first (Claude-in-Chrome on their open tab), then Playwright /
  Chrome DevTools / the preview tools. A surface reachable by clicking a VISIBLE button
  (e.g. "Add Account" -> a 6-step wizard) is OBSERVABLE; shipping it `unverified-reasoned`
  because a grep or a viewport-resize didn't pan out is the escape hatch used as a first
  resort. Real miss: claimed a wizard "can't be driven", shipped unverified - it opened in
  ~6 clicks from the customer page in the user's own browser, and driving it showed the
  fix was correct AND surfaced a requirement-polarity question the static read had hidden.
- Can't OBSERVE (env limit, e.g. a viewport you can't shrink) BUT you have a REAL root
  cause + a test exercising the fixed path -> ship ONLY as a STRUCTURED DOWNGRADE,
  never a clean "fixed": a distinct status `unverified-reasoned`, a required reason,
  ROUTED to whoever can observe it (in the reporter's thread: "shipped; not
  reproducible in my env, please confirm on retest") + a tracked "verify-when-
  observable" item with a real DISPOSITION: either it lands in a NAMED, QUERYABLE
  destination (a board status / label / field, a saved view, the tester's retest
  queue), OR you surface it explicitly to a human in-session who decides how - or
  whether - to track it. The closed loop is the DECISION, not the medium: an in-chat
  flag counts ONLY if it forces that disposition and you do NOT treat the fix as done
  until the decision is made. A dropped FYI is not tracking - a chat line or a buried
  PR sentence that nobody acts on lets unverified fixes pile up SILENTLY, the exact
  debt this gate exists to surface.
- Can't observe AND no identified cause = guessing -> do NOT ship-as-fixed. Get more
  info from the reporter (repro steps / screenshot), or - only if truly forced - ship
  under a louder, DISTINCT `speculative - no root cause` flag - and HARD-GATE that path, because it is the
  closest thing to a legitimate "ship anyway" and so earns the TIGHTEST leash: NEVER
  silent; on money/auth/contract/migration NEVER without explicit HUMAN sign-off (the
  agent may NOT self-approve it - block and ask); and auto-listed in the SAME named
  destination for follow-up. It is a scarier thing than `unverified-reasoned`; never
  relabel one as the other.
- RISK-GATE the downgrade itself: on high-blast-radius surfaces (money/ledger, auth,
  service/API contract, destructive migration) "can't repro" stays close to a BLOCK or
  demands stronger compensating evidence (more tests, a second reviewer, a
  seeded/staged repro). The easy downgrade is for low-blast-radius ONLY.

**(D) Observation blocked at DIAGNOSIS time -> a code-inference is a HYPOTHESIS,
not a stated fact.** When you cannot drive the live surface, do NOT promote "the
code seems to show X" into "X is true." Two misses in one sitting on one ticket: a
narrow grep -> "this flow has no prospect concept" (false - the user could see the
selector); then "prospect = account_status" (false - tsc proved no such enum value;
the real field was `classification`). Both were inferences ASSERTED as fact about a
surface I could not watch. This is the diagnosis-phase twin of (C) (which governs the
SHIP claim); here the PREMISE is what's unverified. Guard:
- State the inference AS an inference ("from the schema it looks like X; I could not
  drive the UI to confirm"); on anything load-bearing, cross-check it against the
  AUTHORITATIVE definition (the enum / type / schema / contract), not one grep.
- Treat a failing gate as a PREMISE-check, not a nuisance: a tsc "no overlap" or a
  test that contradicts your assumption is REFUTING the diagnosis - stop and
  re-ground, don't just edit until the compiler goes quiet.
- If the premise still isn't confirmable from code, ASK the reporter/user (they can
  observe) before building on it. A cheap question beats a confident wrong build.
- **For a render-shaped symptom (wrong value / wrong label / missing or duplicated
  row), the AUTHORITATIVE source at diagnosis is the LIVE RENDERED build, not the
  enum/type/schema.** The contract can be correct while the bug lives in the render
  path (a mislabel, a branch-ordering short-circuit, a display-mapping collision),
  so reading the code/contract alone "confirms" the wrong conclusion. Drive the
  current deployed surface per (C)'s authed-session precondition and read the actual
  rendered value BEFORE writing the fix. Proof: a missing "Remittable fees" row was
  diagnosed from the schema as a pure data gap (fix = seed the data, no code change);
  the live build showed the data WAS present but the row rendered under the wrong
  label - an ordering bug in the display-label mapping - so the first fix was a no-op
  and the real fix needed a second PR + deploy cycle. Green CI + passing unit tests
  did not catch it (the fixtures used a label that dodged the ordering bug); one live
  read at diagnosis would have.
- **For a PROGRESSION / interaction symptom (won't advance, "stuck on a step",
  "can't proceed", nothing happens, a button errors on re-click) the authoritative
  source is DRIVING THE LIVE FLOW TO THE FAILING ACTION - and a DB query is NOT a
  substitute.** This is the render bullet's twin for behavior: the backend can be
  fully CORRECT while the FE fails to reflect it, so reading the DB row (a status,
  a step counter, an FK) "confirms" a phantom data/seed bug and hides the real FE
  one. "Verify by value" here means the value the REPORTER perceives - did the step
  advance, did the terminal action succeed - NOT a column value; the DB is only the
  backend half. Drive the reporter's exact click on the deployed build BEFORE
  writing the fix. Proof (2026-06-24): a Refund/Reissue "stuck on Step 3" blocker
  was diagnosed from the DB (workflows at current_step=3 with a replacement linked)
  as "inconsistent seed data" and a backend SEED fix was built + gated green;
  driving the live flow showed the backend Generate SUCCEEDS and the FE never
  advances past Step 3 (an FE off-by-one). The seed was the wrong surface and was
  reverted - one live drive at diagnosis would have skipped the whole detour.
- **A ticket's stated cause is a HYPOTHESIS, not the diagnosis - a ticket YOU
  authored earlier from inference is the most dangerous, because re-reading it
  launders your own guess into "fact".** Re-reproduce the symptom yourself per the
  class rules above before building the fix the ticket's framing implies. (The
  Step-3 detour above began from a ticket I had written from a DB inference, then
  executed without re-observing - the inference never got re-tested against the
  live surface it was about.)

### G1 - Assert the rendered VALUE, never presence or the placeholder
A grey placeholder showing the expected text is a FAIL. "An input exists" is
not a pass. Read `input.value` / the selected option / `checked` / the rendered
number via the DOM on the **deployed** build. Uncontrolled form libraries (e.g.
React Hook Form `defaultValues`) frequently paint correctly in dev + jsdom and
empty in production - "the test passes" and "the screenshot looks right" are
both insufficient. The `parity-sweep` skill is the methodology in depth; use
its scoped mode for single-fix verification.

### G2 - Pin the EXACT flow/component the reporter means
Apps grow parallel flows for the "same" feature (an onboarding wizard AND a
detail-page dialog; a summary card AND a drill-in page), each with its own copy
of the logic. Fixing or verifying the wrong one looks like progress and ships
nothing. Reproduce the reporter's path before touching code; when ambiguous,
ask.

### G3 - Verify on the build that contains your commit
Never verify against a stale deploy. Confirm the deployed artifact's commit sha
matches your push before driving the UI (the `deploy-verify` skill). A green
check on the old build proves nothing.

### G4 - The fix must land on the surface the reporter SEES
Code search finds *a* component that renders the words; the reporter's screen
may be a different one (Today-proof: a premium-type badge was first added to a
per-invoice expand panel when the visible surface was the page-level card).
After deploying, drive the reporter's actual screen - if your change isn't
visible there, you fixed the wrong surface. Revert the wrong-surface change
rather than leaving two competing copies.

### G5 - Drive the changed flow to its TERMINAL action
Changing one step of a multi-step flow (wizard, checkout, pipeline) is not
verified at that step. Drive the flow to its terminal action (Activate /
submit / save) on the deployed build, down the path a real user takes -
including ACCEPTING pre-filled defaults rather than re-typing them. The state
seams between steps (local form -> shared store -> final validator / submit
payload) are where fixed-one-broke-another lives: a step that validates its
own form while the final gate validates the shared store passes Next and fails
the terminal action (Proof: a restructure seeded a policy form's broker/agency
from earlier steps; they painted and passed Next but never synced to the
store, so Activate rejected "Required" fields the reporter could see filled -
filed as a new High blocker one day later). When hand-driving the whole flow
is slow or fragile, construct the state through the app's own API (create a
draft/record in the target state, resume it) and assert the persisted state
by value.

### G6 - Sweep the changed pattern's PARALLEL surfaces before closing
G2's twin problem, on the output side: apps implement the same affordance
separately in sibling flows (two wizards' preview cards, nav badges, contact
rows, input masks). A fix that changes a PATTERN on one surface - icon
placement, label, mask, color convention - creates a reporter-visible
inconsistency on every twin still carrying the old pattern, and that becomes
the next ticket (Proof: "add an Edit label" -> reopened "the account section
lacks it" -> reopened "now move it left to match the customer screen" - three
cycles for one affordance). Before closing: enumerate the pattern's parallel
instances (grep the component/icon/classname; if a graphify graph exists, ask
"what else renders this") and apply the same change or note the divergence in
the ticket reply as a conscious deferral. Prefer fixing consistency by SHARING
the implementation (extract the component) over copying the patch - twins that
share code cannot drift.

---

## The verification gate (hook-enforced - the one step that keeps getting skipped)

The recurring, trust-destroying failure: claiming a ticket FIXED on the strength of
a PROXY - green CI, a passing unit test, a deployed sha, a DB row, a confident code
read - WITHOUT observing the reporter's symptom gone on the deployed build. The
tester catches it and resubmits. This gate is the one step with no external referee
(everything else has CI / the compiler / a hook), so it loses to the pull-to-finish.
It is now externally refereed - see "Enforcement" below. Do not try to out-argue it.

- **Reproduce-FIRST, and pre-register the acceptance test (step 1/2).** Before any
  code, drive the reporter's flow, OBSERVE the symptom, and write the exact
  observable-that-must-change INTO the ticket ("Acceptance: clicking Generate
  advances to Step 4"). No acceptance line recorded -> not allowed to build. This
  makes the end-check mechanical (re-run that exact step), not "looks right", and
  makes the end-drive nearly free (you are already on the surface).
- **Never write the bare word "fixed." State the EVIDENCE.** A close-out (and any
  "done" you say to the user) must carry: `reproduced <symptom> -> on deployed sha
  <X> -> <the same check now showing the symptom GONE, by value>`. If you cannot
  fill that line with a real observation, you have not earned the claim - downgrade
  it (below). "Deployed / CI-green / the test passes" never fills it.
- **Strictness by symptom class (the bar):**
  - BEHAVIOR / UI / progression / render ("stuck", "won't advance", wrong value,
    missing row) -> a LIVE DRIVE on the DEPLOYED build to the failing action.
    A DB query, a code read, CI, and a passing unit test are CORROBORATION, never
    the verification - the backend can be correct while the FE is broken (G0-(D)).
  - DATA / seed -> a by-value staging query (DB proxy / API) PLUS a get_deployment
    sha-confirm that the deployed build is the one you checked.
- **The escape hatch is a LAST resort, never a first one.** Only a genuine
  can't-observe - you EXHAUSTED the authed-browser / preview / devtools tools, and
  NEVER for a surface reachable by clicking a visible button - may ship as a LOUD,
  distinct `unverified-reasoned: <why unobservable + the unit test that covers the
  path>`, routed to the reporter ("please confirm on retest"). Quiet skips, and
  "my first method did not pan out", are the abuse this gate exists to stop.
- **Enforcement:** `~/.claude/hooks/stop-verification-gate.py` (a Stop hook) BLOCKS
  the turn when a ticket is moved to Fixed-Pending-Retest / Verified but the session
  does not show, AFTER the merge, BOTH of: (1) a DEPLOY-BINDING - you are on the
  deployed build (a navigate to the app host / a Preview tool / get_deployment / a
  staging DB query); AND (2) an OBSERVATION - you saw the rendered value (a screenshot,
  a by-value DOM read via javascript_tool / read_page / a snapshot, or a by-value
  staging query) - and there is no `unverified-reasoned` tag. **A bare navigate or a
  lone get_deployment is a touch, not an observation, and no longer passes:** arriving
  at the build proves you got there, not that the symptom is gone (the loophole the old
  floor allowed). So a UI close needs navigate-to-host PLUS a screenshot or a DOM
  value-read; a data close needs a by-value staging query (itself both) PLUS the sha
  confirm. It is a floor; the by-type bar above is yours to honor. If it fires, do the
  verify (capture the screenshot + the value) or the honest downgrade - do not relabel
  an unverified fix to dodge it.

---

## The loop

1. **Triage the ticket AND every comment.** A closed-pending ticket with a
   fresh reporter comment is REOPENED - comments are new requirements, not
   chatter. Separate: (a) actionable, (b) already-answered, (c) blocked on
   input you genuinely cannot recover (note: if a prototype/design source
   exists in the repo, extract the spec from it YOURSELF before declaring
   anything blocked - "needs a screenshot" is rarely true when the prototype
   code is on disk).
   **Then, before touching any fix: if triage yields more than ONE actionable
   item, the fan-out plan is the MANDATORY next step (not an ad-hoc call) - run
   `fanout-plan` (see Batching) to set the parallel/serial clusters + per-item
   model tier, THEN run the per-item steps below per that plan. One actionable
   item: skip straight to step 2.**
2. **Pin the flow** (G2). If the project has a graphify graph
   (`graphify-out/` exists - see `graphify`), query it FIRST to find which
   component renders the reporter's surface and whether parallel
   implementations of the feature exist (`graphify query "what renders
   <surface>"`, or read `graphify-out/GRAPH_REPORT.md`). **Also query
   trajectory memory FIRST** (the `trajectory-kb` MCP, if available):
   `query_trajectory({ surface, text: <symptom keyword> })` to see what was
   already tried on this surface and what failed - a prior `what_failed`
   ("capped height - wrong axis") is the G4 wrong-surface trap pre-recorded,
   surfaced before you spend a build on it. graphify answers "what renders X"
   (structure); trajectory-kb answers "what did we try on X and what happened"
   (history). Then identify the
   exact component/route and reproduce the SYMPTOM live (G0) - the observed
   failure is the acceptance test your step-9 by-value check must later show GONE
   (graph = hint, live app = truth).
3. **Isolated worktree.** `git worktree add -b <branch> <path> <integration>`;
   symlink untracked deps the build needs (node_modules, .env files, venvs).
   Keep work off the integration branch until gated.
4. **Implement.** For a non-trivial bug, run `superpowers:systematic-debugging`
   first - its Iron Law (no fix without root-cause investigation) is the one
   discipline the gates do NOT cover: G0 already reproduced the symptom for the
   acceptance test, so REUSE that as its Phase 1 (don't reproduce twice) and spend
   the effort on WHY - fix the cause, not the symptom. Recurring traps worth checking
   explicitly:
   - `'' ?? fallback === ''` but `'' || fallback === fallback` - empty-string
     defaults need `||`.
   - A form that errors with "required information" while every visible field
     is filled has a HIDDEN required field being stamped empty.
   - Prefer controlled inputs over uncontrolled defaultValues (G1's render gap).
   - Two-sources-of-truth divergence (G5's code shape): any value that enters a
     form WITHOUT a change event - seed, default, async hydration - must be
     explicitly synced to the shared store the final validator reads. When
     adding a seed/prefill, grep for the store's readers (final validation,
     submit payload) and add a test that runs the REAL final validator against
     the store as a user would leave it (defaults accepted, nothing re-typed).
   - Add a pure-logic unit test for any mapping/seeding/formatting helper.
5. **Gate** - run the `pre-commit` skill: the project's REAL commands
   (typecheck, lint, tests, plus any custom gates like ASCII-only diffs), all
   green before commit. Never claim green without running them
   (`superpowers:verification-before-completion`).
6. **Commit** - via the `git-commit` skill, honoring the project's per-repo
   commit identity + required trailers (never edit git config).
7. **Open a PR and merge only on green CI** (replaces any direct-push that
   admin-bypasses a required check; CI is the authoritative gate). Push the
   branch, open a PR against the integration branch, poll the required check to
   green (deploy-verify-style - do not hammer), then merge with a method that
   PRESERVES THE COMMIT AUTHOR where the deploy platform author-gates the HEAD
   (e.g. rebase-and-merge). NEVER merge red and NEVER admin-bypass the required
   check; on red, read the logs, fix on the branch, re-push. The local
   `pre-commit` gate stays as a fast pre-check. (Project facts - branch names, the
   required check's name, the merge method, the author-gate - come from the
   project skill.)
8. **Deploy + confirm** - run the `deploy-verify` skill: poll until the deploy
   is READY **and** serves your sha (G3).
9. **Browser-verify by value** (G1 + G4) on the deployed build, driving the
   reporter's exact flow, then the flow's terminal action (G5) and the changed
   pattern's twins (G6). **Capture the proof as you verify - a required
   artifact, not a nicety (the Stop gate checks for it):** for a UI/behavior
   ticket, take a SCREENSHOT of the deployed surface AND read the rendered
   value via the DOM (the screenshot is the shareable proof you looked; the
   DOM read is the actual G1 assertion - a screenshot alone can show a grey
   placeholder and pass the eye); for a data ticket, the by-value staging query
   output plus the `get_deployment` sha IS the artifact. If you cannot reproduce
   the original bug, say so - do not assert "fixed". When UI-driving the repro is
   fragile or slow, construct the reporter's state via the app's own API and
   assert persisted state by value - a legitimate repro, often 10x faster.
10. **Close out**: move the ticket to the project's "fixed, pending retest"
    status with concise resolution notes (what changed + that it was
    browser-verified). **The note MUST cite the OBSERVED VALUE, never the bare
    word "fixed" / "verified":** "verified live on the deployed build: the
    Resolved tile shows 3" or "by-value staging query returns resolved_count =
    3" - that observed value is the artifact the gate, the reporter, and the
    next retest all read; a note that says only "browser-verified" has not
    earned the claim. Then reply **in the reporter's comment thread**
    addressing each ask point by point. Net-new deliverables get their own
    ticket so they are tracked for retest - and so does any net-new BUG
    discovered while verifying: file/flag it, never scope-creep the current
    fix or silently drop it. **Then record the trajectory** (see Trajectory
    memory below): `append_trajectory({ repo, surface, surface_key, symptom,
    root_cause, outcome, what_worked, what_failed, files, regressed, tier })`,
    with `outcome` = the exact G0 status you shipped (`fixed` /
    `unverified-reasoned` / `speculative`, or `reverted` if you backed a
    wrong-surface change out). Pass `surface_key` = the canonical primary file
    path or component id (it is what GROUPS recurrences across loops; the server
    auto-derives one if you omit it, but an explicit key is more reliable). Put
    the dead ends - especially any wrong-surface / wrong-axis detour - in
    `what_failed`; that line is what the next loop's step-2 query reads.
    **Append on EVERY loop exit, not only a clean close.** If you exit
    downgraded (`unverified-reasoned` / `speculative`), revert a wrong-surface
    change (`reverted`), or LEAVE THE TICKET BLOCKED / unverified (you cannot
    verify and are handing it back), record it with that honest outcome and put
    the blocker in `what_failed` - those failure entries are the MOST valuable
    ones (they stop the next loop hitting the same wall), and omitting them is
    the survivorship bias that leaves the store ~100% `fixed` and blind to
    recurring pain. The only exit that skips the append is a loop genuinely
    paused mid-flight (not yet exited).
11. **Clean up**: remove the worktree, delete the branch. If the project has a
    graphify graph and you changed code, run `graphify update .` to keep it
    current (AST-only, local, no API cost).
12. **Ratchet the project facts.** If this run taught you a durable mechanic -
    a state-construction shortcut (how to build a repro via the app's API), a
    twin-surface pair, a push/identity quirk, a browser-driving workaround, a
    flaky-looking-but-real gate behavior - write it into the PROJECT skill
    before ending, in the matching section. Auto-memory is for session state;
    mechanics that any future loop run needs belong in the skill, or every
    session re-learns them by trial and error (proof: an entire session's
    worth of click-scaling, push-mechanics, and repro-recipe discoveries sat
    only in memory until a manual audit moved them). One paragraph per fact,
    same style as the section it joins.

## Trajectory memory (cross-loop learning)

The loop's two memory touchpoints, served by the `trajectory-kb` MCP (a global,
repo-tagged, append-only store - it aggregates across repos, so a trap recorded
on one project warns the next). This is the "agents learn from past
trajectories" idea, scoped to this pipeline's discipline instead of a generic
log:

- **Read at the start (step 2, with graphify):** `query_trajectory({ surface,
  text })`. graphify tells you what renders the surface; trajectory-kb tells you
  what was already tried on it and what failed. A past `what_failed` is the G4
  wrong-surface / G0 wrong-axis miss pre-recorded - the cheapest possible way to
  not repeat it.
- **Write at every loop EXIT (step 10), not just a clean close - after the
  by-value verify when there is one:** `append_trajectory(...)`. The `outcome`
  enum is deliberately the G0 ship ladder - `fixed` / `unverified-reasoned` /
  `speculative` / `reverted` - so the store doubles as a queryable history of
  which fixes shipped verified vs downgraded vs blocked, per surface. **Record
  the FAILURES, not just the wins:** a downgraded, reverted, or blocked exit
  (you could not verify and handed the ticket back) is the entry most worth
  keeping - it is what stops the next loop repeating the wall. A success-only
  store is survivorship bias (a recent sample read 100% `fixed`, so it could not
  surface any recurring pain). Record the root cause and, crucially, the dead
  ends in `what_failed`. Pass `surface_key` (the canonical primary file /
  component id) so the same surface GROUPS across loops - free-text `surface` is
  almost never written identically twice, so without the key recurrence is
  invisible (the server auto-derives one, but explicit is more reliable). Also
  pass `files` (the edited files) and, if the fix broke a twin surface (a G6
  miss), `regressed` (that surface) - these feed `fanout-plan`'s history-aware
  tiering and its `regression-history` coupling signal, so a surface with a bad
  track record auto-bumps to the top tier the next time it is planned.

It does NOT replace the step-12 ratchet (durable MECHANICS still go into the
project skill) or auto-memory (session state). Trajectory-kb is the per-incident
"what we tried on this surface and how it turned out" layer - the thing that was
previously locked in a closed ticket nobody re-reads.

## Batching multiple tickets (fan-out)

When one loop run covers several actionable tickets, the FAN-OUT PLAN comes
first: run `fanout-plan` (below) BEFORE dispatching any per-ticket agent - it
decides what parallelizes and on which model tier. Then execute the plan:
tickets in file-disjoint clusters run in parallel, one background agent per
ticket, each in its OWN worktree (step 3) on its assigned tier, while
you do the trust-boundary work serially yourself - review each diff, re-run
the gates fresh, commit/push, deploy-confirm once for the batch, then
verify and close each ticket individually (G1/G4/G5 are per-ticket, never
batched away) - but the by-value verification LABOR is itself fanned out and
PIPELINED with the builds, not saved for a serial end-sweep (see "Parallelize
the verification LABOR" below). Tickets touching the SAME files stay serial in
one worktree. Never let agents push or close tickets themselves - implementation
parallelizes; gating, shipping, and verification do not. EXECUTE the disjoint
clusters CONCURRENTLY (parallel background agents, or the Workflow tool's
`parallel()`/`pipeline()` with worktree isolation) - do not run genuinely-disjoint
work one-at-a-time; sequential (subagent-driven) execution is for coupled chains
only. The speed win is real only if you actually fan out.

**Plan the fan-out from file-disjointness, not by feel.** When the project has a
graphify graph, use the `fanout-plan` skill: feed it the work-items with their
target files + the project's risk-markers; it returns clusters that MUST serialize
(shared edited files) and clusters that are mutually file-disjoint (safe to run in
parallel), plus a `coupling_review` list of file-disjoint pairs that still share a coupling
signal (import-adjacency / same risk-marker). MANDATORY before dispatch: render an
explicit parallelize-vs-serialize verdict for every `coupling_review` pair (skeptical
default = serialize), and declare `contract_group` on leaves that are halves of one
contract so they serialize under one owner outright. File-level
disjointness of the EDITED files is the merge-safety unit - not symbol-level, not
transitive import-coupling.

**Tier the model by RISK, not role.** The orchestrator (planning, diff review,
gates, commit/merge, by-value verify) and every subagent touching a surface the
project flags HIGH-RISK (high blast radius or subtle-if-wrong - e.g. financial /
ledger math, auth, destructive migrations, service/API contracts) stay on the
top-tier model even when following a plan; only mechanical, fully-specified leaves
with NO high-risk surface may drop to a cheap model (a floor that can still follow
the plan). The PROJECT enumerates its own high-risk surfaces as file markers;
`fanout-plan` emits the per-leaf tier from those markers (map its `top`/`cheap`
labels to your models). In a Workflow, set `agent(prompt, {model:'<cheap>'})` for
mechanical leaves and omit the override (inherit the top-tier main loop)
otherwise. Tier REVIEW depth the same way: high-risk leaves get a full adversarial
spec + quality review; mechanical fully-specified leaves get an orchestrator
diff-glance - match review rigor to blast radius so the review overhead never
exceeds the tiering saving.

**Subagent output contract.** Every dispatched agent's final message is
injected into YOUR context verbatim - across a 10-agent fan-out, verbose
prose returns are the difference between finishing and compacting. Demand
contract-shaped returns in the dispatch prompt: one line per finding/change
as `file:line - claim - evidence`, a closing `totals:` count line, no prose
preamble or recap. Two hard rules: (1) evidence is never compressed away - a
bare verdict ("no issues", "done") without the supporting line/quote/output
fails verification and gets re-run; (2) the contract is for agent-to-you
returns ONLY - anything a human reads (ticket replies, commit bodies,
summaries to the user) stays full prose.

**Parallelize the verification LABOR (canonical: `fanout-plan` VERIFY-MODE).** In a batch, do
NOT save verification for a serial end-sweep. Two moves: PIPELINE build->verify
(Workflow `pipeline(tickets, build, verify)`, no barrier) so a ticket verifies the
moment ITS deploy is live (A verifies while B still builds); and FAN OUT the
by-value / DATA verification to a verifier-agent pool (cheap tier, session-less
reads, returning `{ticket, observed_value, sha, pass, evidence}`). What does NOT fan
out: the gate-satisfying observation + judgment (the Stop hook reads YOUR
transcript, not the subagents' - so you do the ONE cheap confirming read and cite
the value in the close-out) and the authed deployed-UI live-drive (a single
authenticated session). The labor-vs-gate split, the authed-UI rule, and each leaf's
verify-mode all live in `fanout-plan` VERIFY-MODE (off the project's surface
markers) - the same place the build fan-out is planned, work-type-agnostic; the
project loop skill names the by-value channel + any ready batch-verify Workflow
template. This same shape is what a net-new feature build or a prototype port uses
at its verify step - it is not fix-loop-specific (and NOT parity-sweep's job:
that skill is prototype-only, so greenfield features never invoke it).

## Failure modes (red flags - STOP)

| Rationalization | Reality |
|---|---|
| "Tests pass, it's fixed" | jsdom != production render. Verify by value on the deploy (G1). |
| "My change is deployed, so it's fixed" | Deployed != the reported symptom is gone. Re-check the reproduced symptom (G0), not just that your change shipped. |
| "Can't reproduce it, but the code clearly shows the cause" | Reasoning != observation. Get a tool/info that CAN observe it, or downgrade the claim - never assert "fixed" against a symptom you never saw (G0). |
| "I found the component by grep" | Grep finds A component, not THE surface. Drive the reporter's screen (G2/G4). |
| "Can't open the surface, but the code clearly shows how it works" | Code-inference under blocked observation is a HYPOTHESIS, not a fact. Hedge it, cross-check the authoritative enum/type/contract (not one grep), and let a refuting gate (tsc/test) re-open the diagnosis (G0-D). |
| "Automation can't reach it, so ship unverified-reasoned" | Drive the user's LIVE session via Claude-in-Chrome first, then Playwright/DevTools/preview. A surface behind a visible button is observable - exhaust the tools before any can't-observe downgrade (G0-C precondition). |
| "The deploy is probably done" | Confirm the sha (G3). ~70s feels like forever; verify anyway. |
| "This needs the reporter's screenshot" | If a prototype/design source is on disk, extract the spec yourself first. |
| "I'll reply on the ticket page" | Reply in the reporter's THREAD or they won't see it in context. |
| "Auth wall - I'll log in" | Never enter credentials/OTP. Pause and ask the user to re-auth. |
| "My step works; the rest of the flow is unchanged" | The seam you changed feeds the terminal action. Drive it (G5). |
| "Fixed the exact card the reporter pointed at" | Its twin in the sibling flow still has the old pattern - the next ticket (G6). |
| "I'll just push direct, the bypass notice is normal" | A required check that never blocks is a single point of failure. Open a PR; merge on green (author-preserving). |
| "Starting fresh on this surface" | Maybe not - `query_trajectory({surface})` first; a past `what_failed` is the wrong-surface trap already paid for once (trajectory memory). |

## Related skills
- `parity-sweep` - value-assertion methodology (G1 in depth) + scoped mode.
- `parity-builder` - net-new work: building/porting a surface FROM a
  prototype to leaf parity (this loop handles fixes on existing surfaces;
  hand prototype-ported builds to the builder).
- `deploy-verify` - sha-confirmed deploy polling (G3).
- `fanout-plan` - file-disjointness fan-out planning + per-leaf risk tiering.
- `trajectory-kb` (MCP) - cross-loop memory: query past trajectories at step 2, append the shipped outcome at close-out.
- `pre-commit` - project-real gates. `git-commit` - identity-aware commits.
- `superpowers:systematic-debugging`, `superpowers:verification-before-completion`.
- The project-level skill supplies all concrete facts (boards, repos, URLs).
