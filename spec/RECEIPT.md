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
- **`config_source`** records whether the gate config came from the trusted base commit, the PR
  head (first-setup fallback, with a warning), or an explicit `--config`. A receipt read from
  `head` is weaker - the PR controlled its own gate config.
- **`commands`** is the replay core: each command the enforcer ran, with its real exit code and
  duration. `output_tail` is the last 20 lines (full logs can be huge); it is the *why* behind
  pass/fail. A `timed_out: true` marks a command killed by `verify.command_timeout_ms`.
- **`warnings`** carries the non-blocking findings (G8 stale base, G9 suite not configured, a
  load-error red, a head-sourced config), so a PASS-with-caveats is not silently clean.

## Why it matters

The receipt turns "the agent says it's fixed" into "here is the symptom's own acceptance test,
red before and green after, with the exact commands and exit codes - re-run it yourself." It is
the difference between *trusting* a claim and being able to *re-verify* it. Emit it in CI
(`--receipt-out`, uploaded as a build artifact) so every gated PR carries portable proof.
