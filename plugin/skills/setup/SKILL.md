---
name: setup
description: >-
  Use when installing, updating, configuring, or re-checking receipts - "install receipts",
  "install receipts from shaheershoaib", "update receipts", "set up receipts here", "run
  receipts init", "is my receipts config current", "receipts doctor". Owns the whole flow:
  install or update the plugin, then interview the human for the reachability facts detection
  cannot find, write them to receipts.config.json, and confirm with doctor. The interview is
  the point - a config nobody answered lets an unverified fix ship wearing an honest downgrade.
---

# receipts setup

Setup is an **interview you conduct**, not a command you run. `receipts init` detects what it
can (test runner, deploy platform, branch) and asks a human for four things nothing in the repo
reveals. You are the one holding the conversation, so you must put those questions to the user
and relay the answers.

**You cannot drive `init`'s prompts.** Its readline cannot be fed by a pipe (buffered lines are
dropped) or a pty (input echoes before readline attaches). Ask in conversation, then pass the
answers as flags. That is the supported path, not a workaround.

## 0. The CLI is a SEPARATE package - make sure it is reachable

This plugin ships the skills, hooks and MCP server. It does **not** ship the `receipts`
command; that is the `receipts-cli` npm package. On a machine that has only installed the
plugin, `receipts` is not on PATH and every command below fails with "command not found".

Check once, and use whichever form works for the rest of the session:

```
command -v receipts || echo "use: npx -y receipts-cli@latest"
```

- On PATH -> use `receipts <cmd>` directly.
- Not on PATH -> use `npx -y receipts-cli@latest <cmd>` everywhere below. No install needed.
- The user wants it permanently -> `npm i -g receipts-cli` (their call, not yours to assume).

Every `receipts ...` in this document means "whichever of those two forms works here".

## 1. Which situation is this?

| Signal | Go to |
|---|---|
| Plugin not installed / "install receipts" | §2 Install |
| Installed, no `receipts.config.json` in the project | §3 Interview |
| Installed, config exists, "update receipts" | §4 Update |
| "is my config current" / "receipts doctor" | §5 Doctor |

Check with `claude plugin list` and `ls receipts.config.json`.

## 2. Install

```
claude plugin marketplace add shaheershoaib/receipts
claude plugin install receipts@receipts
```

The plugin gives you skills, hooks and the MCP server. The `receipts` CLI is separate
(`receipts-cli` on npm) - see §0; `npx -y receipts-cli@latest` needs no install.

Then **tell the user to restart the session** - skills, hooks and the MCP server load at session
start, so nothing is active until they do. Say so explicitly; do not let it be discovered later.

After the restart, continue at §3. If the user came back to you after restarting, do not
re-install - go straight to the interview.

## 3. Interview, then write the config

The interview is the **observation contract** (`spec/MEDIA.md`): where the behavior manifests, what
value is asserted and by which tool, what commits the effect, what "the build that carries your
commit" means, twins, dependents, the receipt form, and where producer and consumer update
independently. Most of it can be DRAFTED from the project; only the residue needs a human. Which
questions those are depends on the medium: a CLI tool is asked how it is invoked and whether any
behavior is TTY-only, a data pipeline where its outputs land, a web app about a signed-in state.

1. **Get the brief.** `receipts init --agent --dir <dir>` prints JSON and writes nothing:
   `detected` (stack, test command, platform, medium), `contract` (the nine questions), `draft`
   (a full config with `agent.observe` prefilled from the medium's worked row), and `residue`
   (the questions only a human can answer, phrased for that medium; plus `environment` when a
   deploy platform was found).
2. **Sharpen the draft against the repo.** Read what an engineer would: README, CI workflows,
   `.env.example`, deploy config, test layout, the entry points. Correct `gates.medium` if
   detection guessed wrong. Fill `observe.twin`, `observe.dependent`, `observe.compat_boundary`
   and tighten `surface` / `value` / `observe_by` / `terminal_action` / `build_artifact` /
   `receipt` in the project's own nouns. Where the repo already answers a residue question
   (an `OTP_DEV_MODE` flag, a `--dry-run` mode, a fixtures directory), record it as a draft.
3. **Ask the human ONLY what remains.** Put the unanswered residue to the user together, in your
   own words with the project's nouns, and show them the drafts you filled so they can correct
   them. "None needed" is a real answer and must be recorded as one - it is different from silence.
4. **Write it.** Compose `answers.json` as a PARTIAL config (only what you are setting), e.g.

   ```json
   { "gates": { "medium": "cli" },
     "agent": { "observe": { "twin": "none", "dependent": "the release workflow",
                             "reach": { "access": "npx mytool from any directory, no credentials",
                                        "shortcut": "--yes", "fixtures": "any directory",
                                        "special_surfaces": ["interactive prompts"] } } } }
   ```

   then `receipts init --yes --dir <dir> --answers answers.json`. An `agent.observe` block in the
   answers marks `observe.confirmed: true` - the interview happened, in conversation. Add
   `--env <name> --env-url <url>` when there is a deployed environment; add `--force` to overwrite
   an existing config (warn the user first, and carry hand-tuned values across).

The 0.7 flags `--drive-auth / --drive-bypass / --drive-data / --drive-browser-surfaces` still relay
into `observe.reach` and are deprecated. `init` also writes a short receipts block into `AGENTS.md`
and the full gates into `.receipts/gates.md` for non-Claude agents (`--no-agents` skips both).

Writing the config is also what turns enforcement ON for this repo: the in-session tripwires and
the Stop gate stand down wherever no `receipts.config.json` (project or `~/.claude`) exists, so
tell the user that from now on an unverified commit prompts them (`ask`) rather than passing.

**Never run `init --yes` without `--answers` (or the deprecated `--drive-*`) to get past the
prompts.** That records `observe.confirmed: false` - answering on the user's behalf with
"unknown" - and a PreToolUse tripwire denies it outside CI.

## 4. Update

```
claude plugin marketplace update receipts
claude plugin update receipts@receipts
```

Then run `receipts doctor` in each project that has a config (§5) - an upgrade can add fields an
older config predates. Tell the user a session restart is needed for the new version to load.

## 5. Doctor

`receipts doctor --dir <dir>` audits a config and exits 2 when anything needs attention. It
groups findings:

- **STALE** - the project moved and the config did not (a renamed test script, a removed deploy
  config). Re-run `init` to re-detect.
- **MISSING** - never bound (no test command, no `agent` block, loop skills on disk that nothing
  watches, gates this version ships that a pinned `gates.enabled` list is not running).
- **NEEDS YOUR ANSWER** - only a human knows these. doctor prints the four questions verbatim.
  **Put them to the user** and re-write the config with `--answers` from §3. Do not
  treat this section as informational.

An agent-home config (a skills/session directory with no code) has no `build`/`verify` block by
design and passes clean; do not "fix" that by adding one.

## What the answers are for

They are read back, not filed away:

- The **Stop gate** cites a recorded auth route to refuse an "auth-walled, could not verify"
  downgrade - with a route on record, that excuse is not available.
- **SessionStart** injects them into context every session, so the way in is known before
  verification starts rather than rediscovered mid-flow.
- An **empty but confirmed** block means a human said "nothing needed". An **unconfirmed** one
  means nobody was asked - an open question, never evidence a surface is unreachable.

Once set up, the `gates` skill carries the discipline itself; this skill is only for install,
setup, update, and doctor.
