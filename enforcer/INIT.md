# receipts init

The bootstrap that makes `receipts` "just work" on a new repo: it **determines** what
it can, **proposes** it, **confirms** with you, and **writes** a project-specific
`receipts.config.json`. One step, ~30 seconds, and the gates are tuned to this
project.

## Principles

1. **Determine -> propose -> CONFIRM, never silently trust detection.** A
   verification tool that is silently mis-configured verifies the *wrong thing* -
   worse than no tool. So detection produces a draft; the human (or a deliberate
   `--yes`) confirms before anything is written. This is the product's own ethos
   applied to its own setup.
2. **Agent-driven, with human fallback.** `init` can run as an agent: it reads the
   repo (CI config, deploy config, manifests, README, the GitHub Deployments API)
   and proposes the config, asking a human only for the ambiguous or sensitive bits.
   The tool that verifies agents, set up by an agent.
3. **Configures plumbing, not symptoms.** `init` answers "how do I run this project's
   tests and reach its build," which is finite and detectable. It does NOT try to
   enumerate how to verify every bug - each fix carries its own acceptance test (the
   receipt). This is why `init` stays tractable.
4. **Re-runnable + drift-aware.** Projects switch platforms and rename commands.
   `init` is re-runnable, and the gates self-check: if the configured deploy host
   stops reporting deployments or the test command vanishes, the enforcer says "config
   looks stale, re-run init" rather than passing silently or hard-failing.

## Detection rules (what it reads, and what it concludes)

| Field | Signals it reads | Fallback |
|---|---|---|
| `verify.test_command` | `package.json` scripts.test (npm/pnpm/yarn); `pyproject.toml`/`pytest.ini` -> pytest; `go.mod` -> go test; `Gemfile` -> rspec; `Makefile` `test:` target | ask |
| `build.sha_source` + platform | `vercel.json`/`.vercel` -> Vercel; `railway.json`/`railway.toml` -> Railway; `netlify.toml` -> Netlify; `fly.toml` -> Fly; `render.yaml` -> Render; `.github/workflows/*` deploy steps; else the GitHub Deployments API | `none` (library/CLI: verify against build+test, no deploy) |
| `build.environments` (URLs) | the platform config; the GitHub deployment `environment_url`s | ask |
| `build.verify_against` | one environment found -> use it; staging + prod found -> default staging | ask |
| `claim.issue_link` | scan recent merged PRs for `closes/fixes/resolves #N` | default `closes #(\d+)` |
| `claim.downgrade_tags` | - | default `unverified-reasoned`, `speculative`, `reverted` |
| `agent.loop_skills` | `.claude/skills/*/SKILL.md` whose name/body reads like a fix/build loop (loop / fix / retest / feedback / build / parity / ...) | the shipped `seven-gates`; if no project loop exists, scaffold one from the template |
| `agent.staging_query_patterns` / `agent.closeout_fixed_statuses` | - | generic defaults (DB-proxy / query tools; `Pending Retest` / `Verified`) |
| `agent.repo_name` | `package.json` name, else the directory name | directory name |

## Loop-skill harnesses (driving the trajectory-kb)

The trajectory-kb only earns its keep if something queries it at the start of a fix
and appends at close-out. That lives in a **loop skill**. `init` makes the kb work out
of the box two ways:

- **Register** the project's existing fix/build loop skills into `agent.loop_skills`
  (the Stop hooks watch these for the append-on-exit nudge).
- **Scaffold** one from `plugin/templates/loop-skill/SKILL.md.tmpl` when the project
  has none - a thin loop that rides on `seven-gates`, carries the `query_trajectory` /
  `append_trajectory` touchpoints, and is filled with the project's facts (repo name,
  test command, deploy host), then registered in `agent.loop_skills` automatically.

Either way a clean install + `receipts init` leaves the kb driven and watched, no
hand-editing.

## The confirm flow (example)

```
$ receipts init
receipts init - scanning .

  detected:
    stack       node
    tests       npm test -- {test}          (package.json)
    deploy      vercel                       (vercel.json)
    loop skills myapp-fix-loop               (.claude/skills)

  > Which environment should receipts re-verify on?   [staging]
  > Which skills are your fix/build loops?             [seven-gates, myapp-fix-loop]
  > Extra deploy/prod hosts beyond detected?          (blank to skip)
  > By-value query hosts/tools (e.g. a DB proxy)?     (blank to skip)
Write receipts.config.json with the above?  [Y]/n

# (when NO project loop skill is found, init also offers:)
  > No project loop skill found. Scaffold one (myapp-fix-loop) from the template? [Y]
```

## What it has to ASK (the residue)

The bits no artifact reliably reveals:

- **Which environment to verify** (staging vs production) - a policy choice.
- **Auth to reach a deployed, logged-in app** - the genuinely hard one. Note: the
  primary receipt is the carried red->green test, which runs in CI using the
  project's *existing* test auth/fixtures, so it does not need this. Live-driving the
  authed deployed app is an optional advanced add (`verify.live_drive`), not the
  foundation - so `init` can leave it null and the tool still works.
- **The deploy URL**, only when the platform config does not expose it.

## Output

A `receipts.config.json` at the repo root (schema: `receipts.config.schema.json`;
filled example: `receipts.config.example.json`). After `init`, the gates run tuned to
this project with no further input - and each fix still carries its own proof.

## Modes

- `receipts init` - interactive (the confirm flow above).
- `receipts init --yes` - accept all detected values (CI / scripted setup).
- `receipts init --agent` - hand the detection + drafting to an agent, surface only
  the residue for human confirmation.
- `receipts doctor` - re-detect and diff against the current config (drift check;
  prompts a re-init when the world has moved).
