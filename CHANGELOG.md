# Changelog

## 0.5.2 - 2026-08-31

### Added
- **Configs record the version that wrote them** (`agent.receipts_version`). Nothing previously
  did, so `doctor` had to infer staleness from which fields happened to be missing - a rule
  needing a rewrite for every new field - and after an update nobody was told their per-repo
  configs might be behind. The update step existed only as a sentence in a skill someone had to
  remember to trigger.
- **The upgrade announces itself.** The SessionStart hook compares the stamp against the running
  plugin version and, on a mismatch only, injects one line telling the agent to run
  `receipts doctor` and report what it says to the user. Silent when they match, so a current
  project pays nothing. `doctor` also reports the mismatch outright now.
- **`init` writes `AGENTS.md`** so a non-Claude agent (Codex, Cursor, any AGENTS.md reader) gets
  the same discipline. Previously the adapter was generated into the repo and had to be copied by
  hand - installing the plugin did nothing for Codex at all. Never clobbers: an existing file
  keeps its content and only the delimited receipts block is replaced, so re-running does not
  stack duplicates. Opt out with `--no-agents`. `adapters/AGENTS.md` now ships to npm, without
  which `init` could not read it.

### Fixed
- **`TOTAL_CAP` capped only the memories block, not the whole injection** - despite its comment
  reading "absolute ceiling on additionalContext". The drive facts added in 0.5.0 already escaped
  it. It now caps the combined context, with the bounded, actionable parts first.

## 0.5.1 - 2026-08-31

### Fixed
- **The `setup` skill invoked a CLI the plugin does not ship.** The plugin provides skills,
  hooks and the MCP server - not `bin/receipts.js`, which comes from the separate `receipts-cli`
  npm package. The skill said `receipts init ...` with no mention of `npx` or `npm install`, so
  on a machine that had installed only the plugin the flow it owns died at its first command
  (`command -v receipts` -> not on PATH). The README was right; the skill was not. It now checks
  PATH and falls back to `npx -y receipts-cli@latest`, with a global install offered as the
  user's choice rather than assumed. Adapters regenerated so Codex and Cursor get the same fix.
- **Release-workflow guards.** Publishing broke three ways cutting 0.5.0, each from an edit to
  `release.yml` and each visible only at release time (the workflow runs on tags, so PR CI never
  exercises it): `npm@latest` resolving to npm 12 against a node-20 runner (EBADENGINE), dropping
  `registry-url` so npm never attempts the OIDC exchange (ENEEDAUTH), and no trusted publisher
  configured (E404 - npm masks auth failures as 404). Ten tests now assert the load-bearing
  properties, including the workflow FILENAME: the npm trusted publisher binds to `release.yml`,
  so renaming that file breaks publishing with a 404 nothing else explains.

## 0.5.0 - 2026-08-30

Spec bumped to `receipts/gates@1.5` (additive: the render-fidelity set, plus the
emitted-artifact clarification - both land in the same release).

the data and be silently dropped by the render layer). Closes the "created it, checked the data,
shipped; the surface still does not show it" gap.

### Added
- **`setup` skill.** "install receipts" / "update receipts" / "set up receipts here" now has an
  entry point that owns the whole flow: install or update the plugin, print the detected config,
  put the four reachability questions to the human, write their answers, and confirm with
  `doctor`. Previously nothing triggered on those phrases, so setup depended on an agent reading
  SKILL.md carefully - and the plugin's skills and hooks only load at session start, so the
  thread was usually lost across the required restart.
- **Relayed interview answers: `--drive-auth`, `--drive-bypass`, `--drive-data`,
  `--drive-browser-surfaces`, `--env`, `--env-url`.** An agent CANNOT drive `init`'s readline (a
  pipe drops the buffered lines; a pty echoes them before readline attaches), so there was no
  path for answers collected in conversation to reach the config - the write half of the
  interview was unreachable and untestable. Supplying any `--drive-*` flag records
  `drive.confirmed: true` and is exempt from the `init_unattended` tripwire: the questions were
  asked, just not through readline.
- **Skill frontmatter validation.** A skill whose frontmatter does not parse is not loaded and
  raises no error - it silently is not there. Now a test failure.

### Added
- **`init_unattended` tripwire (default `deny`).** `receipts init --yes` is blocked outside CI.
  The reachability interview is the only source of `agent.drive`, and an agent reaching for
  `--yes` answers those questions "unknown" on the human's behalf. The deny reason IS the four
  questions, so the agent is handed exactly what to ask. Escapes: `CI=1`, or an explicit
  `RECEIPTS_ACK=<why nobody can be asked>`.
- **`agent.drive.confirmed`.** Records whether a human actually answered the reachability
  questions. A never-asked empty block and a confirmed "nothing needed" were previously
  byte-identical, so a gate could not tell them apart. A TTY check is deliberately NOT the
  guard - an agent's stdin is not a TTY either, so `isTTY` cannot distinguish scripted CI from
  an agent skipping the interview with a human present.
- **The interview reaches the agent at all.** `INIT.md` - the whole "agent-driven, ask the
  human" design - was not shipped in the plugin, and nothing in `plugin/skills` or `adapters`
  mentioned the interview. SKILL.md now states the four questions verbatim, tells the agent to
  relay them, and binds each gate to the config fields it must read; `references/INIT.md` ships
  via `build:refs`. Adapters regenerated, so Codex and Cursor get the same contract.
- **Reachability facts injected at SessionStart**, so the recorded auth route is used every
  session instead of sitting unread in a file.
- **`receipts doctor` upgrade audit.** Groups findings as STALE / MISSING / NEEDS YOUR ANSWER,
  and for the last prints the four questions verbatim so an upgrading user is asked them rather
  than told a field is absent. Also reports gates this version ships that a pinned
  `gates.enabled` list is not running (`"all"` stays self-updating and is never reported).

### Fixed
- **README install command.** It said `claude plugin install receipts`; the unambiguous form
  that resolves against the marketplace is `receipts@receipts`. Also documents the required
  session restart, which nothing mentioned.
- **`agent.drive` was write-only.** Every occurrence in the tree was in `bin/receipts.js`, the
  writer; the enforcer, the Stop hook and the skill never read it back. `INIT.md`'s promise that
  "a gate can cite the gap rather than treat auth-walled as a fact of nature" had no
  implementation. The Stop gate now cites a recorded route to refuse an "auth-walled" downgrade.
- **`agent.drive` was in neither the schema nor the enforcer's `KNOWN_KEYS`.** With
  `agent.additionalProperties: false`, `init` emitted a config its own schema rejected, and the
  enforcer warned `unknown key(s) not read by the enforcer: agent.drive` on every run.
- **`doctor` failed fresh agent-home configs.** It demanded `verify.test_command` from every
  config, but `init` deliberately deletes `build`/`verify`/`gates` for an agent-home. `init`
  then `doctor` reported the file init had just written as stale.
- **`doctor` never caught a vanished runner or deploy platform**, both promised in INIT.md. Each
  check was guarded on the value still being detectable, so the staleness it existed to find
  passed silently.
- **`gates.enabled` schema was wrong twice over**: the pattern allowed only `G0-G14` while
  GATES.md ships `G0-G19` (a config pinning G15+ failed its own schema), and the description
  said "G0-G13", contradicting the pattern.

### Added
- **G1 corollary - render-count parity.** For a rendered COLLECTION (line items, table rows, a
  list), assert `rendered_count == source_count` read off the rendered output, not the feeding
  API/DB. A dropped-member bug is invisible to a presence check and to a data-side read.
- **MEDIA "created-but-not-rendered" archetype.** For a "not showing" symptom the observable is
  the rendered surface (DOM/PDF/print), never the response that feeds it; an entity rendered on
  more than one surface (live view + PDF/print twin + stored record) is a G6 twin set.
- **"Assert the invariant, not the instance."** When a fix addresses a CLASS of inputs, the
  receipt asserts the class-level invariant, not just the one reported record (the receipt-scope
  companion to G13's diff-scope).
- **`gates.G6.render_twins` enforcer check.** Declare parallel render surfaces of one entity; a
  PR that touches some surface globs of a set but not all is flagged as drift (warn / block).
- **`agent.tripwires.render_unverified` tripwire (opt-in, default off).** After a render-feeding
  edit, a commit whose only verification was a DATA read (query / curl / data-form
  `receipts observe`) - never the rendered surface - is denied, with the standard `RECEIPTS_ACK`
  escape. Inert unless render surfaces are declared.

## 0.4.0 - 2026-08-15

**Relicensed from MIT to Apache-2.0.** Adds an express patent grant with a retaliation
clause (§3), explicit inbound-contribution terms (§5), and a trademark reservation (§6).
The new `NOTICE` file must be preserved by redistributors (§4(d)) - that is the
attribution requirement MIT could not express. Versions already published under MIT
(through `0.3.0`) remain MIT for anyone who received them; this applies going forward.

Spec bumped to `receipts/gates@1.1` (additive: three new gates, three clarified mandates).
The durability gates - the change is correct *now* and wrong later or elsewhere - plus the
standard's first feedback loop on itself.

### Added
- **G15 - force duplicated facts to AGREE.** One fact in two places (a shape declared
  twice, a quantity computed in two modules, a literal vs the enum it refers to) agrees the
  day it is written and drifts silently after. Derive one from the other, or add a check
  that fails on divergence. Scoped to SILENT divergence across a seam: if changing one copy
  turns nothing red, the gate applies. Agent-side.
- **G16 - repair or disclose EXISTING instances.** A fix corrects the producer, not the
  values already produced; a forward-only fix can be fully verified on new instances while
  the artifact named in the report stays wrong forever. The close-out must state the
  disposition (self-heals / backfilled / permanent) and name the reporter's own instance.
  G0's mirror - G0 opens on that instance, G16 closes on it. Agent-side.
- **G17 - a repeated downgrade is a missing capability.** The honesty ladder is a per-item
  escape and is blind in aggregate: N individually-defensible downgrades for ONE reason are
  not N unlucky items. Tally by (reason x surface-class) and, past
  `gates.G17.downgrade_threshold` (default 3), name the missing capability in the run
  summary. Surfacing only, never blocking - a block just pressures a false "fixed". The
  first gate that judges the RUN rather than a change; executable where a trajectory store
  is present, since it already records an outcome per surface.

### Changed
- **G3 now requires the live sha to be OBSERVED, not inferred.** A merge returning MERGED
  and every CI job green say nothing about whether the deploy rolled, and a failed deploy
  characteristically leaves the PREVIOUS artifact serving - so the system stays up and
  answers on old code while a newly-merged client calls endpoints it does not have.
- **G9 gains an isolation corollary.** A green earned on a resource a concurrent run can
  mutate (shared DB/schema, fixture dir, port, seeded account) is not green: give each run
  its own resource or take a lease. The single-run twin of G8 - G8 keeps another
  developer's commits off your base, this keeps another process's writes off your green.
  Triage rule (agent skill): an implausible failure count means suspect the resource before
  the code.
- **G10 gains a REACHABILITY clause.** The deploy window was only one axis; the other is
  whether the call reaches the endpoint at all within a single deploy. Where a client
  reaches a server through a per-route registration layer (proxy handler, gateway route,
  URL config, rewrite table), that registration is part of the contract, and the blindness
  is structural: the server's tests call the handler directly, the client's mock the
  transport, so nothing traverses the registration itself.

The weak-agent trust chain: the three pieces that make an untrusted (or just weak)
agent's "it's done" mean something - a rubric it cannot edit, a rubric proven sharp, and
no cheating around it.

### Added
- **The receipt lock** (`receipt-lock: <sha256>` in the PR body; `receipts lock` prints
  it). The acceptance test is authored/approved by a trusted party FIRST and its CONTENT
  is pinned; the enforcer recomputes the hash over what the PR actually carries (file
  receipts + `receipt-cmd:` lines, order-independent, CRLF-normalized) and BLOCKS on
  mismatch. `claim.require_receipt_lock: true` makes it mandatory for every verified
  claim - the split-authorship posture: the agent makes the locked rubric pass, it does
  not get to write its own. Recorded as `lock` in the artifact and the report.
- **G14, the mutation referee** (`enforcer/g14.js`, default-on when a receipt exists).
  Red->green proves the receipt notices THE fix, not that it would notice a WRONG one -
  so the enforcer breaks each changed line on purpose (flipped comparisons, `&&`/`||`
  swaps, numbers nudged both ways, return-value knockouts, bash `$((…))` nudges;
  string-masked, comment-skipped) and requires the receipt to go red. Survivors are
  named (`gates.G14` in the artifact); warn default, `gates.G14.mode: block`;
  `gates.G14.max_mutants` (12) budgets the run round-robin across files. Closes the
  bench's headline `weak-receipt` escape: 4/5 cells flip to CAUGHT (the fifth is a
  string-shaped symptom outside value-level mutation, declared `g14_immune`); bench
  catch rate 73% -> 85%, escapes 28% -> 15% (all declared).
- **G12 env-sniff**: production code that ADDS a CI/test-environment check
  (`process.env.CI`, `NODE_ENV === 'test'`, `PYTEST_CURRENT_TEST`, `os.Getenv("CI")`,
  `'pytest' in sys.modules`, …) on a verified claim is flagged - the "green in CI,
  broken in prod" cheat no re-run can see. Applies to fix-claims AND work-typed claims;
  `NODE_ENV === 'production'` stays legitimate. New bench cells `tampers-with-receipt`
  and `sniffs-test-env` measure both new defenses as catches.

- **A runnable caught-wrong-fix demo** (`npm run demo`, `examples/caught-wrong-fix/`): the
  founding scar - a height cap shipped for a too-narrow modal - replayed through the real
  enforcer: the wrong fix BLOCKs (weak receipt), the exact-value fix PASSes (G14-proof:
  the demo receipt pins `width === 520`, not "wider than before").
- **`receipts report`** - aggregate receipt artifacts (files or dirs) into team signals:
  verdicts, real-receipt rate, honesty-ladder usage, weak/flaky rejections, per-gate
  findings incl. G14; `--json` for dashboards.
- **Generated agent adapters** (`npm run build:adapters`): the gates skill compiled to
  `adapters/AGENTS.md` (any rules-file agent) and `adapters/cursor/receipts.mdc` -
  generated from the one source, never hand-edited, current with G14 and the receipt lock.
- **GitLab CI example** (`enforcer/gitlab-ci.example.yml`) - the engine is CLI-first.
- **README: the hotfix playbook** (the honesty ladder as the incident pressure valve) and
  **receipts-accumulate** (keep merged receipts in the suite; G9 re-proves every past
  symptom forever, G11 makes deleting one loud).

### Fixed
- **Python's `__pycache__` could hide a G14 mutant**: a same-length mutation written
  within the same mtime second reuses STALE bytecode (mtime+size validation), so the
  receipt executed old code and the mutant was misjudged. The enforcer drops the sibling
  `__pycache__` on every mutant write and restore. Found by the bench on G14's first run.

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
