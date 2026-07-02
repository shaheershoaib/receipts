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

### Command receipts (no test runner required)

The receipt need not be a test *file*. For software with no test runner - an API, a data
pipeline, a CLI, infra - the PR body carries a **command receipt** instead:

```
receipt-cmd: sqlite3 app.db "select count(*) from users where email is null" expect:/^0$/
```

The command itself is the acceptance test: it must FAIL its expectation on the base commit
(the symptom reproduces) and MEET it on head (the symptom is gone) - the same red->green law.
The expectation defaults to exit code 0; an optional trailing ` expect:/<regex>/` also requires
the command's output to match (a JS regex, matched multiline against stdout+stderr). Multiple
`receipt-cmd:` lines are all required (ANDed), and a PR may mix `receipt:` pins with
`receipt-cmd:` lines. The command runs through the same machinery as `test_command` (cwd = repo
root at the ref, `command_timeout_ms`, `receipt_runs` determinism, the G9 exit-masking guard,
recorded into the receipt's `commands[]`); a command already green on base is the same
weak-receipt block. No config key is needed - the grammar lives in the PR body. Full grammar
and a worked example per medium: `../spec/RECEIPT.md`.

**Threat model: `receipt-cmd`.** A PR body supplying a shell command means CI executes
attacker-authored text. This adds no new exposure: the enforcer *already* checks out and
executes the PR's own code (its test files run on both base and head), so a PR can already run
arbitrary code in the job. The action runs with a **read-only** token (`contents: read`; the
optional PR comment needs `pull-requests: write` and nothing more) and carries no secrets
beyond that token, and the command string is passed to the **same exec path** as a
`test_command` (`execSync` with `cwd` = the repo, captured) - it is never interpolated into the
workflow-level shell or an Action expression, so it cannot escape into the runner's environment
or the job definition. As with test commands, the enforcer rejects exit-masking (`;`, `||`, a
pipe, `&`, command substitution) so a green cannot be faked by a masked exit. This is the same
posture the spec states for tests: the Gates raise the floor on honesty and are not a security
boundary against a hostile author - human review of the diff *and the PR body* plus branch
protection are what bound that (see `../spec/GATES.md`, "What the Gates do NOT defend against").

## Usage

1. `npx receipts init` at your repo root (writes `receipts.config.json`).
2. Copy `example-workflow.yml` to `.github/workflows/receipts.yml` (adjust the
   runtime/deps setup for your stack).
3. The gate runs on every PR via `uses: shaheershoaib/receipts/enforcer@main`.

`verify.js` is also runnable directly:
`node verify.js --base <sha> --head <sha> --pr-body-file body.txt`

## How a verdict reads (the report)

Every run writes a **markdown report** to the job step summary - the verdict, the
red/green evidence, every command re-run with its exit code, per-gate findings, and
warnings. With `comment: true` (plus `permissions: pull-requests: write` on the job)
the same report is posted as ONE PR comment, upserted on re-runs rather than stacked:

```yaml
- uses: shaheershoaib/receipts/enforcer@main
  with:
    comment: true
```

The report also carries the **G3 assist** when `build.sha_source` is
`github-deployments`: a lookup of whether any deployment reached the head sha
(advisory - a missing preview deployment means anything observed on a deployed URL is
still the OLD build). Locally, `receipts explain <receipt.json> --md` renders the
identical report - one renderer, no drift.

## The pluggable verify step

The enforcer cannot magically re-verify anything, so the project supplies its plumbing
in `receipts.config.json` (`receipts init` detects most of it): `verify.test_command`
(how to run one test), `claim.issue_link` (what marks a fix-claim),
`claim.downgrade_tags`, and `build.sha_source`. Generic engine, project-supplied facts.

## v1 limitations (honest)

- **Re-runnable symptoms only.** The red -> green model covers anything expressible as a
  test *or a re-runnable command* (a `receipt-cmd:`: a query, a curl, a plan-diff - so a
  runner-less API / pipeline / CLI / infra repo is covered too). UI/visual symptoms that need
  a live deployed app are the optional `verify.live_drive` path - not in v1.
- **Deps at base.** Running the test on the base commit reuses head's installed deps
  (node_modules etc. are gitignored, not reverted on checkout). Fine for the common
  case; a base/head dep mismatch is an edge case.
- **`{test}` is space-joined paths.** A multi-file receipt passes all changed test
  paths to one `test_command` invocation; some runners (e.g. `go test`) may need a
  tailored command.

## Roadmap

- [x] `verify.js` red -> green engine + composite GitHub Action.
- [ ] `verify.live_drive`: drive the deployed app for symptoms a test cannot express
      (the Stop-hook precursor `../plugin/hooks/stop-gates.mjs` has the
      deploy-binding + observation logic to draw from).
- [ ] A minimal `examples/` repo demoing a caught wrong-fix end to end (the README GIF).
