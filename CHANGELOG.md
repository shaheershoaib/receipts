# Changelog

## 0.2.0

The verification engine learns to verify itself, ship a replayable proof, and run locally.

### Added
- **Engine CLI.** `receipts verify` runs the enforcer locally with the same flags as the CI
  action (one engine, two front doors); `receipts replay <receipt>` re-runs a recorded
  verification and checks the verdict reproduces; `receipts explain <receipt>` prints a
  human-readable summary. The engine (`enforcer/verify.js`, `enforcer/g7.js`) now ships with
  the npm package.
- **Replayable receipts.** Any verification can emit a machine-readable evidence artifact
  (`--receipt-out`): base/head, verdict, red/green, and every command run with its exit code
  and duration. Schema in `spec/RECEIPT.md`. The GitHub Action uploads it as a build artifact.
- **G6 surface-coverage** (the "sweep the twins" assist). Catches a pattern applied to SOME
  sibling surfaces but not all - the "claimed app-wide, actually partial" failure (e.g.
  pagination added to 2 of 4 `*Table` components). Declared families (`gates.G6.surfaces`: a
  glob + a required marker, any language) encode an app-wide claim as a re-checkable invariant;
  a built-in JS/TS heuristic flags same-named twins that missed an affordance (a component,
  hook, attribute, prop, call, or import - any identifier that is not a ubiquitous plumbing
  word) rolled out to >=2 siblings. Runs on every PR; default warn, `gates.G6.mode` -> block.
- **G7 dependent-test-selection.** The enforcer computes the NEW dependents of the changed
  source (a freshly-added consumer file, or a freshly-added import edge) and re-runs their
  co-located tests on head. Built-in JS/TS import scan + an explicit consumer graph
  (`gates.G7.graph`) for any stack. Config: `gates.G7.mode` (warn|block, default warn),
  `gates.G7.verify_all_dependents`.
- **Opt-in strict trigger.** `claim.require_receipt_for: "any-source-change"` requires a
  receipt of any production-source change, not only a `closes #N` fix-claim (closing the
  "omit the issue link -> silent green" bypass). Default (`issue-link`) is unchanged.
- **Tracker-agnostic close-out detection.** The Stop-hook backstop now recognizes a "fixed"
  close-out across Notion, Linear, Jira, and GitHub (was Notion-only), with an over-fire guard.
- **Honest import-vs-assert red.** `verify.on_load_error_red: warn|block` distinguishes a red
  that reproduced the symptom by assertion from one that is merely an import/collection error.
- **Optional command timeout.** `verify.command_timeout_ms` guards a hung test.
- **A self-verification test suite** (adversarial: a valid / invalid / malicious receipt per
  gate; plus hook tests) that runs in CI, and a dogfood job that gates this repo's own PRs.

### Fixed
- A chatty-but-honest test that prints past Node's 1 MiB `execSync` default no longer
  `ENOBUFS`-fails (misread as a red); the buffer is now 64 MiB.

### Notes
- Backward-compatible: every new default preserves prior behavior, except **G7 now runs in
  `warn` mode by default** (non-blocking, exit 0) on PRs that introduce new JS/TS consumers.
- The npm CLI is `receipts-cli`; the Claude Code plugin and the GitHub Action ship from the
  repo / marketplace.
