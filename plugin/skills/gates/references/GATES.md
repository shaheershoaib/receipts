# The Gates

A standard for trusting AI-written fixes.

A fix is **not** done because the agent says so, because CI is green, because a unit
test passed, or because the code "looks right." It is done when the **reported
symptom is observably gone on the deployed build.** The Gates are what it takes
to earn that claim.

Each gate exists because skipping it shipped a wrong or unverified "fix" at least
once. The scar is included with each - the gates are not theory, they are scar
tissue.

## What a receipt is

A **receipt** is the reported symptom's own acceptance test, re-run against the real
build, coming back clean. Not a "looks fixed" screenshot (an agent can produce one
for a bug it never fixed). Not a green CI run (it tested *something*, maybe not the
symptom). A receipt is the symptom itself, re-triggered, refusing to reproduce.

**The principle: don't trust, re-verify.** The agent does not grade its own homework.

This spec is written for the most common case, a bug fix. The same mechanic applies to
any work type - the receipt just asserts that change's **acceptance criterion**: the
reported symptom for a fix, the new behavior for a feature (red until it exists), the
transformed data incl. legacy rows for a migration, and for a refactor it inverts to "the
existing suite stays green" (no behavior change). See `references/WORK-TYPES.md`.

## Two kinds of gate

- **Verify gates (G0, G1, G3, G5, G9)** answer *"did you actually prove it works?"* They
  produce receipts, and they are enforceable at the one chokepoint every team shares
  regardless of which agent they use: the pull request. An enforcer can re-run them.
- **Target gates (G2, G4, G6, G7, G8, G10)** answer *"did you fix the right thing, all of
  it - including what depends on it, and against the code that will actually ship?"* There
  is mostly no artifact for "you fixed the right component," so these live inside the
  agent's loop and ship as adapters. Several are bridge cases with an enforcer assist: the
  agent does the selection/judgment, and the enforcer re-checks what it can at the PR (G7
  the dependents' tests, G8 the base is current, G10 the contract is back-compatible).

G7, G8, and G10 are the **multi-dev gates** - the ones that only bite because other people
are working in parallel and the codebase changes under you (a consumer is pulled in, the
base moves, the two halves of a contract deploy out of order). G9 is amplified by the same
reality: the regression is often in code you never touched.

---

## G0 - Reproduce the reported symptom FIRST

**Mandate.** Before choosing a fix, observe the symptom the reporter described and
record what you saw. That recorded observation is the exact thing your verification
must later show GONE. "My change is deployed/live" is NOT verification - your change
being live is not the same as the reporter's symptom being resolved.

Beyond a fix, "the symptom" generalizes to the change's **acceptance criterion**: for a
feature, write the acceptance test for the new behavior first (it is red until the feature
exists); for a migration, a fixture incl. legacy rows that fails until migrated; for a
refactor there is no symptom - the receipt inverts to "the existing suite stays green" (see
`references/WORK-TYPES.md`). The rule is the same: pin what "done" looks like, observably,
before you build.

**Scar.** A "modal is cut off" report was read as a vertical footer-clip. A height
cap was built, gated, deployed, and "verified by value" that the cap applied - all
green - while the real bug was the modal being too NARROW. The wrong axis shipped;
only the reporter caught it.

**Receipt.** The reproduction, captured so it can be re-run after the fix. If you
genuinely cannot reproduce it, you do not get a clean "fixed" - see *The honesty
ladder* below.

*Kind: verify (re-runnable at the PR).*

## G1 - Assert the rendered VALUE, never presence or the placeholder

**Mandate.** Read the actual rendered value on the deployed build: `input.value`, the
selected option, the `checked` state, the number on screen. A grey placeholder
showing the expected text is a FAIL. "An input exists" is not a pass.

**Scar.** Uncontrolled form defaults (e.g. React Hook Form `defaultValues`) paint
correctly in dev and jsdom and come up empty in production. "The test passes" and
"the screenshot looks right" are both insufficient - only the by-value read on the
real build catches it.

**Receipt.** A by-value read of the rendered state on the deployed build.

*Kind: verify (re-runnable at the PR).*

## G2 - Pin the EXACT flow / component the reporter means

**Mandate.** Apps grow parallel implementations of the "same" feature - an onboarding
wizard AND a detail-page dialog, a summary card AND a drill-in page - each with its
own copy of the logic. Fixing or verifying the wrong one looks like progress and
ships nothing. Reproduce the reporter's path before touching code.

**Scar.** Two flows rendered the "same" feature from two different components; the fix
went into the one the reporter never used.

**Enforcement.** Agent-side. (A code graph answering "what renders this surface"
makes the parallel flows visible before you pin the fix.)

*Kind: target (agent-side).*

## G3 - Verify on the build that contains YOUR commit

**Mandate.** Confirm the deployed artifact's commit sha matches your push before you
trust anything you observe. A green check on the old build proves nothing.

**Scar.** A fix "verified" against a deploy that had not yet rebuilt - the old bundle
was still being served.

**Receipt.** sha(deployed) == sha(your fix). Trivially checkable in CI.

*Kind: verify (PR-checkable).*

## G4 - The fix must land on the surface the reporter SEES

**Mandate.** Code search finds *a* component that renders the words; the reporter's
screen may be a different one. After deploying, drive the reporter's actual screen -
if your change is not visible there, you fixed the wrong surface. Revert the
wrong-surface change rather than leaving two competing copies.

**Scar.** A badge was added to a per-row expand panel when the visible surface was the
page-level card. The change was real, tested, and invisible to the reporter.

**Enforcement.** Agent-side.

*Kind: target (agent-side).*

## G5 - Drive the changed flow to its TERMINAL action

**Mandate.** Changing one step of a multi-step flow (wizard, checkout, pipeline) is
not verified at that step. Drive the flow to its terminal action (Activate / submit /
save), down the path a real user takes - including ACCEPTING pre-filled defaults
rather than re-typing them. The state seams between steps (local form -> shared store
-> final validator) are where fixed-one-broke-another lives.

**Scar.** A restructure seeded a form's fields from earlier steps; they painted and
passed the "Next" gate but never synced to the shared store, so the final Activate
rejected "Required" fields the reporter could plainly see filled. Filed as a new
blocker one day later.

**Receipt.** Re-run the flow to its terminal action and assert the persisted state by
value (constructing the state via the app's own API is a legitimate, faster repro).

*Kind: verify (re-runnable at the PR).*

## G6 - Sweep the changed pattern's PARALLEL surfaces before closing

**Mandate.** Apps implement the same affordance separately in sibling flows (two
wizards' preview cards, nav badges, input masks). A fix that changes a pattern on one
surface creates a reporter-visible inconsistency on every twin still carrying the old
pattern - and that becomes the next ticket. Before closing, enumerate the pattern's
instances and apply the same change or note the divergence. Prefer fixing consistency
by SHARING the implementation (extract the component) over copying the patch - twins
that share code cannot drift.

**Scar.** "Add an Edit label" reopened as "the other section lacks it," then reopened
again as "now move it left to match the first screen" - three cycles for one
affordance, because the twins were never swept.

**Enforcement.** Agent-side for the judgment, with an enforcer assist at the PR: it flags a
pattern applied to SOME sibling surfaces but not all - the "claimed app-wide, actually
partial" failure. Two mechanisms (`gates.G6`): a **declared family** (`surfaces`: a glob + a
required marker substring, any language) that encodes the "app-wide" claim as a re-checkable
invariant, and a **built-in JS/TS heuristic** - an affordance (a component, hook, attribute,
call, or import) rolled out to >=2 same-named siblings flags the twins that missed it; flat
lowercase markers are left to the declared form. Default warn (the heuristic is best-effort); `gates.G6.mode`
-> block. Like every receipts check: it does not auto-fix the sweep, it turns it from
guesswork into a named list.

*Kind: target + verify (agent-side judgment; enforcer flags incomplete rollout).*

## G7 - Verify the DEPENDENTS of what you changed, especially newly-pulled ones

**Mandate.** Your change has a blast radius beyond the file you touched: other code
*consumes* what you changed. Before claiming done, enumerate the dependents of the
changed surface and diff that set against the merge base - so a dependent that arrived
in a freshly-pulled change (one that did not exist when you branched) is flagged as
NEW. Verify the affected dependents still work, not just the surface you edited - the
newly-pulled ones above all, because those are the consumers you have no mental model
of. A change that is correct in isolation can still break its consumers.

This is the integration-regression gate, and it is distinct from every surface gate:
G2/G4 pin the surface the reporter SEES, G6 sweeps SIBLINGS that render the same
pattern - but a downstream CONSUMER is neither. It is the gate that survives a `git
pull` landing on top of your in-flight change.

**Scar.** An input field was edited as part of a feature. A change pulled from main now
rendered that same field as a chart fed by the field's value. The field edit was
correct and verified in isolation - and silently broke the chart, whose input contract
the edit never accounted for, because the chart was not even in the tree when the
change was scoped. No single-surface gate catches it: the regression lives in the
consumer, not the changed surface or its twins.

**Enforcement.** Agent-side for the selection (which dependents exist, which are new
since the merge base), with an enforcer assist at the PR: compute the files that depend
on the changed files (from the code graph / import edges), restrict to those whose
dependency is new since the merge base, and run their tests too - not only the carried
receipt. See `enforcer/GENERALIZATION.md` (dependent-test-selection).

*Kind: target (agent-side; enforcer can re-run the dependents' tests).*

## G8 - Verify on a base that is even with origin (the fresh-base gate)

**Mandate.** Recon, build, and verify against origin's CURRENT tip - not a long-lived local
checkout, and not a base that moved under you while you worked. Before you trust a
diagnosis, fetch and cut your work from the tip. Before you merge, rebase onto the current
integration tip, re-run the receipt green on the rebased tree, and resolve any
integration-number collision (two migrations claiming the same number, two leaf nodes). A
green earned on a stale base is a green against code that will not ship. In a repo with more
than one developer the base is not a constant, so this is the gate that survives other
people pushing while you work.

**Scar.** A recon ran against a checkout 55 commits behind origin and reported a feature as
missing that origin already had; another ran off a 90-to-109-commit-stale checkout and
produced false "gap" findings, laundered through a five-agent fan-out and a confidence score
so they looked rigorous. A parallel session pushed to the integration branch mid-build, so
CI failed on base-timing rather than on the code, and two sessions independently allocated
the same migration number and collided at merge. The densest scar cluster in the record.

**Enforcement.** Hybrid. The verify half is PR-checkable: the enforcer asserts the branch's
base is an ancestor of head (it was rebased onto the current tip) and re-runs green on it; a
domain check (`makemigrations --check` / a single-leaf check on the merged tree) catches
number collisions. The recon half is agent-side: fetch and work from origin's tip, never a
long-lived local checkout.

*Kind: target + verify (agent-side recon; enforcer base-freshness + re-green).*

## G9 - The receipt's green must be trustworthy (full-scope, unmasked, representative)

**Mandate.** A green that proves nothing is worse than a red. For the receipt to count, its
green must be: FULL-SCOPE - the whole suite on head, not only the changed test, because the
regression is most often in code you did not touch (and in a parallel repo it is broken by
the interaction with someone else's concurrent change); UNMASKED - the test command's own
non-zero exit must be able to surface (no `cmd; echo; tail` wrapper that exits 0 and hides
the failure); and REPRESENTATIVE - run on an engine that matches production (the real
database engine, a real browser), not a substitute that passes where production fails.

**Scar.** An agent ran only a narrow test subset locally, declared done, and CI then caught
a count invariant and a money-serializer leak the subset never exercised (it recurred on the
same file). A `npm test; echo; tail` wrapper exited 0 and hid a real non-zero that was
trusted as green (it recurred). A local SQLite run passed while the CI MySQL engine caught a
leak; a jsdom test passed only by shimming the real component away.

**Receipt.** The full suite, green on head, after the narrow red->green receipt - run by the
enforcer itself, so a user-supplied masking wrapper cannot stand in for it.

*Kind: verify (re-runnable at the PR).*

## G10 - A contract change must survive the deploy window (the rollout-compatibility gate)

**Mandate.** When a change splits across independently-deployed units - a backend and a
frontend, two services, a repo and its consumer - the two halves deploy in some order, and
there is a window where one is new and the other is still old. A change that is correct once
both sides ship can still break the live system during that window. Make the contract change
backward-compatible (the new producer still satisfies the old consumer, or the new consumer
tolerates the old producer), or sequence the deploys explicitly. A new endpoint is not
reachable until its proxy/route ships too. With separate people owning the halves, the order
is not yours to assume.

**Scar.** A response-shape change from an array to `{rows, resolved_count}` would have broken
the still-live old frontend on a backend-first deploy; a backend PR had to merge and deploy
before its frontend PR or the contract broke; a new endpoint returned 404 until its proxy
route was added - a class that recurred three times in one session.

**Enforcement.** Hybrid, and distinct from G7: G7 verifies the consumer works at one instant;
G10 guards the transient rollout window BETWEEN the two deploys. PR-checkable in part (a
backward-compatibility contract test - the new producer against the old consumer's
expectations; a deploy-order assertion when the units are coupled); agent-side for declaring
the contract pair and the safe order.

*Kind: target + verify (agent-side sequencing; enforcer back-compat contract test).*

---

## The honesty ladder (when you cannot verify)

A gate you cannot clear does not become a silent "fixed." It becomes an honest,
distinct, tracked status. This is what keeps the standard from rotting into
box-ticking:

- **fixed** - the symptom was reproduced and is observably gone on the deployed
  build. The only status that claims success.
- **unverified-reasoned** - you have a real root cause and a test exercising the
  fixed path, but genuinely could not observe the symptom in your environment. Ships
  with the reason stated and routed to whoever can observe it. NOT a "fixed."
- **speculative** - no confirmed root cause. The closest thing to "ship anyway,"
  on the tightest leash: never silent, and on high-blast-radius surfaces (money,
  auth, contracts, destructive migrations) never without explicit human sign-off.
- **reverted** - the change was backed out (e.g. it landed on the wrong surface).

"I could not verify this" is a first-class, respectable outcome. A false "fixed" is
not.

## How this gets enforced

- The **verify gates** are re-run by the enforcer at the pull request: it reproduces
  the symptom's acceptance test against the build that carries the commit and
  confirms it is gone. A pasted artifact is not accepted; a re-run is. G9 extends this
  to the full suite on head (so a regression outside the changed test is caught), run
  by the enforcer itself so a masked or narrow command cannot stand in for it.
- The **target gates** are carried by the agent adapter (e.g. the Claude Code
  plugin), which makes the agent pin the right surface, fix the surface the reporter
  sees, sweep the twins, and verify the dependents (especially freshly-pulled ones)
  before it ever opens the PR. Three get an enforcer assist at the PR: G7 runs the
  changed files' newly-arrived dependents' tests, G8 asserts the branch's base is the
  current tip (a green on a stale base is flagged or blocked), and G10 checks a
  contract change is backward-compatible across the deploy window.
- The **memory layer** records what was tried on each surface and how it turned out,
  so a surface with a bad track record is flagged before the next fix, and the team
  stops paying for the same trap twice.

## What the Gates do NOT defend against

The enforcer re-runs the fix's own receipt and the project's own tests. That makes it a
referee against **self-deception and mistakes** - the agent's "Fixed" when the symptom is
still there, a green that tested the wrong thing, a fix on the wrong surface, a stale base.
It is NOT a security boundary against a **hostile author**: the test command and the code it
runs come from the changed branch, so a PR can in principle make its own tests lie (edit the
test script, a wrapper, or the runner so it always exits 0). receipts shrinks the easy
bypasses - it reads its own config from the trusted **base** commit (not the PR head),
rejects exit-masking test commands (G9), and refuses shell-metacharacter paths - but it
cannot make a branch's own tests unsubvertible. That is what human review of the diff
(especially of test / harness / config changes) and branch protection are for. The Gates
raise the floor on honesty; they do not replace review. Likewise the G10 contract check is a
best-effort structural diff for common breaking changes, not a complete contract differ -
pair it with a dedicated tool (e.g. oasdiff) where full coverage matters.

Two trigger-scope notes in the same spirit. First, by default the enforcer only requires a
receipt of a **fix-claim** (a PR matching `claim.issue_link`, e.g. `closes #N`); a code change
that omits the issue link is not re-verified. A project that wants every code change held to
the bar sets `claim.require_receipt_for: "any-source-change"` - then a PR touching production
source (excluding docs / tests / CI / config) must carry a receipt, an honest downgrade tag,
or an explicit `work-type`, or it is blocked. Second, even under the strict trigger a fix
**mislabeled** `work-type: refactor` (which proves itself with suite-green, no red->green) is
structurally indistinguishable from a real refactor, so it is not caught - the hostile-author
case above, where diff review is the backstop.
