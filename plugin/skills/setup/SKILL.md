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

First look at the project so your questions are grounded: `receipts init --print --yes --dir <dir>`
prints the DETECTED config to stdout without writing anything. Read it, and tell the user what
was detected (test command, deploy platform, medium) so they can correct it.

Then **ask these four in conversation.** Ask them together, in your own words, with the project's
own nouns - not as a form to fill in:

1. How does an agent reach a **signed-in state** on the verify environment? (test account / dev
   bypass / none needed)
2. Any **dev-mode shortcut** that makes it reachable? (fixed OTP, seeded login, magic link, flag)
3. Does that environment carry **realistic data**, or must a surface be seeded before it shows
   anything?
4. Any surfaces that must be driven in a **browser** rather than by API? (rendered PDFs, print
   views)

"None needed" is a real answer and must be recorded as one - it is different from silence.

Then write it:

```
receipts init --yes --dir <dir> \
  --drive-auth "<answer 1>" \
  --drive-bypass "<answer 2>" \
  --drive-data "<answer 3>" \
  --drive-browser-surfaces "<answer 4, comma-separated>"
```

Add `--env <name> --env-url <url>` when the project has a deployed environment to verify against.
Add `--force` to overwrite an existing config; warn the user first that it overwrites, and copy
any hand-tuned values across.

**Never run `init --yes` without the `--drive-*` flags to get past the prompts.** That records
`drive.confirmed: false` - answering on the user's behalf with "unknown" - and a PreToolUse
tripwire denies it outside CI.

### Monorepos / split layouts

The config is found by walking UP from the session's cwd, so it must sit where you will be
working, not only next to the code. A repo whose code is in a subdirectory (`app/`, `packages/*`)
wants `init` run in each code package - and a root config too, so the hooks resolve from the repo
root. Root gets the policy (loop skills, statuses); each package gets its own test command.

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
  **Put them to the user** and re-write the config with the `--drive-*` flags from §3. Do not
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
