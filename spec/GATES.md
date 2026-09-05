# The Gates

A standard for trusting AI-written fixes.

**Spec version: `receipts/gates@1.5`**

A fix is **not** done because the agent says so, because CI is green, because a unit
test passed, or because the code "looks right." It is done when the **reported
symptom is observably gone on the deployed build.** The Gates are what it takes
to earn that claim.

Each gate exists because skipping it shipped a wrong or unverified "fix" at least
once. The scar is included with each - the gates are not theory, they are scar
tissue.

**Versioning.** The spec is versioned as `receipts/gates@MAJOR.MINOR`. An additive change
(a new gate, a new enforcer assist, a clarified mandate) bumps the MINOR; a change to a
gate's MEANING (redefining what it requires, or removing a gate) bumps the MAJOR. Each gate
below carries an *Enforcement* line stating whether it is enforced `executable` (an enforcer
re-check), `agent-judgment` (carried by the agent adapter, no PR-side artifact), or `hybrid`
(agent judgment with an enforcer assist), and WHERE.

## Enforcement scorecard

Of the 20 gates: **8 executable** (G6, G7, G8, G9, G10, G11, G13, G14), **5 hybrid** (G0, G1,
G3, G12, G17), **7 agent-judgment** (G2, G4, G5, G15, G16, G18, G19). The roadmap's durability metric is moving gates
RIGHTWARD - from judgment to executable - because an executable gate a machine re-runs does
not depend on which agent, or how careful an agent, produced the work; the wholly-judgment
gates are the model-dependent surface, and shrinking that surface is how the standard stops
being only as good as the agent holding it.

## What a receipt is

A **receipt** is the reported symptom's own acceptance test, re-run against the real
build, coming back clean. Not a "looks fixed" screenshot (an agent can produce one
for a bug it never fixed). Not a green CI run (it tested *something*, maybe not the
symptom). A receipt is the symptom itself, re-triggered, refusing to reproduce.

**The principle: don't trust, re-verify.** The agent does not grade its own homework.

**Falsify your own receipt.** Before you trust a green, ask one question: what is a way
the reported symptom is STILL present while this test passes? If you can name one, the
receipt asserts a PROXY, not the symptom - retarget it onto the exact thing the reporter
perceives. The commonest proxy is reading the intended value off a STAND-IN - a container,
a wrapper, an attribute, a class, a computed style on the wrong node, a count of changes -
while the thing actually perceived (the child that renders it, the pixels, a downstream
artifact) still differs. A green on the stand-in confirms your INTENT, not the OUTPUT; it
is a false green precisely because it is honest about the wrong quantity. And a reporter
who re-opens the "fix" against your green is telling you the instrument measures the wrong
thing - suspect the receipt, not just "another instance."

**Assert the invariant, not the instance.** When a fix addresses a CLASS of inputs rather
than the single reported case, the receipt asserts the class-level invariant ("no record
violates the rule"), not just that the one reported record is fixed. A probe scoped to the
single reported instance passes while other members of the same class stay broken - the fix
reads done and ships incomplete. Scope the receipt to the RULE the fix establishes, not the
one example that surfaced it. (This is the receipt-scope companion to G13's diff-scope: G13
keeps the receipt covering the whole change; this keeps it covering the whole input class.)

This spec is written for the most common case, a bug fix. The same mechanic applies to
any work type - the receipt just asserts that change's **acceptance criterion**: the
reported symptom for a fix, the new behavior for a feature (red until it exists), the
transformed data incl. legacy rows for a migration, and for a refactor it inverts to "the
existing suite stays green" (no behavior change). See `references/WORK-TYPES.md`.

## Two kinds of gate

- **Verify gates (G0, G1, G3, G5, G9, G11, G13, G14)** answer *"did you actually prove it
  works?"* They produce receipts, and they are enforceable at the one chokepoint every
  team shares regardless of which agent they use: the pull request. An enforcer can
  re-run them.
- **Target gates (G2, G4, G6, G7, G8, G10, G12, G15, G16)** answer *"did you fix the right thing,
  all of it - including what depends on it, and against the code that will actually
  ship?"* There is mostly no artifact for "you fixed the right component," so these live
  inside the agent's loop and ship as adapters. Several are bridge cases with an enforcer
  assist: the agent does the selection/judgment, and the enforcer re-checks what it can
  at the PR (G7 the dependents' tests, G8 the base is current, G10 the contract is
  back-compatible, G12 the silencing shapes).
- **Process gate (G17)** answers *"is the escape hatch being used as an escape hatch?"* It
  is the only gate that judges the RUN rather than a change: it reads across items, so it
  cannot fire on any single one.

G7, G8, and G10 are the **multi-dev gates** - the ones that only bite because other people
are working in parallel and the codebase changes under you (a consumer is pulled in, the
base moves, the two halves of a contract deploy out of order). G9 is amplified by the same
reality: the regression is often in code you never touched.

G11-G14 are the **optimizing-agent gates**: G0-G10 defend against an agent that is
*wrong*; these defend against an agent that is *optimizing* - making the check green
rather than the code right. They exist because agents reward-hack: delete the failing test
(G11), silence the alarm instead of fixing the cause (G12), shield a broad diff behind a
narrow receipt (G13), or write a receipt too weak to notice a wrong fix (G14). The
**receipt lock** (see `RECEIPT.md`) is the same posture applied to authorship: the
acceptance test is approved and content-pinned BEFORE the agent starts, so the agent makes
the rubric pass rather than writing its own.

G15-G17 are the **durability gates**: they fire where a change is correct *right now* and
still wrong later or elsewhere. Two copies of one fact agree today and drift tomorrow (G15);
a fix repairs future instances and leaves the reported one broken forever (G16); and a
per-item escape used honestly twenty times conceals a capability the process never built
(G17). G17 is the only gate that reads across items - the standard's own feedback loop, and
the answer to "the ladder absorbed every downgrade without complaint."

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
*Enforcement: hybrid - agent-side reproduction (the skill records the symptom before the fix), backed by the enforcer's red-on-base re-run (the receipt must FAIL on base to prove it reproduced) and the Stop hook's verification-gate close-out block.*

## G1 - Assert the rendered VALUE, never presence or the placeholder

**Mandate.** Read the actual rendered value on the deployed build: `input.value`, the
selected option, the `checked` state, the number on screen. A grey placeholder
showing the expected text is a FAIL. "An input exists" is not a pass. When the value
crosses layers to reach that output (form -> request payload -> serializer ->
proxy/gateway -> handler -> store), assert it ARRIVED at the far end - the persisted or
rendered result - never that the caller sent it or that a middle layer received it. And
read it off the NODE the consumer actually perceives, not a stand-in that carries your
intent - a container whose child does the rendering, an attribute that mirrors the value,
a computed style read on a node other than the one that paints the text. The far end is
the right LAYER; the perceived node is the right ELEMENT within it - a value read on the
wrong node passes while the perceived output still differs.

**Scar.** Uncontrolled form defaults (e.g. React Hook Form `defaultValues`) paint
correctly in dev and jsdom and come up empty in production. "The test passes" and
"the screenshot looks right" are both insufficient - only the by-value read on the
real build catches it.

**Scar (multi-hop).** A field newly added to an existing path is a silent-drop point at
EVERY hop it crosses. A picked charge date was dropped twice - the client mutation sent
only the record id, and the proxy route forwarded no body - so it reverted to a default
while every layer painted correctly; only the by-value read at the far end caught it.

**Scar (stand-in node).** A rendered value was asserted on a CONTAINER that carried the
intended styling while the text was painted by a child element with its own, divergent
styling. The container read came back correct on every pass while the perceived output
stayed wrong, and the reporter re-opened the "fix" repeatedly against a green receipt -
until the assertion was moved onto the child that actually renders. A green on the wrong
node is honest about the wrong quantity.

**Corollary: assert the POSITIVE invariant, not the absence of the complaint.** A receipt
asserting "the error no longer appears" is structurally weaker than one asserting "the
value arrived / the action succeeded for the right principal" - a fix that SILENCED the
symptom (G12) passes the first and fails the second. Make the receipt assert what should
be true, not what should be gone.

**Scar (emitted artifact).** A go-live batch of "set your password" emails all reported
sent - the provider returned accepted for every one, `sent=59, failed=0` - while every
link pointed at `http://localhost:3000`, because the SENDING job's `FRONTEND_BASE_URL` was
unset and fell back to the framework default. The accepted-count is the provider's
receipt, not the recipient's: **provider-accepted is not recipient-actionable.** For
anything the system EMITS to a consumer - email, SMS, push, webhook, a generated document -
the value is the content the recipient receives and can act on (the embedded URL resolves
to the right host, the token works, the attachment opens), never the send/enqueue status.
Read ONE real emitted artifact end to end; do not count the ones you handed off.

**Corollary: for a rendered COLLECTION, assert the COUNT, not just one member.** When the
surface renders a SET - line items, table rows, a list, search results - a render or
mapping layer can silently drop a valid member: the source holds N, the surface paints
N-k, and a receipt that only checks "my new row is present" (or reads the feeding data)
still passes. Assert cardinality at the far end: the count the surface RENDERS equals the
count the source HOLDS (`rendered_count == source_count`), read off the rendered output,
not the API/DB that feeds it. A dropped-member bug is invisible to a presence check and to
a data-side read; only the count parity catches it.

**Receipt.** A by-value read of the rendered or persisted state on the deployed build,
taken at the far end of the path (not the layer you changed).

*Kind: verify (re-runnable at the PR).*
*Enforcement: hybrid - agent-side by-value read live, machine-validated by a `receipts observe` live-receipt in the Stop hook (a `met:true` value bound to the build) and, for web apps, a browser-receipt head-only acceptance check in CI.*

## G2 - Pin the EXACT flow / component the reporter means

**Mandate.** Apps grow parallel implementations of the "same" feature - an onboarding
wizard AND a detail-page dialog, a summary card AND a drill-in page - each with its
own copy of the logic. Fixing or verifying the wrong one looks like progress and
ships nothing. Reproduce the reporter's path before touching code.

The path includes WHO: the reporter's **runtime context** - role/permissions, tenant,
feature-flag bucket, locale/timezone, device - is part of the flow. The classic miss:
the agent reproduces as an admin while the bug only manifests for a regular user, or
verifies on a staging box where the flag is ON while the reporter's bucket has it OFF.
Pin the context alongside the component.

**Scar.** Two flows rendered the "same" feature from two different components; the fix
went into the one the reporter never used.

**Enforcement.** Agent-side. (A code graph answering "what renders this surface"
makes the parallel flows visible before you pin the fix.)

*Kind: target (agent-side).*
*Enforcement: agent-judgment - the skill pins the reporter's exact flow + runtime context; there is no PR-side artifact for "you picked the right component" (a code graph makes the parallel flows visible but does not decide).*

## G3 - Verify on the build that contains YOUR commit

**Mandate.** Confirm the deployed artifact's commit sha matches your push before you
trust anything you observe. A green check on the old build proves nothing.

The artifact users experience is **code + config**: a sha can match while the runtime
config universe differs - feature flags, environment variables, the A/B bucket. "The
right build" means the right code UNDER the reporter's configuration (which flags G2
pins as part of the reporter's context).

**The emitting environment is part of the config.** Work that runs OUT OF BAND - a job,
cron, worker, or one-off task - often executes in a different environment than the app and
does NOT inherit its configuration. Config that shapes the artifact (base URLs,
from-addresses, signing keys, feature flags) must be verified in the environment that
actually PRODUCES it, because an unset value there resolves to a framework default (e.g.
`localhost`) that is silently wrong. The app having the right value is not the job having it.

**Verify on the environment the reporter will RE-TEST on.** Fixing and confirming on one
environment while the reporter re-tests on another produces a fix that is real and reads as
broken - they re-open it, and the re-open costs more than the fix did. When the reporting
and verifying environments differ, either verify on THEIRS or reconcile theirs before saying
fixed. This is a property of the workflow, not of the code, so no test will surface it.

**A successful merge is not a successful deploy.** The sha must be OBSERVED on the running
artifact, never inferred from an upstream step that reported success. A merge that returns
MERGED, and a green check on every CI job, say nothing about whether the deploy that follows
them actually rolled - and a failed deploy characteristically leaves the PREVIOUS artifact
serving. That is the dangerous shape: nothing looks broken, the system is up and answering,
and it is answering on the old code. A client half that merged alongside it is then calling
endpoints the live build does not have.

**Scar.** A fix "verified" against a deploy that had not yet rebuilt - the old bundle
was still being served. Separately: a merge reported success and every CI check was green
while the platform's deploy step had failed; the previous artifact kept serving, and the
newly-merged client called endpoints that did not exist on it - two hours were spent
debugging the client before anyone observed the live sha.

**Receipt.** sha(deployed) == sha(your fix). Trivially checkable in CI.

*Kind: verify (PR-checkable).*
*Enforcement: hybrid - a live receipt binds the observation to the build sha (`--sha-cmd`) and a browser receipt asserts `sha_match` against the preview deployment; agent-side for the config/flag-bucket half of "the right build."*

## G4 - The fix must land on the surface the reporter SEES

**Mandate.** Code search finds *a* component that renders the words; the reporter's
screen may be a different one. After deploying, drive the reporter's actual screen -
if your change is not visible there, you fixed the wrong surface. Revert the
wrong-surface change rather than leaving two competing copies.

**Scar.** A badge was added to a per-row expand panel when the visible surface was the
page-level card. The change was real, tested, and invisible to the reporter.

**Enforcement.** Agent-side.

*Kind: target (agent-side).*
*Enforcement: agent-judgment - after deploy the agent drives the reporter's actual screen and reverts a wrong-surface change; a code search finds a matching component but cannot tell which screen the reporter sees.*

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
*Enforcement: agent-judgment - the agent drives the flow to its terminal action (accepting pre-filled defaults), assisted by a live receipt that reads the persisted terminal state by value; the enforcer cannot itself walk a multi-step UI.*

## G6 - Sweep the changed pattern's PARALLEL surfaces before closing

**Mandate.** Apps implement the same affordance separately in sibling flows (two
wizards' preview cards, nav badges, input masks). A fix that changes a pattern on one
surface creates a reporter-visible inconsistency on every twin still carrying the old
pattern - and that becomes the next ticket. Before closing, enumerate the pattern's
instances and apply the same change or note the divergence. Prefer fixing consistency
by SHARING the implementation (extract the component) over copying the patch - twins
that share code cannot drift.

For a BULK / mechanical sweep (a codemod, a rename, a pattern replaced across many
sites), the completeness receipt is a POST-CONDITION query: search the whole tree for
the OLD pattern and require ZERO matches. A count of sites changed reports how much you
did, not whether any instance was missed - and it silently omits every site the
transform's own matcher was too narrow to reach (a multi-line form of the pattern, a
variant spelling, the same idiom on a different element or construct). Only residual-zero
proves the class is gone; a change-count is effort, not completeness.

**Key the enumeration on the OBSERVABLE, never on the module.** "I checked the invoices
area" is not an enumeration - it over-collects into a blob too big to act on, so it gets
skimmed and the twin survives. Key on the exact thing the reporter named: the field, route,
rendered label, or status value, and enumerate every PRODUCER of that symbol.

Twins come in two kinds, and the second is the one this gate historically missed:
- **Read-side twins** - two serializers, endpoints or components serving the same value.
  The fix must land on all of them, or the reporter's surface keeps serving the old one.
- **Write-side twins** - two STORES of the same state (a row plus a denormalized flag, a
  status column plus a cached label). Fixing one leaves the other stale. Update every
  writer, or make the read path suppress the stale one - a read-time suppression that
  reuses the query's own exclusion self-heals rows already written wrong, with no backfill.

**The receipt is the enumeration QUERY and its result**, bound to the observable and
re-runnable by a referee - not a prose claim that you looked. Where there genuinely is one
producer, record "single producer confirmed" WITH the query that proves it.

**Scar.** "Add an Edit label" reopened as "the other section lacks it," then reopened
again as "now move it left to match the first screen" - three cycles for one
affordance, because the twins were never swept.

**Enforcement.** Agent-side for the judgment, with an enforcer assist at the PR: it flags a
pattern applied to SOME sibling surfaces but not all - the "claimed app-wide, actually
partial" failure. Two mechanisms (`gates.G6`): a **declared family** (`surfaces`: a glob + a
required marker substring, any language) that encodes the "app-wide" claim as a re-checkable
invariant, and a **built-in JS/TS heuristic** - any affordance (a component, hook, attribute,
prop, call, or import - any identifier that is not a ubiquitous plumbing word like
`value`/`data`/`id`) rolled out to >=2 same-named siblings flags the twins that missed it.
Default warn (the heuristic is best-effort); `gates.G6.mode`
-> block. Like every receipts check: it does not auto-fix the sweep, it turns it from
guesswork into a named list.

*Kind: target + verify (agent-side judgment; enforcer flags incomplete rollout).*
*Enforcement: executable - the enforcer statically scans every PR (`enforcer/g6.js`): declared families (glob + marker, any language) and a JS/TS same-named-twin heuristic (the heuristic is best-effort - multi-language rollouts need a declared family).*

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
*Enforcement: executable - the enforcer computes new dependents (`enforcer/g7.js`: JS/TS + Python import scan, or a declared `gates.G7.graph` for any stack) and re-runs their co-located tests on head; the "green suite short-circuits the re-run" shortcut was removed (#35), so a narrow suite no longer suppresses the check.*

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
*Enforcement: executable - the enforcer asserts base is an ancestor of head (`git merge-base --is-ancestor`, else a behind-by-N block) and re-runs the receipt green on the rebased tree, with a migration-number collision check; the recon-from-tip half is agent-side.*

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
leak; a jsdom test passed only by shimming the real component away. Two concurrent runs
shared one test database; one dropped and reseeded it mid-run and the other produced
thousands of phantom failures that were nearly reported as a real red suite.

**Receipt.** The full suite, green on head, after the narrow red->green receipt - run by the
enforcer itself, so a user-supplied masking wrapper cannot stand in for it.

**Round-trip corollary.** A test that MOCKS the boundary the fix depends on is not
evidence about that boundary. The common shape: a UI fix whose test stubs the API or the
store goes green while the real round-trip silently drops the value - the field is entered,
never persisted, and blank on reload, which was the original complaint. For any change whose
symptom involves data being SAVED, require one create -> persist -> read-back against the
real store, and trace the payload to the column it lands in. If no column exists for it, the
fix is not incomplete evidence - it is an incomplete fix.

**Isolation corollary.** A green earned on a resource another process can mutate mid-run is
not green either. When a suite claims a shared mutable resource - a database or schema, a
fixture directory, a port, a queue, a seeded account - a concurrent run that reseeds or drops
it invalidates BOTH runs. The damage is not confined to red: a run can also PASS because a
neighbor left convenient state behind. Give each run its own resource, or take a lease a
concurrent run cannot claim. This is the single-run twin of the multi-dev reality above: G8
keeps another developer's COMMITS from invalidating your base; this keeps another process's
WRITES from invalidating your green.

**Determinism corollary.** A trustworthy green is also a REPEATABLE one: a flaky receipt
can manufacture a fake red (a green test that flaked red on base) or pass a broken fix (a
red that flaked green on head), and the enforcer runs each side once by default. Where
flakes are a live risk, `verify.receipt_runs: N` requires red N/N on base and green N/N on
head - a mixed result is a flaky-receipt block, not evidence.

*Kind: verify (re-runnable at the PR).*
*Enforcement: executable - the enforcer runs the full suite on head itself (a user command cannot stand in), rejects exit-masking commands (`masksExit`), honors `on_load_error_red` (an import/collection error is not a real red), and enforces `verify.receipt_runs` N/N determinism.*

## G10 - A contract change must survive the deploy window (the rollout-compatibility gate)

**Mandate.** When a change splits across independently-deployed units - a backend and a
frontend, two services, a repo and its consumer - the two halves deploy in some order, and
there is a window where one is new and the other is still old. A change that is correct once
both sides ship can still break the live system during that window. Make the contract change
backward-compatible (the new producer still satisfies the old consumer, or the new consumer
tolerates the old producer), or sequence the deploys explicitly. A new endpoint is not
reachable until its proxy/route ships too. With separate people owning the halves, the order
is not yours to assume.

**Reachability is part of the contract, not only its timing.** The deploy window is one
axis; the other is whether the call can reach the endpoint AT ALL, within a single deploy.
Where a client reaches a server through a per-route REGISTRATION layer - a proxy handler, a
gateway route, a URL/router config, a rewrite table - that registration is itself part of
the contract, and an unregistered route does not fail like a bug: it returns the layer's own
fallback, typically an HTML 404 or the app shell, to a caller expecting JSON. Neither side's
unit tests can see this, and the blindness is STRUCTURAL rather than an oversight: the
server's tests call the handler directly and the client's tests mock the transport, so the
one artifact no test traverses is the registration. Exercise the new route once end to end
through the real routing layer, or assert its registration statically; "both sides' tests
pass" is not evidence of reachability.

**Scar.** A response-shape change from an array to `{rows, resolved_count}` would have broken
the still-live old frontend on a backend-first deploy; a backend PR had to merge and deploy
before its frontend PR or the contract broke; a new endpoint returned 404 until its proxy
route was added - a class that recurred three times in one session. The same class later
shipped as "Fixed": a privileged action returned the router's HTML 404 because its route was
never registered at all, and both halves' unit tests passed throughout.

**Enforcement.** Hybrid, and distinct from G7: G7 verifies the consumer works at one instant;
G10 guards the transient rollout window BETWEEN the two deploys. PR-checkable in part (a
backward-compatibility contract test - the new producer against the old consumer's
expectations; a deploy-order assertion when the units are coupled); agent-side for declaring
the contract pair and the safe order.

*Kind: target + verify (agent-side sequencing; enforcer back-compat contract test).*
*Enforcement: executable - the enforcer runs a structural breaking-diff on changed contract files (`enforcer/verify.js` `checkContracts`: removed JSON field/path/enum -> a consumer breaks); a best-effort heuristic, not a full contract differ, so declaring the contract pair + safe order stays agent-side.*

## G11 - A green earned by shrinking the suite proves nothing (referee integrity)

**Mandate.** The receipt and the suite are the referee; the fix must not weaken the
referee to win the game. Do not delete the failing test, skip it (`.skip` / `xit` /
`@pytest.mark.skip` / `t.Skip` / `@Disabled`), focus past it (`.only` silently benches
every other test in the file), loosen its assertions, or regenerate snapshots wholesale so
that whatever the code now does IS the expectation. If a test genuinely must go (a dead
feature, a consolidation), say so explicitly - an honest `test-removal: <why>` in the PR -
so the removal is a reviewed decision, not a quiet one. G9 verifies the suite passes; G11
verifies it kept its teeth.

**Scar.** The ecosystem's, in bulk: "make the test pass" is the most-documented agent
reward-hack - the failing test deleted, skipped, or its snapshot regenerated, suite green,
bug shipped. The weak-receipt check catches a weakened test only when it IS the receipt;
an unrelated failing test deleted to get the G9 suite green was invisible to every other
gate.

**Enforcement.** Enforcer, statically, on every PR (like G6): deleted test files from the
rename-aware diff (a rename is not a deletion), added skip/focus markers in changed tests
(multi-framework), and snapshot-artifact churn (always warn-only - snapshots also update
legitimately; the warning asks whether the new expectation is the INTENDED one). Default
warn; `gates.G11.mode` -> block. The `test-removal:` acknowledgment is tracked, never
blocked - the honesty ladder applied to the referee itself.

*Kind: verify (statically checkable at the PR).*
*Enforcement: executable - the enforcer statically scans the rename-aware diff (`enforcer/g11.js`) for deleted test files, added skip/focus markers (multi-framework), and snapshot churn (always warn-only); a `test-removal: <why>` acknowledgment is tracked, never blocked.*

## G12 - Fix the CAUSE, not the alarm (the silencing gate)

**Mandate.** A symptom can be made to disappear by removing its DETECTOR: the 403 "fixed"
by deleting the permission check, the error toast "fixed" by swallowing the exception, the
rejected input "fixed" by loosening the validator, the crash "fixed" by an empty catch.
The receipt goes red->green honestly - the reporter's symptom IS observably gone - and the
system is now broken silently, which is strictly worse than broken loudly. Before closing,
answer: did I repair the invariant, or mute the alarm? If the check itself was the bug
(an over-strict validator), that is a legitimate fix - SAY SO in the PR, and prefer a
receipt asserting the positive behavior (G1's corollary) so the distinction is testable.

**Scar.** The class ships constantly from agents under pull-to-finish: an exception
swallowed to clear an error report, an authorization check deleted because the reporter
"couldn't access" something. Each passes every green-based gate - the alarm is gone, and
that was the ticket.

**Enforcement.** Agent-side judgment (the skill asks the question at fix time), with a
narrow enforcer assist on fix-claims: a diff that REMOVES throw/raise statements or ADDS
empty/swallowing catches is flagged, warn-only by default (`gates.G12.mode` -> block) -
some fixes legitimately remove an over-strict check, so the heuristic asks rather than
answers.

*Kind: target (agent-side judgment; enforcer flags the silencing shapes).*
*Enforcement: hybrid - the skill asks the cause-vs-alarm question at fix time (agent-judgment); the enforcer (`enforcer/g12.js`) flags a fix-claim whose diff removes throw/raise statements or adds empty/swallowing catches (warn-only by default - the heuristic asks, the human answers).*

## G13 - The receipt must EXERCISE the diff (claim-scope congruence)

**Mandate.** Red->green proves the receipt RELATES to the change - it can flip on 3 of
the 500 changed lines while the other 497 ride along unverified, shielded by one narrow
receipt. The claim ("this PR is verified") must be congruent with the diff's scope:
changed production lines the receipt (or suite) never executes are UNVERIFIED changes,
and should be named as such - split them out, cover them, or carry an honest tag.

**Scar.** A fix-claim PR that "fixes the bug" and refactors half the module in the same
diff: the receipt proved the bug gone and nothing else. The regression rode in the
unexercised 497.

**Enforcement.** Enforcer, opt-in (coverage tooling is stack-specific and slower): with
`gates.G13.coverage_command` configured, run the suite under coverage on head, parse the
lcov, intersect executed lines with the diff's added/changed production lines, and name
every changed line no test executed. Default warn; `gates.G13.mode` -> block. No coverage
command, no check - and no false all-clear.

*Kind: verify (re-runnable at the PR; opt-in).*
*Enforcement: executable, opt-in - with `gates.G13.coverage_command` set, the enforcer (`enforcer/g13.js`) runs the suite under coverage on head, parses the lcov, and intersects executed lines with the diff's added production lines; no coverage command configured -> the gate does not run (and never a false all-clear).*

## G14 - The receipt must have TEETH (the mutation referee)

**Mandate.** Red->green proves the receipt notices THE fix. It does not prove the receipt
would notice a WRONG fix - a receipt asserting "the value is no longer the OLD one" goes
green for any change at all. So the enforcer breaks the changed lines ON PURPOSE (flipped
comparisons, `&&`/`||` swaps, nudged numbers, knocked-out returns) and requires the
receipt to go red against each broken variant. A mutant that SURVIVES is a changed line
whose behavior the receipt cannot distinguish from broken: either no test executes it
(G13's finding) or none asserts its effect. Pin exact values ("=== 6"), never "not the
old value".

**Scar.** The bench's, measured before it was closed: `weak-receipt` - for a subtotal that
should become 6, a receipt asserting `!== 3` - passed the red->green spine on every stack
that could express it (5 declared escapes). A fix returning 7 would have shipped as
verified. It is also the canonical weak-AGENT failure: a weak model writes exactly this
receipt shape unprompted.

**Enforcement.** Enforcer (`enforcer/g14.js`), on by default whenever a receipt exists:
diff-scoped (the -U0 added lines only), budgeted (`gates.G14.max_mutants`, default 12,
round-robin across files), string-masked (mutating a message is not mutating behavior),
compile-cache-defeating (a same-length python mutant can otherwise run STALE bytecode).
Default warn - a survivor can be an equivalent mutant (a genuine no-op) - and
`gates.G14.mode: block` for the untrusted-agent posture. Honest residual: a string-shaped
symptom with no mutable value operator on its changed lines is outside the operator set's
reach (measured in the bench as a declared escape, not hidden).

*Kind: verify (re-runnable at the PR).*
*Enforcement: executable, default-on - `enforcer/g14.js` generates the mutants; the enforcer re-runs the CARRIED receipt (file tests and/or `receipt-cmd:`) against each and reports survivors into the receipt artifact (`gates.G14`).*

## G15 - Two representations of one fact must be forced to AGREE (the divergence gate)

**Mandate.** When the same fact is expressed in two places - a shape declared twice, a
quantity computed in two modules, a literal on one side of a boundary and the enum it refers
to on the other - the copies agree on the day they are written and drift silently forever
after. Either DERIVE one from the other (one definition, imported or generated), or add a
check that FAILS on divergence (a shared type both sides must satisfy, a test asserting
equality, a schema both are validated against). That the values match today is not a check;
it is a coincidence with a shelf life.

**Scope: this gate fires on SILENT divergence across a seam.** Duplication that a compiler,
schema, or existing test already catches is not this gate's business, and neither is ordinary
local repetition. This is about a fact whose copies are edited independently and whose
disagreement produces a WRONG VALUE rather than an error. The test: *change one copy - if
nothing anywhere goes red, this gate applies.*

**Scar.** A field list written out a second time inline omitted one field, and every record
after the first silently lost it. One quantity defined in two places disagreed, and the copy
feeding a downstream consumer reported zero. A hardcoded status string was compared against a
producer that had since moved to an enum, so the branch never matched. In one of these the
type-checker DID object - and the change that "fixed" it edited the local copy to satisfy the
compiler rather than reconciling with the source, which is why this gate has a G12 edge:
routing around the tool that caught the divergence is silencing the alarm.

**Receipt.** The failing-on-divergence artifact itself - a shared type/schema, or a test that
goes red when one copy changes. Demonstrate it by changing one copy and showing the red.

*Kind: target (agent-side selection) + verify (the divergence check is re-runnable).*
*Enforcement: agent-side. A structural detector (the same field list or literal set appearing in two independently-owned locations) is plausible but unbuilt; declaring the pair and the check stays with the agent.*

## G16 - A forward-only fix leaves the reporter's own artifact broken (the existing-instances gate)

**Mandate.** Most fixes correct the code that PRODUCES a value, not the values already
produced. When the reported symptom is a stored artifact - a record, a document, a generated
file, a cached or denormalized value - a correct fix can be fully verified on new instances
while the exact artifact named in the report stays wrong forever. Before closing, determine
what happens to EXISTING instances and state it: they self-heal on the next run (name the
trigger), they need a backfill (perform it, or file it as a named follow-up), or they are
immutable by design (say so). Naming the reporter's own instance is required, not optional.

**Why the reporter's instance specifically.** The reporter re-tests the thing they filed. A
close-out proving twelve new instances are correct, while the one in the ticket still shows
the old value, reads to them as "not fixed" - and they are right about their own artifact.
This gate is G0's mirror: G0 opens on the reporter's instance, this closes on it.

**Scar.** A calculation fix was correct and every newly-created record came out right, while
the record named in the report kept its wrong value permanently. The reporter reopened the
ticket on that same artifact.

**Receipt.** Either the repaired instance observed by value (the strong form), or an explicit
disclosure in the close-out naming the instance and its disposition - self-heals (with the
trigger), backfilled (with the count), or permanent (with the reason). Disclosure satisfies
this gate; silence does not.

*Kind: target (agent-side), with a verify half when a backfill is performed.*
*Enforcement: agent-side - the close-out must carry the disposition. A stop-hook can require the field whenever the receipt asserts on a stored artifact.*

## G17 - A repeated downgrade is a missing capability, not bad luck (the ladder's feedback loop)

**Mandate.** The honesty ladder is a PER-ITEM escape: each downgrade carries a reason and is
individually defensible. That is precisely why it fails in aggregate - no per-item check can
see that the SAME reason fired twenty times, and twenty honest escapes for one reason are not
twenty unlucky items. They are one missing capability that the process has stopped noticing.
Track downgrade reasons across a run and trip when one recurs past a threshold; the correct
response is to name the missing capability and get it built, not to keep spending the escape.

**Key the threshold on (reason x surface-class), not on the raw count.** Twenty downgrades
spread across unrelated surfaces for unrelated reasons is a hard week. Twenty carrying "cannot
reach this surface's authenticated UI" is an entire class of work with no verification path -
and whoever is downstream, usually human testers, is silently doing that job instead.

**Trip behavior: surface, do not stall.** A trip raises a named capability gap in the run
summary and records it where a store exists. It does NOT block the item: blocking converts an
honest downgrade into an incentive to claim "fixed" instead, which is the exact failure the
ladder exists to prevent.

**Scar.** One run used the same downgrade reason eighteen times. Every use was defensible on
its own terms and the ladder absorbed all eighteen without complaint. The aggregate fact -
that an entire surface class had no verification path at all - was visible only by counting,
and was being absorbed downstream by human testers.

**Receipt.** The run's downgrade tally by (reason x surface-class), and for any reason over
threshold, a named capability gap.

*Kind: process - the first gate that spans items rather than judging a single change.*
*Enforcement: executable where a trajectory store is present (it already records an outcome per surface, so the detector is wiring rather than new instrumentation); otherwise agent-side tallying within the run. Threshold via `gates.G17.downgrade_threshold` (default 3).*


## G18 - A transform is proven on the DESTINATION, never by the source (the migration gate)

**Mandate.** Moving or reshaping data - a legacy migration, a backfill, an import, an ETL -
is the work type where the easiest thing to measure proves the least. Row counts reconciled
against the SOURCE prove you extracted the right NUMBER of rows and say nothing about
whether the values are legal, meaningful, or attached to the right entity once they land.
Derive the contract from the DESTINATION and validate the output against it: types, enum
membership, ranges, required-ness, referential integrity.

**Absence of errors is not evidence when the destination cannot reject.** Before trusting a
clean load, enumerate what the destination actually ENFORCES. Enums stored as free text,
foreign keys declared without constraints, permissive numeric/date parsing and implicit
truncation all mean the store accepts wrong data silently and reports success. Weak
enforcement moves the entire burden of proof onto your own validation.

**Prove the join key is UNIQUE, then prove it identifies the same entity.** Two separate
checks, both cheap. First, assert uniqueness in the source (`GROUP BY key HAVING COUNT(*) >
1` must come back empty): a natural key that maps N:1 - the same code against several master
rows - resolves to whichever row it hits first, silently picking a wrong or blank one. If it
is not unique, join on the surrogate id instead. Second, an id present in both systems is
not evidence it MEANS the same thing: ids get re-sequenced, reused, or scoped differently.
Validate the key against an INDEPENDENT attribute (a name, a natural key, a document number)
and state the match rate. A wrong key does not fail loudly - it yields a complete-looking
result set in which every row is attached to the wrong entity.

**Reconcile BY VALUE over the FULL population, not a sample.** Row-count parity is not value
parity, and a sample is not a reconciliation: report the COUNT OF MISMATCHES against the
source of truth and require zero. This is also how a denormalized field is caught drifting
from the history it is supposed to summarise - compare the stored value against the
value derived from the authoritative records, across every row, and emit a backfill for the
difference.

**Carry the whole identity, not just the key.** Where a source's convention is "this column
is NULL, so the real identity lives in these other columns", a transform that copies only
the key silently drops those rows' identity. Round-trip a NULL-key row through the transform
before trusting it.

**A sentinel in the KEY column force-maps everything to one value.** The worst version of a
bad join is not a missing key, it is a placeholder that LOOKS like one. A batch extract that
renders NULLs as the literal text `"NULL"`, or a legacy default of `"0"` / `"000"`, becomes a
real map key: every record with no true key collides on it and is force-mapped to one
arbitrary value, at full row count, with no error. Filter the extract at the SOURCE
(`WHERE key IS NOT NULL AND key NOT IN (<junk set>)`) rather than downstream, and when you
build a key-to-value map, dedup to the single REAL value so a placeholder cannot shadow it -
otherwise last-seen-wins silently decides.

**Sentinel values are MISSING data, not data.** A placeholder token where a name belongs, a
synthesized address, a zero that means "not calculated yet" rather than zero: each will
migrate cleanly and be wrong. Enumerate the sentinels the source actually uses during the
census, and decide per column whether each becomes NULL, a fallback, or a skip.

**Check what is IN-FLIGHT before a bulk mutation on a shared path.** A record another process
depends on in its CURRENT state - a batch awaiting a response, a job mid-retry, anything a
downstream system has already been told about - must not be advanced underneath it. The
transform is correct in isolation and still breaks the system, which is why a row-level
review never catches it. Identify in-flight states before the write, and exclude them.

**Mutually exclusive states, and which one WINS.** Legacy rows routinely assert two things
that cannot both be true: a success flag written when an operation is SUBMITTED and never
cleared when it later fails, beside the status recording the real outcome. Detecting the
contradiction is the easy half - the expensive half is precedence. A transform reading the
flag rather than the authoritative status migrates failures as successes, and the result
looks complete: full counts, no errors, the state wrong. Declare the precedence explicitly
and in BUSINESS terms (a bounced payment is not money received), then verify the destination
honoured it for EVERY affected row, not a sample. Source contradictions are the legacy
system's; resolving them the wrong way round is yours. And fix every downstream reader of
the losing flag too, or a later filter re-introduces the same error (G6's write-side twins).

**Column-name equality is not semantic equality.** A destination column and a source
column sharing a name is not evidence they mean the same thing - map by validating the
VALUE DISTRIBUTION and the producing system's intent, never by matching headers.

**A field's meaning comes from the producing system's BEHAVIOUR, not its name.** A boolean
called `is_paid` may be set when a payment is SUBMITTED and never cleared when it fails; a
timestamp called `delivered_at` may never be populated at all. Derive semantics from what
the legacy system DOES, and prefer whichever field that system treats as authoritative. An
inferred meaning is a HYPOTHESIS, and a hypothesis is testable: write the COUNTEREXAMPLE
QUERY - the rows where the name predicts one thing and the authoritative field says another
(`WHERE looks_successful = 1 AND authoritative_status IN (<failure states>)`). Zero rows
supports the inference; any rows refute it and the count is the blast radius. This turns the
softest check in the gate into an exact number, before a single row is written.

**Census COLUMNS as well as rows, and check the GRAIN survived.** Two failures pass a row
census perfectly. A column present in the source and never carried moves every row while one
field is silently absent - so enumerate the source's columns against the destination's and
account for each one as mapped, deliberately dropped, or defaulted. And a transform that
collapses a one-to-many into a one-to-one - per-contact rows flattened to per-customer, per-
line detail summed to a header - loses information while every count still reconciles: state
the grain on both sides and assert the relationship's cardinality survived.

**State the COVERAGE, and the PROVENANCE of anything hand-supplied.** "It ran clean" over a
subset is not completeness: report rows in scope, transformed, and skipped with reasons - a
transform silently covering half its domain looks identical to one covering all of it. Where
the transform is driven by a supplied artifact (a spreadsheet, an extract, a mapping file),
name it and its date; a stale input produces a confidently wrong result.

**Never let a bulk reload touch APP-MANAGED tables.** A destination accumulates rows the
source never had - users, roles, settings, anything created after cut-over. A reload scoped
by "all tables" destroys them. Scope a reload to the tables the transform OWNS.

**Scar.** A migration reconciled perfectly on row counts and was declared validated; the
check was entirely source-side, and validating against the destination contract instead
found 23 defects, 9 of them silent-corruption class - free-text enums and unenforced foreign
keys meant the store would have accepted every one without error. A status backfill keyed on
an id that had been re-sequenced during migration attached ~41% of rows to the wrong entity,
and the result looked complete. A legacy flag named for success was set at submit time and
never cleared on failure, so ~18k failed items migrated as successful. A reload scoped to all
tables truncated the app's own user and permission rows.

**Receipt.** The destination-side validation run: the contract asserted (types, enums,
ranges, referential integrity), the key match-rate against an independent attribute, and the
coverage census (in scope / transformed / skipped, with reasons) - plus G1 by value on a
fixture containing representative legacy and edge rows, not only fresh ones.

*Kind: verify (re-runnable at the PR).*
*Enforcement: agent-side today. The destination contract, the key match-rate and the coverage census are all machine-checkable, so this is the strongest candidate for the next executable assist (a validator run against the destination schema).*

---

## G19 - A reported example is a SIGNATURE, not a scope (the whole-class gate)

**Mandate.** A bug arrives as one example. That example is evidence of a class, and fixing
only the example leaves the rest of the class live for the reporter to find again. Before
closing: write the PREDICATE that makes the reporter's case wrong - the query or condition
that selects it - run it over the ENTIRE population, and fix every match. The reporter's
instance passing is necessary, never sufficient.

**The receipt asserts the CLASS is empty**, not that one row is now right: the count of
still-matching rows or call sites is zero. A receipt that proves a single instance is a
receipt for the wrong claim, because the reporter's next example is drawn from exactly the
population you left behind.

**"Fixed the example, flagged the rest as a business decision / TODO" is the anti-pattern
this gate names.** Narrowing scope to a subset is legitimate, but it requires explicit owner
sign-off that names what is excluded and why, obtained BEFORE closing. It is never the silent
default, and time pressure does not license it.

**It applies in every medium.** A data defect fixes all matching rows. A code defect fixes
every call site of the pattern - this is G6's twin sweep made mandatory and COUNTED, rather
than a best-effort look around. A migration reconciles the whole table.

**Scar.** A defect reported on one record was fixed on that record and closed. The same
defect was re-reported four times from the same population, each time read as a new bug,
because nothing had ever asked how many rows matched the predicate.

**Receipt.** The predicate and its result over the whole population: zero matches after the fix,
and the count before it (the blast radius) in the close-out.

*Kind: target + verify (agent-side predicate; the receipt asserts the class is empty).*
*Enforcement: agent-judgment today. The predicate is machine-runnable, so a `receipt-cmd:` that counts matches and expects zero is the natural executable assist; declaring the population stays with the agent.*


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

**The ladder needs a counter.** Each rung is honest per item and blind in aggregate: the
same reason recurring across a run is evidence of a missing capability, not a run of bad
luck. Without a counter the ladder will absorb an unbounded number of individually-defensible
downgrades and report nothing. See **G17**.

## How this gets enforced

- The **verify gates** are re-run by the enforcer at the pull request: it reproduces
  the symptom's acceptance test against the build that carries the commit and
  confirms it is gone. A pasted artifact is not accepted; a re-run is. G9 extends this
  to the full suite on head (so a regression outside the changed test is caught), run
  by the enforcer itself so a masked or narrow command cannot stand in for it. G11
  watches the suite's assertion power (deleted/skipped tests, snapshot regeneration),
  and G13 (opt-in) checks the receipt actually exercises the diff.
- The **target gates** are carried by the agent adapter (e.g. the Claude Code
  plugin), which makes the agent pin the right surface, fix the surface the reporter
  sees, sweep the twins, and verify the dependents (especially freshly-pulled ones)
  before it ever opens the PR. Four get an enforcer assist at the PR: G7 runs the
  changed files' newly-arrived dependents' tests, G8 asserts the branch's base is the
  current tip (a green on a stale base is flagged or blocked), G10 checks a
  contract change is backward-compatible across the deploy window, and G12 flags a
  fix-claim whose diff removes throws or swallows exceptions (silencing shapes).
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
