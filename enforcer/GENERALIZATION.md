# How receipts generalizes across any repo

The design of record for the question: *how does this work on any project, any stack,
any deploy platform, so a user just downloads it and it works?*

## The premise (the honest one)

No tool can auto-reproduce an arbitrary symptom on an arbitrary stack. So "it just
works" cannot mean "magically verifies anything." It means three things, layered:

1. the **discipline is universal** and ships generic,
2. the **reproduction is project-specific** but shrunk to near-nothing, and
3. when it genuinely cannot re-verify, it **degrades honestly** instead of lying.

## The unlock: the receipt is a red-before/green-after test

This is what makes verification stack-agnostic. The fix carries its own proof:

1. The agent (gate G0) writes an acceptance test reproducing the **reported symptom**,
   in the project's own test framework (`jest` / `pytest` / `go test` / Playwright /
   whatever the repo already uses).
2. The enforcer runs that test against the **base** commit -> it must FAIL (proves the
   test actually reproduces the bug).
3. It runs it against the **fix** commit -> it must PASS (proves the symptom is gone).

Red-before, green-after, asserting the reporter's symptom = a real receipt. It is
general because "run the test" is just the project's existing test command, and it
defeats the wrong-axis class: a test that only asserted a height cap would not prove
the modal got wider, so a wrong-fix cannot make it green.

The enforcer's universal job is therefore: **check out base + fix at the right sha,
run the carried test both ways, confirm red -> green.**

## Invariant vs variant

Same shape as every tool that travels across repos (ESLint = engine + `.eslintrc`;
Playwright = runner + your tests):

| Ships generic (the product) | Project supplies once (tiny) |
|---|---|
| gate logic + pass/block decision | how to run your tests |
| the red->green re-run orchestration | where it deploys (usually auto-detected) |
| receipt / evidence schema | what marks a "fix claim" (usually `closes #N`) |
| the honesty ladder + degradation | nothing else |

## The universal layer (zero config) goes through GitHub, not each platform

The trick for "any deploy platform" is to abstract at the GitHub layer rather than
integrate per-platform. Vercel, Railway, Netlify, Fly, Render all report deployments
and commit statuses TO GitHub. So:

- **G3 sha-match** reads the GitHub Deployments / commit-status API - platform-
  agnostic. No per-platform adapters.
- **Claim detection** (`closes #N`), **downgrade-tag detection**, and
  **receipt-present** all parse the PR - universal.
- Repos with **no deploy** (libraries, CLIs) verify against the built artifact / test
  run instead of a URL - auto-detected from "are there deployments?"

A large chunk of value is therefore zero-config for *every* GitHub repo, regardless
of platform or stack.

## Tiered, so it feels like zero-config

1. **Auto-detect** the common 80%: test runner (`package.json` / `pyproject.toml` /
   `go.mod` / `Makefile`), framework, deploy platform (`vercel.json` / `railway.json`
   / `fly.toml` / GitHub Deployments).
2. **Convention**: a `receipts/verify.sh` or a tagged test, if present.
3. **Explicit `receipts.config.json`** for the exotic 20% - small and declarative
   (see `receipts.config.schema.json` + `receipts.config.example.json`). Produced by
   `receipts init` (see `INIT.md`), not hand-authored from scratch.

## Honest degradation (the part that keeps it trustworthy)

If the enforcer cannot re-verify (no test carried, "it feels janky," unknown stack,
no CI), it must NOT pass silently and must NOT block everything. It degrades to the
gates it can always do and says exactly what it could not prove:

- always-available: G3 sha-match, "is a receipt OR an honest downgrade tag present?"
- when it cannot re-run the symptom: it reports `symptom NOT re-verified (no acceptance
  test carried)` and requires the honest-downgrade tag rather than allowing a bare
  "fixed."

Even at its weakest it enforces *"carry proof, or admit you did not verify"* - which
is the whole point.

## What stays project-specific, and why it is small

`receipts` configures **plumbing** once (how to build, test, reach the deploy; what
marks a claim) - a finite, detectable set. It does **not** pre-enumerate how to
verify every symptom; each fix carries its **own** proof (the agent's red->green
test). So the project-specific surface is bounded: "how do I run your tests and reach
your build," not "how do I verify any conceivable bug."

## Dependent-test-selection (G7's enforcer assist)

The carried receipt proves the *changed surface* is fixed. G7 asks a second question
the receipt cannot: did the change break a downstream *consumer* - especially one that
arrived in a freshly-pulled commit you never saw? The enforcer assists by re-running
the affected dependents' tests at the PR, on top of the red->green receipt.

Mechanism, in the same base/head terms as the core re-run:

1. **Build the reverse-dependency set.** For the changed files (base..head), compute
   who imports them. Reuse the repo's code graph if present (e.g. a `graph.json` with
   consumer edges), else a stack-native import grapher (`dependency-cruiser` / `madge`
   for JS/TS, `grimp` / `importlab` for Python, `go list -deps` for Go) - the same
   auto-detect tiering as the test runner.
2. **Diff against the merge base -> keep only the NEW dependents.** A dependent is new
   if its file was added in base..head, OR its import edge onto the changed surface
   appeared in head but not base (build the graph at both commits and diff the edge
   sets). This is the integration-regression subset - the consumer that did not exist,
   or did not consume you, when you branched - and it keeps the set small even when the
   changed file has hundreds of stable dependents.
3. **Map each new dependent to its tests and run them on head.** Co-located convention
   (`x.ts` -> `x.test.ts` / `test_x.py`) or "tests that import the dependent." They
   must PASS - your change must not break its new consumers.

Verdict, folded into the existing PASS / BLOCK / WARN:

- a new dependent whose test FAILS on head -> **BLOCK** (an integration regression the
  carried receipt would never have caught);
- a new dependent with **no test** -> **WARN**, naming it ("consumer X is new and
  affected, no test to re-run") - surfaced, never silently passed;
- no new dependents, or no import graph for the stack -> nothing added, reported as
  `dependents not computed` rather than a false all-clear (honest degradation, as
  above).

Default scope is the NEW dependents only; a `verify_all_dependents` config knob widens
it to every consumer for high-blast-radius changes, and any cap on the set is logged,
never silent.

## The promise to put in the README

Not "verifies anything automatically." The sharper, true one:
**"it re-runs the proof your agent should have written, and when it can't, it says so
instead of rubber-stamping."** General, and honest.
