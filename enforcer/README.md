# enforcer (the universal piece)

The agent-agnostic half of `receipts`: a CI check / GitHub Action that fails a
fix-claim pull request unless it carries, and **survives**, a receipt. It works no
matter who or what wrote the code, because it lives at the one boundary every team
shares: the PR.

**Status: v1 built and tested.** `verify.js` is the engine; `action.yml` is a
composite GitHub Action wrapping it. Verified across all five verdicts (PASS / BLOCK
/ WARN / honest-downgrade / not-a-claim) against a git fixture.

## What it does (v1: the carried red -> green test)

When a PR claims to fix an issue (its body matches `claim.issue_link`, e.g.
`closes #N`):

1. **Find the receipt** - the acceptance test the PR adds or changes (the test files
   in `base..head`).
2. **RED on base** - overlay that test onto the base commit and run it; it must FAIL
   (proving it reproduces the reported bug). If it passes on base, that is a *weak
   receipt* (WARN): the test does not actually assert the symptom.
3. **GREEN on head** - run it on the head commit; it must PASS (the bug is gone).
4. **Verdict** - red -> green => PASS. No test added => BLOCK (per
   `degrade.on_no_receipt`). Green-on-base => WARN. Fails on head => BLOCK. An
   explicit `unverified-reasoned` / `speculative` tag in the PR body => PASS (tracked,
   not claimed as verified - the honesty ladder).

The core move: the enforcer does not trust a pasted screenshot or a green unrelated
suite - it re-runs the proof, red then green, in the project's own test framework.

## Usage

1. `npx receipts init` at your repo root (writes `receipts.config.json`).
2. Copy `example-workflow.yml` to `.github/workflows/receipts.yml` (adjust the
   runtime/deps setup for your stack).
3. The gate runs on every PR via `uses: shaheershoaib/receipts/enforcer@main`.

`verify.js` is also runnable directly:
`node verify.js --base <sha> --head <sha> --pr-body-file body.txt`

## The pluggable verify step

The enforcer cannot magically re-verify anything, so the project supplies its plumbing
in `receipts.config.json` (`receipts init` detects most of it): `verify.test_command`
(how to run one test), `claim.issue_link` (what marks a fix-claim),
`claim.downgrade_tags`, and `build.sha_source`. Generic engine, project-supplied facts.

## v1 limitations (honest)

- **Test-able symptoms only.** The red -> green model covers anything expressible as a
  test. UI/visual symptoms that need a live deployed app are the optional
  `verify.live_drive` path - not in v1.
- **Deps at base.** Running the test on the base commit reuses head's installed deps
  (node_modules etc. are gitignored, not reverted on checkout). Fine for the common
  case; a base/head dep mismatch is an edge case.
- **`{test}` is space-joined paths.** A multi-file receipt passes all changed test
  paths to one `test_command` invocation; some runners (e.g. `go test`) may need a
  tailored command.

## Roadmap

- [x] `verify.js` red -> green engine + composite GitHub Action.
- [ ] `verify.live_drive`: drive the deployed app for symptoms a test cannot express
      (the Stop-hook precursor `../plugin/hooks/stop-verification-gate.py` has the
      deploy-binding + observation logic to draw from).
- [ ] A minimal `examples/` repo demoing a caught wrong-fix end to end (the README GIF).
