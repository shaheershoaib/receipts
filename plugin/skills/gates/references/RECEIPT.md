# The Receipt artifact

A **receipt** is the proof a verification actually happened: not a "looks fixed" screenshot,
not a green CI badge, but a machine-readable record of *what the enforcer re-ran and what it
saw*. It makes a verdict **auditable** (you can read exactly which commands ran and how they
exited) and is the foundation for **replay** (re-running the same proof later, elsewhere).

The enforcer writes it when invoked with `--receipt-out <path>`, regardless of verdict - a
BLOCK is recorded with the same fidelity as a PASS, so a failing gate still leaves evidence.

## Schema (`receipts/receipt@1`)

```json
{
  "schema": "receipts/receipt@1",
  "generated_at": "2026-06-29T15:04:05.000Z",
  "repo": "/path/or/name",
  "base": "<base commit sha>",
  "head": "<head commit sha>",
  "config_source": "base | head | explicit",
  "is_fix_claim": true,
  "strict": false,
  "work_type": null,
  "verdict": "PASS | WARN | BLOCK",
  "reason": "receipt verified: red on base, green on fix - ...",
  "detail": null,
  "warnings": ["G9 full-scope green not checked: ..."],
  "red": true,
  "green": true,
  "tests": ["src/modal.test.tsx"],
  "gates": { "enabled": "all", "disabled": ["G4", "G5"] },
  "commands": [
    {
      "label": "receipt-red@base",
      "command": "npm test -- \"src/modal.test.tsx\"",
      "ok": false,
      "exit_code": 1,
      "duration_ms": 4213,
      "timed_out": false,
      "output_tail": "...last 20 lines..."
    },
    { "label": "receipt-green@head", "command": "...", "ok": true, "exit_code": 0, "duration_ms": 3987, "timed_out": false, "output_tail": "..." },
    { "label": "suite@head", "command": "npm test", "ok": true, "exit_code": 0, "duration_ms": 51234, "timed_out": false, "output_tail": "..." }
  ]
}
```

## Field notes

- **`red` / `green`** are the heart of the receipt: `red` = the carried test FAILED on the base
  commit (it reproduced the symptom); `green` = it PASSED on head (the symptom is gone). A real
  receipt is `red: true, green: true`. (For an inverted receipt - a refactor/chore - there is no
  red; the proof is the suite staying green, recorded in `commands`.) With
  `verify.receipt_runs` > 1, `red`/`green` mean red N/N and green N/N - each run is its own
  `commands` entry (`receipt-red@base [i/N]`); a mixed result is a flaky-receipt BLOCK, not a
  receipt.
- **`tests` / `pinned`** - the receipt test set. `pinned: true` means the PR named its receipt
  explicitly (`receipt: <path>` in the body) rather than inheriting every changed test file -
  the pin separates the acceptance test from incidental test churn, and may name an UNCHANGED
  test (a fix that makes an existing test flip red->green).
- **`command_receipts`** - the command form of the receipt (see "The command receipt" below):
  each `{ command, expect }` the PR carried as a `receipt-cmd:` line. Present only when the PR
  used one; the command's own runs are recorded in `commands` with a `[cmd ...]` label suffix.
  A PR may carry file receipts, command receipts, or both (all ANDed).
- **`browser_receipt`** - the optional web-medium adapter's result (see "The browser receipt"
  below). Present only when `verify.browser_receipt` is configured: `{ url, source, sha_match,
  ok, output_tail }` - the resolved preview URL, how it was resolved (`env` / `github-deployment`
  / `command`), whether the deployment sha matched the PR head (`true`/`false`/`null` = N/A), and
  whether the browser command passed. It is a HEAD-ONLY acceptance check, so there is no
  `red`/`green` here - `ok: true` means the fixed behavior worked on the preview, not that a
  symptom reproduced first. A `ran: false` field with a `reason` records a skipped run (an
  exit-masking command, an adapter error); an unresolved URL leaves `ok: null` with the reason.
- **`config_source`** records whether the gate config came from the trusted base commit, the PR
  head (first-setup fallback, with a warning), or an explicit `--config`. A receipt read from
  `head` is weaker - the PR controlled its own gate config.
- **`commands`** is the replay core: each command the enforcer ran, with its real exit code and
  duration. `output_tail` is the last 20 lines (full logs can be huge); it is the *why* behind
  pass/fail. A `timed_out: true` marks a command killed by `verify.command_timeout_ms`.
- **`warnings`** carries the non-blocking findings (G8 stale base, G9 suite not configured, a
  load-error red, a head-sourced config), so a PASS-with-caveats is not silently clean.

## The command receipt (a receipt is any re-runnable command)

A receipt does not have to be a *test file*. Plenty of software has no test runner - an HTTP
API, a data pipeline, a CLI, infrastructure - yet still has a re-runnable check with an
expected outcome. For these, the PR body carries a **command receipt** alongside (or instead
of) a `receipt:` path pin:

```
receipt-cmd: <shell command>
receipt-cmd: <shell command> expect:/<regex>/
```

The command **is** the acceptance test. The enforcer runs it against the **base** tree (it
must FAIL its expectation - the symptom reproduces) and the **head** tree (it must MEET it -
the symptom is gone): the identical red->green law, just with a command instead of a test
file. One command per line; multiple `receipt-cmd:` lines are all required (ANDed, like
multiple `receipt:` pins).

**The expectation.** Default = exit code 0. The optional trailing ` expect:/<regex>/` adds a
stdout assertion: the receipt is MET when the command exits 0 **and** (if the suffix is given)
its output matches the regex (a JS `RegExp`, matched multiline against the command's combined
stdout+stderr, so `expect:/^0$/` matches a `0`-on-its-own-line count). Everything before the
` expect:/…/ ` suffix is the command verbatim - a `/` inside the command (a URL, a path) is
not the suffix, only a trailing ` expect:/…/ ` is.

**Execution & trust.** The command runs through the *same* machinery as a `test_command`: cwd
= repo root at the checked-out ref, the same `verify.command_timeout_ms`, the same
`verify.receipt_runs` determinism (fail-to-meet N/N on base, meet N/N on head; a mixed result
is a flaky-receipt BLOCK), and captured into the receipt's `commands[]`. The same G9 guard
applies: a command that can mask its own exit code (`;`, `||`, a pipe, `&`, a newline,
`` ` ``/`$(`) is rejected - wrap it in a script. A command receipt that already MEETS its
expectation on base is the same **weak-receipt** BLOCK as a test green-on-base. No new config
key: the grammar lives entirely in the PR body.

**One example per medium** (each is red on base, green on head):

| Medium | `receipt-cmd:` |
|---|---|
| API / service | `receipt-cmd: curl -fsS http://localhost:3000/orders/42 expect:/"status":"paid"/` (`-f` fails on non-2xx; the regex asserts the body) |
| SQL / database | `receipt-cmd: sqlite3 app.db "select count(*) from users where email is null" expect:/^0$/` |
| CLI stdout | `receipt-cmd: mytool --version expect:/^mytool 2\./` |
| Infra plan-diff | `receipt-cmd: terraform plan -detailed-exitcode` (exit 0 = no drift; the fix converges it) |

## The receipt lock (trusted authorship — the split-authorship primitive)

Every check above verifies the receipt's *behavior*; none verifies its *authorship*. When
the same untrusted agent writes both the code and the acceptance test, the gate verifies
self-consistency, not correctness — a weak agent writes a weak rubric and then satisfies
it. The lock splits the roles: a trusted party (a human, a stronger model) writes or
approves the receipt FIRST and pins its **content**:

```
receipts lock tests/receipts/issue-42.test.js          # run from the repo root
# -> receipt-lock: 3f8a…64-hex…c21                     # paste into the issue / PR body
```

The enforcer recomputes the hash over what the PR **actually carries at head** — the
receipt test files (path + content, CRLF-normalized, order-independent) and/or the
`receipt-cmd:` lines — and **BLOCKS on mismatch**: the agent makes the locked rubric go
green; it cannot weaken, replace, or "adjust" it. A lock line must be a single 64-hex
token (malformed = BLOCK — someone tried and typo'd; prose after the colon is ignored).
Multiple lock lines = any-of (an issue may pre-approve alternative receipts). The result
is recorded as `lock: { present, matched, hash }` in the artifact.

**The untrusted-agent posture:** set `claim.require_receipt_lock: true` and every
verified claim must carry a matching lock — combined with `gates.G11/G12/G14.mode:
"block"`, the weak agent's "it's done" is backed by: an approved rubric it could not
touch, red on base, green on head, deterministic, mutation-checked, suite-green, with no
deleted tests, no silenced alarms, and no CI-sniffing. That chain does not care how weak
the generator is. That is the point.

## The browser receipt (the web medium — head-only)

A rendered-UI symptom (a button that never enabled, a modal that never opened, a value that
never painted) is not something a `receipt-cmd:` curl can prove. A **browser receipt** runs the
consumer's own Playwright/Cypress/e2e script against the PR's **preview deployment** and folds
the pass/fail into the verdict. Configured under `verify.browser_receipt`, it is an OPTIONAL
adapter: Playwright is never a dependency of receipts — the consuming repo brings its own e2e
stack, and receipts only resolves the preview URL, exports it as `RECEIPTS_PREVIEW_URL`, runs
the command, and reads the exit code.

**Head-only, by construction.** A preview deploys only the **head** build; there is no
base-commit preview to run the script red against. So a browser receipt is a HEAD-ONLY
acceptance check (G1/G3/G5-shaped: *does the fixed behavior work on the deploy*) — **not** a
red → green receipt, and it **never substitutes** for the carried red → green one. It runs *in
addition*, when configured. That is why it has its own artifact field (`browser_receipt`) and
report row (`browser-receipt@preview (head-only)`) rather than folding into `red`/`green`.

**URL resolution.** `url_source` picks how the preview URL is found: `env` (read
`verify.browser_receipt.url_env`, default `RECEIPTS_PREVIEW_URL`), `command` (run `url_cmd`, take
the first http(s) line), or `github-deployment` (query the deployments API for the head sha's
`environment_url` via `GITHUB_TOKEN` + `GITHUB_REPOSITORY`). Every path **degrades honestly** — a
distinct *"could not resolve preview URL"* WARN, never a silent pass.

**G3 sha binding.** When the URL resolves via `github-deployment`, the deployment's own sha is
recorded and required `== PR head`; a mismatch WARNs *"preview is not the head build"* (a green
against a stale preview is the classic false positive). Recorded as `browser_receipt.sha_match`.

**Trust & degradation.** The `command`/`url_cmd` come from the trusted base config and pass the
same exit-masking guard as every other command (a green from a masked exit can't be trusted —
G9). The whole adapter is isolated: an unreachable preview, an unresolved URL, or a thrown error
degrades to a **WARN**, never a crash and (unless `mode: "block"`) never a hard fail. Only a
definitive failure (the command ran and exited non-zero against a resolved preview) fails under
`mode: "block"`.

## Why it matters

The receipt turns "the agent says it's fixed" into "here is the symptom's own acceptance test,
red before and green after, with the exact commands and exit codes - re-run it yourself." It is
the difference between *trusting* a claim and being able to *re-verify* it. Emit it in CI
(`--receipt-out`, uploaded as a build artifact) so every gated PR carries portable proof.
