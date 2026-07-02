# Changelog

## Unreleased

## 0.3.0

The roadmap release: the instrument (gates-bench), universal command receipts, live receipts, in-session tripwires, memory that pushes, browser receipts, spec v1.0 - measured at 0 undeclared escapes / 0 false-blocks on the bench.

### Added
- **Spec v1.0 - per-gate enforcement lines + an enforcement scorecard + conformance framing.**
  `spec/GATES.md` is now versioned `receipts/gates@1.0`: every gate G0-G13 carries an
  *Enforcement* line stating whether it is enforced `executable` / `agent-judgment` / `hybrid`
  and WHERE (grounded in the enforcer/hook code, not aspiration), plus an Enforcement scorecard
  near the top (**7 executable / 4 hybrid / 3 agent-judgment**) naming the roadmap's durability
  metric: move gates rightward from judgment to executable; the wholly-judgment gates (G2/G4/G5)
  are the model-dependent surface. A Versioning note (additive -> minor, a gate's meaning change
  -> major) and a README Conformance paragraph: an adapter for ANY agent framework conforms to
  `receipts/gates@1.0` iff it passes the three reference suites (enforcer self-verification +
  Stop-hook + the bench at 0 undeclared escapes / 0 false-blocks) - the suites ARE the
  conformance test. Doc-only; the bundled skill reference is kept byte-identical by
  `npm run build:refs`.
- **The bench gates the repo's own CI.** A new `bench` job in `.github/workflows/ci.yml` runs
  `node bench/run.js` on every push/PR; its existing exit contract (non-zero on any undeclared
  escape or false-block) now turns the repo's own CI red if a change lets defective agent output
  slip through or wrongly blocks honest output. A separate named job so a bench failure is
  legible.
- **Memory that pushes - SessionStart scar injection + `receipts kb` analytics.** The
  `trajectory-kb` memory only ever helped an agent that thought to QUERY it, and the weak agent
  that repeats a wrong-surface trap never does. A new SessionStart hook (`session-memory.mjs`,
  registered under `SessionStart` with matcher `""`) flips pull to push: at session start it
  READS the trajectory store (never writes, resolving it EXACTLY like the MCP server - home +
  optional `repo` store, `RECEIPTS_TRAJECTORY_STORE` override), picks up to ~5 entries most worth
  knowing for the CURRENT repo (repo matched case-insensitively against `agent.repo_name` / the
  git remote basename / `package.json` name / the cwd basename), and injects them as
  `additionalContext` - so the agent arrives already warned with no tool call. Selection is
  failures-first (outcome != `fixed` or a non-empty `what_failed`), most-recent, de-duplicated
  ONE per `surface_key` (five different traps beat five re-tellings of one), superseded entries
  dropped. Format: a header + 2-3 lines per entry (`surface_key` · `[outcome]` · the first
  `what_failed` line truncated ~200 chars), the whole block HARD-capped at ~1500 chars because it
  loads into EVERY session. **Default-on only when a `receipts.config.json` is present** (an
  opt-in); a repo with NO config gets ZERO injection and zero noise. Empty store / no repo match /
  any error -> emits NOTHING (fail-open). Tune with `agent.memory_inject` (`"on"` | `"off"`).
  Alongside it, a new `receipts kb` CLI verb reads the same store (zero deps): `kb recur` (a
  recurrence report - group by `surface_key`, count + outcomes histogram + last ts + top
  `what_failed`, most-recurring first) and `kb distill` (conservative, rule-based, never
  auto-applied suggestions: a `surface_key` with >=2 non-fixed outcomes -> declare a G6 family / a
  `receipt-cmd` probe; a repo with >=2 `reverted` -> `gates.G12.mode: "block"`; >=2 `flaky`
  mentions -> `verify.receipt_runs: 2`), both with `--repo` and `--json`. New config key
  `agent.memory_inject` (schema). No MCP server / bundle change (the hook + CLI read the JSONL
  directly). No version bump.
- **In-session tripwires - PreToolUse guards between the Stop hook and the CI enforcer.** A new
  `pre-gates.mjs` hook (registered under `PreToolUse` for `Bash|Edit|Write|MultiEdit`) raises the
  weak-agent floor AT the risky action, not a stop-cycle or a PR later. Two guards:
  (1) **commit-without-verification** - a `git commit` (command-boundary matched, so a `git commit`
  inside a printf/string is data, not a commit) that lands right after a production-source edit
  with NO test / `receipts observe` command run in between is DENIED: a commit is a claim it works
  (G0/G9). (2) **G11-live referee** - editing a TEST file whose test was seen FAILING earlier in
  the session with no passing run since is DENIED (fix the code, not the referee); conservative -
  it needs the file named on the same output line as a fail token, and allows when unsure. Both are
  DENY-by-default (PreToolUse has no reliable agent-visible warn channel) with an EXPLICIT, greppable
  escape - never a silent skip: `RECEIPTS_ACK='<why>'` / `RECEIPTS_TRIPWIRE=off` / `--no-verify-receipts`
  in the command, or a `test-removal: <why>` note in the edit. Tunable per project under
  `agent.tripwires` (`commit_unverified`, `g11_live`, `test_command_patterns`); ships generic, works
  zero-config. Fails SAFE on any parse/IO problem (a missed tripwire beats a spurious deny that jams
  the agent). New config key `agent.tripwires` (schema + enforcer KNOWN_KEYS). No version bump.
- **Stop-hook refire damping - stop re-blocking a close-out the human has already seen.** The Stop
  gate (`stop-gates.mjs`) used to re-block the SAME unaddressed close-out on every subsequent Stop
  (observed: ~8 redundant blocks in one session). It now records a per-session SIGNATURE of what it
  blocked (a hash of the last close-out's index+content, which halves fired, and the merge / evidence
  / trajectory-append indices) in a state file under `os.tmpdir()` keyed by the transcript path. Once
  a signature has fired >= 2 times AND a fresh USER turn has entered the transcript since the last
  block (the human saw it and moved on), the hook stands down SILENTLY for that exact signature.
  Never damps on the 1st or 2nd firing, and any NEW close-out / merge / evidence / trajectory append
  changes the signature -> a fresh count, enforcement fully re-arms. The state file failing to
  read/write FAILS OPEN to the current behavior (block) - a lost damp beats a lost gate.
- **Live receipts - machine-validated deployed-build evidence for the Stop hook.** The
  deployed-build backstop used to accept prose/pattern-matched evidence: "a navigate happened,
  then a screenshot happened" cleared the gate even when the value on screen was wrong. A new
  `receipts observe` verb produces a `receipts/live-receipt@1` artifact instead - ONE command a
  weak agent can be right by running: it probes the LIVE build (`--cmd '<curl/query>'` or
  `--url '<https>'`), captures the output (bounded ~2KB), computes `met` with the SAME red/green
  law a command receipt uses (exit-0 / 2xx floor + optional `--expect '/regex/'`), binds the
  observation to the build (`--sha-cmd '<print the sha>'` / `--sha <id>`, else `artifact.kind:
  "none"` - allowed but weaker), and prints exactly one `LIVE-RECEIPT: {json}` line (exit 0 iff
  met, but the marker ALWAYS prints - a failed observation is evidence too). `--cmd`/`--sha-cmd`
  are exit-masking-guarded (a masked exit fakes met - G9) and `--url` must be https/localhost.
  The Stop hook (`stop-gates.mjs`) now scans the close-out window for the marker (robustly, from
  inside the JSON-stringified tool_result it lands in): a `met:true` receipt bound to the build
  satisfies BOTH the deploy-binding and the observation at once; a `met:false`-only close-out
  blocks with a precise "the observation FAILED - the symptom is not gone" message. Additive and
  backward compatible - the existing navigate+screenshot heuristics still count by default. New
  opt-in strictness: `agent.evidence: "live-receipt"` makes a valid live receipt the ONLY thing
  that clears the gate, and the block message then tells the agent the exact command to run.
  Schema + docs in `spec/LIVE-RECEIPT.md`; new config key `agent.evidence` (schema + enforcer
  KNOWN_KEYS). No version bump.
- **Command receipts - a receipt is any re-runnable command with an expected outcome.**
  Alongside `receipt: <path>`, a PR body may carry `receipt-cmd: <shell command>` lines: the
  command IS the receipt, so software with no test runner (an API, a data pipeline, a CLI,
  infra) can carry one at all. The command must FAIL its expectation on base (reproduce the
  symptom) and MEET it on head (symptom gone) - the same red->green law. Expectation defaults
  to exit code 0; an optional trailing ` expect:/<regex>/` also requires the output to match
  (JS regex, multiline, against stdout+stderr) - e.g.
  `receipt-cmd: sqlite3 app.db "select count(*) from users where email is null" expect:/^0$/`.
  Multiple lines are ANDed (like multiple `receipt:` pins) and may be mixed with them. Runs
  through the SAME machinery as `test_command` (cwd = repo root at the ref, `command_timeout_ms`,
  `receipt_runs` determinism, the G9 exit-masking guard, recorded into the receipt's
  `commands[]` and a new `command_receipts` field); a command already green on base is the same
  weak-receipt block; `receipts replay` reconstructs the `receipt-cmd:` lines. No new config key
  - the grammar lives in the PR body. `receipts init` points runner-less stacks at it instead of
  inventing a fake `test_command`. Threat model (README): a PR body supplying a command adds no
  new exposure over the PR's own test code the enforcer already runs, with a read-only token and
  the same exec path as test commands. Full grammar + a worked example per medium in
  `spec/RECEIPT.md`; `spec/MEDIA.md` maps the executable receipt form per medium.
- **gates-bench: a deterministic weak-agent behavior matrix** (`bench/`, repo-only, not
  shipped to npm). Measures whether the harness turns weak-agent output into reliable
  verdicts, WITHOUT calling a live LLM: a "weak agent" is simulated as scripted misbehavior
  classes (wrong-fix-claims-fixed, no-receipt, weak-receipt, delete-failing-test,
  silence-alarm, partial-rollout, breaks-dependent, rides-along) run through the REAL
  enforcer, plus a hook lane (close-without-evidence / honest-downgrade /
  bound+observed) run through the real Stop hook. Fixtures are generated on the fly
  (`makeRepo`, no committed repos, no network, no npm install) across 4 stacks - node,
  python, bash, and a data/no-test-runner stack that intentionally degrades to document the
  Phase-1 gap - all on `ubuntu-latest` preinstalled tooling. `node bench/run.js` runs the
  task x behavior matrix, prints per-gate catch rate + escape rate + false-block rate
  (`--json` for machine reads), and exits non-zero on any UNDECLARED escape or false-block;
  declared-expected escapes (weak-receipt) are reported but do not fail. `--gates-off` gives
  the A/B baseline. Current result: 48 cells, 71% catch, 29% escape (all declared:
  weak-receipt + the config-permitted no-receipt-warn hatch), 0% false-block; gates-off
  baseline 82% escape. The bench exposed two harness surprises (G7's
  suite-green shortcut over-trusting a narrow `suite_command`; G6's JS-only auto-heuristic
  needing a declared family for multi-language rollouts) - documented in `bench/README.md`,
  not yet fixed.
- **G7 speaks Python.** The dependent-selection scan now covers Python alongside JS/TS:
  repo-relative absolute imports (`a.b.c` -> `a/b/c.py` / `__init__.py`), relative imports
  (`from ..shared import x`), from-import submodule forms, alias/comma lists - with
  new-file AND new-edge detection and co-located test mapping (`test_mod.py` /
  `mod_test.py` / `tests/test_mod.py`). src/-layouts and namespace packages are not
  resolved by the built-in scan - those repos declare `gates.G7.graph`. Venv/site-packages
  are never consumers.
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
- **Stop hook: a decorated status value no longer evades close-out detection.** The
  anchored match required the configured status to be the ENTIRE JSON string value, so a
  leading emoji/symbol pill (`"[x] Pending Retest"`) or a trailing note
  (`"Pending Retest - awaiting tester"`) silently disabled the verification gate. The
  status now matches at the start of the value (non-word prefix allowed, suffix allowed);
  a status mentioned mid-prose still does not fire.
- **Stop hook: hyphen/space-tolerant exit tags actually work.** The `[- ]?` / `\s+`
  transforms in the trajectory reminder's exit-disposition regex operated on escape
  sequences the JS escaper never emits (a Python-port artifact), so "unverified reasoned"
  and "won't  fix" variants missed the nudge. The transforms now target the literals.
- **PR-comment report: `reason`/warning text cannot fire live @-mentions.** Both render
  outside code spans and interpolate PR-controlled text (file names, config values); a
  crafted `@user` would have notified via the bot's comment. A zero-width space now breaks
  the mention without altering the visible text.
- **G6: a comment right after a colon is stripped like any other comment.** The URL guard
  protected ANY `://`, so `x: string //note` and `onPage://TODO: wire Pagination` leaked
  comment text into the tokenizer and a twin could read as having adopted an affordance it
  only mentions in a comment. Only known URL schemes (`https://`, `wss://`, ...) survive.
- **G7 Python: a from-import name guess no longer fabricates a phantom dependent.**
  `from pkg.mod import thing` guessed `pkg/mod/thing` as a module path even when
  `pkg/mod.py` exists (so `thing` is a symbol); an unrelated file at that path made its
  importer a false dependent - re-running (or in block mode, failing) the wrong tests.
  The guess is now dropped when the parent module file exists in the tree; real
  submodule imports (`from myapp import models`) are unaffected.

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
