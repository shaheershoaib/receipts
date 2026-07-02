# Changelog

## 0.2.1

The distribution release: the published artifact now proves itself the way the tool
makes everyone else's fixes prove themselves.

### Fixed
- **The published CLI was dead on arrival.** 0.2.0's npm package shipped
  `enforcer/verify.js` without `enforcer/g6.js` (its own require), so
  `npx receipts-cli verify` / `replay` crashed with MODULE_NOT_FOUND. The `files`
  allowlist now carries it - and two receipts make the class structurally hard to
  re-ship: a static require-graph test (every module reachable from a shipped entry
  point must be covered by `files`) and a packed-tarball smoke test (`npm pack` ->
  run a real red->green verification through the extracted bin). CI was green while
  the artifact was broken because CI tests the repo tree, where every module exists
  regardless of `files` - a green that tested the wrong artifact, on our own release
  pipeline.
- **`init` wrote receipt-breaking test commands for Go / Maven / Gradle / .NET.**
  `{test}` substitutes FILE paths, but `go test -run` / `mvn -Dtest=` / `--tests` /
  `--filter` select by test NAME - a path matches nothing and exits 0: a "red" phase
  that ran no test, so every legitimate fix on those stacks was mis-flagged as a weak
  receipt. New placeholders: `{test_dirs}` (unique `./dir`s - Go selects by package)
  and `{test_classes}` (basenames, comma-joined - surefire). Gradle / dotnet default
  to the coarse full `test` command (correct, just broader), with a sharpening note
  in INIT.md.
- The plugin marketplace listing's version had drifted (0.1.0) from the plugin
  manifest (0.2.0); now in lockstep, enforced by a test.

### Changed
- **G1 sharpened for multi-hop paths.** A value that crosses layers to reach its output
  (form -> request payload -> serializer -> proxy/gateway -> handler -> store) can be
  silently dropped at any hop and fall back to a default. G1 now says to assert the value
  ARRIVED at the far end (persisted/rendered), never that the caller sent it or that a
  middle layer received it; adds a multi-hop scar (a picked field dropped by BOTH the
  client mutation and the proxy route). Doc-only; no behavior change.
- **Honest-docs pass on config fields that outran the code.** `build.sha_source` and
  `degrade.on_unreachable_build` / `verify.live_drive` are now marked for what they are
  today (read by the agent-side Stop hook / reserved for the designed enforcer features)
  instead of implying CI-enforcer support; `enforcer/GENERALIZATION.md` says plainly that
  the G3 deployments-API check is design, not yet code.

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
