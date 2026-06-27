# enforcer (the universal piece)

The agent-agnostic half of `receipts`: a CI check / GitHub Action that blocks a
"fixed" pull request unless it carries, and **survives**, a receipt. It works no
matter who or what wrote the code, because it lives at the one boundary every team
shares: the PR.

**Status: design + a working precursor.** The Stop-hook prototype in
`../plugin/hooks/stop-verification-gate.py` already does this *locally* (it blocks a
"fixed" close-out that lacks deployed-build evidence). The build here is to move that
referee from "reads my session transcript" to "re-runs the proof at the PR."

## What it does

When a PR claims to fix issue #N:

1. **G3 - bind to the right build.** Confirm the artifact under test carries the PR's
   commit. A green check on the old build proves nothing.
2. **G0/G1/G5 - re-run the receipt.** Re-trigger the reported symptom's acceptance
   test against that build and confirm it is GONE by value. This is the core move:
   the enforcer does not trust a pasted screenshot or a green unit run - it re-proves
   the symptom refuses to reproduce.
3. **Verdict.** Symptom gone -> pass. Symptom still reproduces -> block with the
   evidence. No receipt provided and no honest downgrade tag -> block.
4. **Honest downgrade escape.** A PR that carries an explicit `unverified-reasoned`
   or `speculative` tag (per the spec's honesty ladder) is allowed through, routed,
   and tracked - it is not claiming "fixed."

## The pluggable verify step

Every project reproduces and verifies a symptom differently, so the enforcer cannot
magically re-verify anything. It reads a project config (`receipts.config.json`)
that supplies:

- how to identify the build under test (deploy host patterns, sha source);
- how to reproduce/verify a given symptom (a command, a test selector, or a
  drive-script the project provides);
- the board/label conventions that mark a PR as "claiming fixed."

This is the same shape as the agent-side adapter's project-facts layer: the
discipline is generic, the project supplies its own facts.

## Roadmap

- [ ] Extract the host/board/staging patterns out of `stop-verification-gate.py`
      into `receipts.config.json` (today they are hard-coded to one project - see the
      note in `../plugin/README.md`).
- [ ] Package as a GitHub Action that runs the re-verification at the PR.
- [ ] A minimal `examples/` repo that demonstrates a caught wrong-fix end to end
      (the demo GIF in the root README hangs off this).
