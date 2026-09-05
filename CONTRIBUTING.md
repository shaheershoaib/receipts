# Contributing to receipts

Thanks for looking under the hood. receipts is a small, zero-dependency Node project with an
unusually thorough test bench, and the bar for a change is the one the tool holds everyone
else to: it carries a receipt.

## Layout

| Path | What lives there |
|---|---|
| `spec/` | The Gates standard (`GATES.md`, `receipts/gates@X.Y`) and the artifact schemas. The source of truth; `plugin/skills/gates/references/` is a generated copy. |
| `enforcer/` | The verification engine (`verify.js` + the `g*.js` gate modules), the GitHub Action, and its self-verification suite under `test/`. |
| `plugin/` | The Claude Code plugin: `skills/` (`gates`, `setup`), `hooks/` (Stop, PreToolUse, SessionStart), `mcp/trajectory-kb/` (the memory server; `server.bundle.mjs` is what ships). |
| `bin/receipts.js` | The `receipts-cli` npm CLI (init, doctor, verify, observe, replay, explain, lock, report, kb). |
| `bench/` | The weak-agent matrix: scripted misbehaviours run through the real enforcer and Stop hook. |
| `adapters/` | Generated from the gates skill for non-Claude agents (`AGENTS.md`, Cursor). |
| `scripts/` | Generators and the plugin install smoke. |

## Setup

Node 18 or newer. There is nothing to install: every suite runs on Node built-ins.

```bash
git clone https://github.com/shaheershoaib/receipts.git && cd receipts
npm test                                                     # enforcer self-verification suite
node --test plugin/hooks/test/*.test.mjs plugin/mcp/trajectory-kb/test/*.test.mjs   # hooks + memory server
node bench/run.js                                            # weak-agent matrix (exits non-zero on any undeclared escape)
CLAUDE_CONFIG_DIR=$(mktemp -d) bash scripts/plugin-install-smoke.sh   # install through Claude Code's plugin manager (needs the claude CLI)
```

CI runs exactly these, plus the enforcer against the PR itself.

## Making a change

1. **Start from the symptom.** Reproduce it in a test before you change anything (G0). For a
   hook, that is a synthetic transcript driven through the real script; see how
   `plugin/hooks/test/pre-gates.test.mjs` builds one. For the enforcer, `enforcer/test/helpers.js`
   builds throwaway repos.
2. **Make the test red, then green.** The PR's changed test files ARE its receipt: the enforcer
   re-runs them on the base commit (they must fail) and on your head (they must pass).
3. **Keep the diff surgical.** Minimum code, no speculative abstractions, comments that explain
   WHY a rule exists (every test file opens with the scar that motivated it).
4. **Regenerate what is generated**, and commit the output:
   - edited `spec/*.md` or `enforcer/INIT.md` -> `npm run build:refs`
   - edited `plugin/skills/gates/SKILL.md` -> `npm run build:adapters`
   - edited `plugin/mcp/trajectory-kb/index.js` -> `cd plugin/mcp/trajectory-kb && npm install && npm run build`
   The bundle test and the adapter files are how drift is caught; do not hand-edit generated files.
5. **Run every suite above** before pushing. A gate that did not run is a fail, not an assumed pass.

## Commits and pull requests

- Conventional Commits: `type(scope): imperative summary`, under 72 characters. A body only when
  the diff cannot explain itself. No AI-attribution trailers.
- One logical change per PR. Squash-merged, so the PR title becomes the commit on `main`.
- The PR template asks for the receipt line the enforcer reads. A PR that says `closes #N` is a
  fix-claim and must carry a red->green receipt; a behaviour-preserving change says
  `work-type: refactor`; a change you could not verify says so with an honest tag
  (`unverified-reasoned: <why>`), which is tracked, never counted as a clean fix.
- Breaking a default (a hook that now fires or stops firing, an `init` output that changes) is a
  `!` commit with a `BREAKING CHANGE:` footer and a CHANGELOG entry under `Unreleased`.

## Reporting a hook false positive

The in-session hooks read your session transcript. The most useful report carries the exact
hook message, the tool call it stopped, and the transcript lines (tool_use + tool_result) around
it; the issue template walks through where to find them. A false positive is treated as a bug in
the matcher, never as something for you to configure around.

## Releasing

Maintainers: see `docs/releasing.md`.
