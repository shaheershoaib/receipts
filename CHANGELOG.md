# Changelog

## Unreleased

### Added
- **G7 speaks Python.** The dependent-selection scan now covers Python alongside JS/TS:
  repo-relative absolute imports (`a.b.c` -> `a/b/c.py` / `__init__.py`), relative imports
  (`from ..shared import x`), from-import submodule forms, alias/comma lists - with
  new-file AND new-edge detection and co-located test mapping (`test_mod.py` /
  `mod_test.py` / `tests/test_mod.py`). src/-layouts and namespace packages honestly
  degrade to `gates.G7.graph`. Venv/site-packages are never consumers.
- **Monorepo support: per-package runners, one policy.** Nested `receipts.config.json`
  files (read from the trusted BASE commit, same posture as the root) contribute their
  `verify` block for the tests under them: the receipt's red/green runs per group with the
  nearest config's `test_command`, cwd'd to the package, evidence labeled per package
  (`receipt-red@base [packages/a]`). G9 runs the root suite or the AFFECTED packages'
  suites; a refactor with no root suite proves itself on every package suite. `claim` /
  `degrade` / `gates` stay root-only. A package missing a usable `test_command` blocks by
  name; G7 dependent tests in a runner-less package are skipped loudly. `receipts init`
  hints when it detects workspaces.
- **G13 claim-scope congruence is now enforced** (opt-in). With
  `gates.G13.coverage_command` configured, the enforcer runs the suite under coverage on
  head, parses the lcov (`gates.G13.lcov_path`, default `coverage/lcov.info`), intersects
  executed lines with the diff's ADDED production lines, and NAMES every changed line no
  test executed - the 497 lines riding along behind a 3-line receipt. Warn default,
  `gates.G13.mode` -> block; a failed coverage run or missing lcov degrades loudly
  ("G13 not evaluated"), never silently. lcov because every ecosystem can emit it
  (c8/nyc, coverage.py, SimpleCov, JaCoCo converters).
- **Team-shared trajectory memory** (`agent.trajectory_store`). `home` (default) keeps
  the store private and per-machine; `repo` moves it to `.receipts/trajectories.jsonl` -
  committed, so the whole team inherits every recorded trap and dead end instead of each
  laptop learning alone. Append-only JSONL merges trivially. `receipts init` asks;
  `RECEIPTS_TRAJECTORY_STORE` overrides for tests/redirects.

### Changed (breaking for hook customizers only)
- **The two python3 Stop hooks are now ONE Node hook** (`plugin/hooks/stop-gates.mjs`).
  Same backstops - the unverified-close-out block and the trajectory nudge - in a single
  transcript pass instead of two, and one runtime instead of two: the plugin already
  requires Node for its MCP server, and python3 was never a given on Windows. If both
  checks fire, one decision carries both reasons. Anyone who patched the old .py files
  re-applies against the .mjs; behavior is 1:1 (the python test suite was ported, plus
  regression cases) with one deliberate fix below.

### Fixed
- **A ticket comment mentioning a status no longer reads as a close-out.** The old hook
  matched configured fixed-statuses as SUBSTRINGS of the whole tracker payload, so an
  update whose comment said "moved to Pending Retest earlier" false-fired the
  verification gate. Statuses are now matched as status VALUES (`: "Pending Retest"`),
  which still covers flat and nested (Notion select) shapes. Spurious Stop-blocks are
  how hook plugins get uninstalled.

### Added
- **The verdict now explains itself.** Every enforcer run renders a markdown report -
  verdict, red/green evidence, every re-run command with exit code and duration, per-gate
  findings (G6/G7/G11/G12), warnings - to the GitHub job step summary; `comment: true` on
  the action posts the same report as ONE upserted PR comment (needs
  `permissions: pull-requests: write`). `receipts explain <receipt> --md` renders the
  identical report locally - one renderer (`enforcer/render.js`), no drift. A failing
  gate that reads as a bare red X gets resented; one that explains itself gets acted on.
- **G3 assist in the report** (advisory): when `build.sha_source` is
  `github-deployments`, the report looks up whether any deployment reached the head sha -
  "no deployment carries this sha yet" means anything observed on a deployed URL is still
  the OLD build. Reporting is a side-channel: it can never flip a verdict or fail the job.
- **Three new gates - the optimizing-agent gates.** G0-G10 defend against an agent that is
  *wrong*; these defend against an agent that is *optimizing* (making the check green
  rather than the code right):
  - **G11 referee integrity** ("don't shoot the referee"): flags a PR that DELETES test
    files (rename-aware), adds skip/focus markers (`.skip` / `xit` / `@pytest.mark.skip` /
    `t.Skip` / `@Disabled` / `.only` - multi-framework), or rewrites snapshot artifacts.
    A green earned by shrinking the suite's assertion power proves nothing: G9 checks the
    suite passes, G11 that it kept its teeth. Honest escape hatch: a `test-removal: <why>`
    line acknowledges intentional removals (tracked, never blocked). Default warn,
    `gates.G11.mode` -> block; snapshot churn always warn-only. Runs statically on every PR.
  - **G12 fix the cause, not the alarm** (the silencing gate): on a fix-claim, flags a diff
    that REMOVES throw/raise statements or ADDS empty/swallowing catches - the 403 "fixed"
    by deleting the permission check, the error toast by an empty catch. The receipt goes
    red->green honestly (the alarm IS gone) and the system is broken silently. Heuristic,
    so it asks rather than answers: warn default, `gates.G12.mode` -> block. Spec adds
    G1's corollary: assert the POSITIVE invariant, not the absence of the complaint.
  - **G13 claim-scope congruence** (spec + config now; enforcer coverage-run ships next):
    the receipt must EXERCISE the diff - changed production lines no test executes are
    unverified changes shielded by a narrow receipt.
- **Spec amendments:** G2 now pins the reporter's RUNTIME CONTEXT (role/permissions,
  tenant, feature-flag bucket, locale) as part of the flow; G3 notes the artifact is
  code + CONFIG (the right sha under the wrong flag bucket is the wrong build); G9 gains
  the determinism corollary (`verify.receipt_runs`).
- **`receipt:` pin.** A `receipt: path/to/the.test.ts` line in the PR body names the
  acceptance test explicitly, separating the real receipt from incidental test churn (a
  snapshot refresh, a rename) that used to pollute the red run and mis-read as "weak
  receipt". A pin may name an UNCHANGED test - the legitimate "my fix makes existing test
  X flip red->green" case. An invalid pin (not a test file / absent at head) blocks.
- **Receipt determinism** (`verify.receipt_runs`, default 1). Run the receipt N times per
  side: red must be red N/N on base, green green N/N on head. A flaky receipt can
  manufacture a fake red or pass a broken fix; a mixed result is now a distinct
  `flaky receipt` / `flaky green` BLOCK instead of silently counting.
- **Config key validation.** Unknown keys in `receipts.config.json` (a typo'd `gatez` /
  `test_comand`) used to silently mean "default behavior" - the quietest possible
  misconfiguration of a verification tool. The enforcer now WARNS, naming each unknown
  key (never blocks: an older enforcer meeting a newer config keeps working, loudly).

### Fixed
- **Deleted tests and snapshot artifacts polluted the receipt set.** A test file deleted
  by the PR (which cannot run on head) and `.snap` artifacts (which match the test-path
  shape but are not runnable) were included in the red/green receipt run, failing the
  green phase spuriously. Both are now excluded - their churn is G11's finding instead.
- **Local `receipts verify` left the repo on a detached HEAD.** The base/head checkout
  dance restored the original SHA, not the original BRANCH - so a commit made after a
  local verify silently missed the branch (found the hard way: an amend after a verify
  left a PR pointing at the pre-amend commit). The enforcer now restores the branch.

### Changed
- **Test/suite commands now default to a 20-minute timeout** (`verify.command_timeout_ms`;
  explicit `0` restores no-timeout). A hung test used to hold the CI job to its own
  multi-hour ceiling.
- **G6's heuristic ignores comments.** An affordance mentioned only in a comment is not a
  rollout (a license-header sweep is not pagination), a commented-out import is not an
  edge, and a twin whose only mention of the marker is a "TODO: add it" comment counts as
  UNCOVERED rather than adopted.

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
