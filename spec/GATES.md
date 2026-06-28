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

## Two kinds of gate

- **Verify gates (G0, G1, G3, G5)** answer *"did you actually prove it works?"* They
  produce receipts, and they are enforceable at the one chokepoint every team shares
  regardless of which agent they use: the pull request. An enforcer can re-run them.
- **Target gates (G2, G4, G6, G7)** answer *"did you fix the right thing, all of it -
  including what depends on it?"* There is mostly no artifact for "you fixed the right
  component," so these live inside the agent's loop and ship as adapters. G7 is the
  bridge case: the agent selects the dependents (especially newly-pulled ones), and the
  enforcer can re-run their tests at the PR.

---

## G0 - Reproduce the reported symptom FIRST

**Mandate.** Before choosing a fix, observe the symptom the reporter described and
record what you saw. That recorded observation is the exact thing your verification
must later show GONE. "My change is deployed/live" is NOT verification - your change
being live is not the same as the reporter's symptom being resolved.

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

**Enforcement.** Agent-side. (A code graph answering "what else renders this pattern"
turns the sweep from guesswork into a list.)

*Kind: target (agent-side).*

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
  confirms it is gone. A pasted artifact is not accepted; a re-run is.
- The **target gates** are carried by the agent adapter (e.g. the Claude Code
  plugin), which makes the agent pin the right surface, fix the surface the reporter
  sees, sweep the twins, and verify the dependents (especially freshly-pulled ones)
  before it ever opens the PR. G7 also gets an enforcer assist: the enforcer selects
  the changed files' newly-arrived dependents and runs their tests too.
- The **memory layer** records what was tried on each surface and how it turned out,
  so a surface with a bad track record is flagged before the next fix, and the team
  stops paying for the same trap twice.
