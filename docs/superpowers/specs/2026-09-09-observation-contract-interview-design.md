# The init interview is the observation contract, reasoned by the agent

**Status:** approved 2026-09-09 (approach A of three). Ships as 0.8.0 (BREAKING: `agent.drive` -> `agent.observe`).

## Problem

`receipts init` interviewed with four fixed questions (signed-in state, dev bypass, data realism,
browser-only surfaces) and stored them in `agent.drive`. Those are the web row of `spec/MEDIA.md`'s
observation contract, hardcoded. For a CLI tool, a library, a data pipeline or a Terraform repo the
questions are wrong and the config cannot hold the right answers, so the discipline cannot run end
to end there. The init spec already names the intended mode (`--agent`: detection and drafting by
an agent, only the residue to a human); it was never built.

## Design

**Contract as data, reasoning in the agent.**

- `spec/media.json` is MEDIA.md as data: the nine contract questions, the four reach (residue) keys,
  and per medium a worked `row` (drafts) plus `residue` questions phrased for that medium. A test
  keeps it in lockstep with MEDIA.md's table and with the medium ids detection emits.
- `agent.observe` replaces `agent.drive`: `confirmed` (unchanged meaning: a human answered), the
  nine contract fields as strings, and `reach: {access, shortcut, fixtures, special_surfaces[]}`.
  `gates.medium` stays the detected/confirmed medium. `agent.drive` remains in the schema as
  deprecated so un-migrated configs stay valid; `receipts doctor` migrates it (backup first).
- CLI: `init --agent` prints detection + the medium's contract drafts + the residue questions as
  JSON and writes nothing. `init --yes --answers <file>` deep-merges an agent-composed partial
  config over the detected one and marks `observe.confirmed` when it carries `agent.observe`.
  `--drive-*` stay one release as deprecated aliases into `observe.reach`. The no-terminal guard
  and doctor print the detected medium's residue and the `--agent` / `--answers` form. The human
  readline interview asks the medium's residue instead of the web four.
- Hooks: the Stop gate and the SessionStart memory read `agent.observe` and fall back to
  `agent.drive`; the unattended-init tripwire accepts `--answers` as a relayed interview.
- Setup skill: run `init --agent`; read the repo to sharpen the drafts (README, CI, env examples,
  deploy config, test layout); ask the human only the residue the repo could not answer, in the
  project's nouns; write with `--answers`; confirm with doctor.

## Not in scope

Per-medium gate semantics (MEDIA.md already has them); new gates; changing what `confirmed` means.

## Tests

media.json lockstep; `--agent` output per medium fixture (web, cli, library); `--answers` merge and
provenance; alias mapping with deprecation warning; no-terminal guard per medium; doctor migration
with backup; hooks read observe with drive fallback; tripwire allows `--answers`; existing drive
tests moved to observe.
