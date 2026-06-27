# Project facts template (for the feedback-fix-loop)

Copy this file to `<project>/.claude/skills/<project>-loop/SKILL.md`, replace
every `<...>` placeholder, and delete sections that genuinely do not apply
(say so rather than leaving them blank). Keep each fact ONE paragraph in the
section it belongs to - this file is loaded on every loop run, so brevity is
a feature. The loop's step 12 ("ratchet") will grow this file over time;
start minimal.

```markdown
---
name: <project>-loop
description: >-
  Run the <project> feedback-ticket pipeline: the project facts (repos,
  branches, board, commit identities, deploy targets, gates) for executing
  the global feedback-fix-loop skill on <project> work. Use whenever fixing
  or retesting a <project> feedback item - "fix this ticket", "address the
  comments on #NN", "run the loop".
---

# <Project> loop (project facts)

**Process:** invoke the global `feedback-fix-loop` skill - it carries the
loop skeleton and guardrails G1-G6. This file supplies the facts it needs.
If anything here disagrees with auto-memory, memory wins.

## Repos + branches
- **<repo-name>** - <stack>: `<absolute path>`, integration branch
  `<branch>`, deploys to <platform>.
- **Prototype / design source of truth** (if one exists): `<absolute path>`
  - parity-builder builds from it (the prototype IS the spec), parity-sweep
  verifies against it, and specs are extracted from it instead of asking
  reporters for screenshots. Proto-cache lands in
  `<repo>/parity/proto-cache/`.
- Worktrees: `<repo>-worktrees/<branch>`; symlink untracked deps the build
  needs (<node_modules / .env.local / .venv / .env>).

## Gates (all must be green)
- **<repo-name>:** `<exact command(s)>`
- <any custom gate: ASCII-only diffs, migration checks, schema drift - the
  exact command and its expected output. If a gate is a prose rule, see
  pre-commit: materialize it as a repo script.>

## Commit identity (never edit git config)
`git -c user.name=... -c user.email=... commit --author='...'`:
- **<repo-name>:** `<Name> <email>` - <why it matters, e.g. deploy
  author-gates>.
- Trailer on every commit: `<required trailer, if any>`
- Push mechanics: <FF-only? is the integration branch checked out in the
  main worktree (push `HEAD:<branch>` instead of `branch -f`)? expected
  bypass notices?>

## Deploy confirmation (for deploy-verify)
- <platform + project/team ids; what to poll; the alias/URL that must serve
  the pushed sha; typical build duration; staging URL.>

## Ticket board
- <tracker, board/db ids, query URL; status taxonomy; which status YOU set
  vs the tester; close-out mechanics - where resolution notes go and how to
  reply in the reporter's thread.>

## Terminal actions + state-construction recipes (G5)
- <For each multi-step flow: its terminal action (Activate/submit/save) and
  the cheap way to reach it - ideally an API recipe that constructs the
  needed state (create a draft/record, resume it, assert persisted state by
  value, clean up). This is what makes the G5 check ~2 minutes instead of
  hand-driving the whole flow.>

## Twin surfaces (G6 sweep list)
- <Pairs/sets of parallel implementations of the same affordance: sibling
  wizards, duplicate preview cards, repeated contact rows, re-implemented
  input masks. When a fix changes a pattern on one, check/update its twins
  in the same pass. Name files.>

## Known bug classes / worked examples
- <Recurring traps with one worked example each: render gaps, two-sources-
  of-truth seams, empty-string ?? vs || defaults, hidden required fields.>

## Browser driving
- <Staging URL; auth-wall behavior (pause for re-auth, never enter
  credentials); click/typing quirks (JS .click() vs ref-clicks vs
  coordinate scaling); how to assert persisted state by value (API fetch
  from the logged-in tab).>

## Codebase graph (if graphify is mapped)
- <Where to run queries from; what is excluded; when to refresh.>

## Related
- Global: `feedback-fix-loop`, `deploy-verify`, `parity-sweep`,
  `parity-builder` (building/porting surfaces from the prototype),
  `pre-commit`, `git-commit`.
- Project: <project audit skill, status-update skill, etc.>
```

After creating the project skill, run `fewer-permission-prompts` for the
project so loop runs are not throttled by permission prompts on read-only
commands.
