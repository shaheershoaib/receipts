# receipts

**Agents need receipts.**

Your AI coding agent just told you it fixed the bug. Did it?

`receipts` is a verification layer for AI-written code. It does not make your agent
faster or more autonomous - the whole industry is already building that. It does the
opposite: it **re-proves the agent's claim before you trust it.** An agent can type
"Fixed ✅"; it cannot fake the reported symptom still being there when `receipts`
re-runs it.

> Everyone is shipping gas: faster agents, bigger swarms. This ships brakes.

---

## The problem

An agent fixes a bug, runs the tests, sees green, and closes the ticket: "Fixed."
The tests passed. The code looks right. CI is happy. And the bug is still there -
because the test exercised the wrong thing, or the fix landed on the wrong surface,
or the change painted correctly in dev and broke in prod, or it patched the symptom
and not the cause.

Real example this was built from: a "modal is cut off" report was read as a vertical
clip. A height cap was written, tested, deployed, and "verified" green - while the
real bug was the modal being too *narrow*. The wrong axis shipped. Only a human
caught it. Every team using AI to write code is hitting some version of this, daily.

The missing referee is simple to state and hard to enforce: **a fix is not done
because the agent says so. It is done when the reported symptom is observably gone
on the deployed build.**

## The core move: don't trust, re-verify

A "looks fixed" screenshot is not a receipt - an agent can produce one for a bug it
never fixed. A *receipt* is the symptom's own acceptance test, re-run against the
real build, coming back clean. `receipts` re-runs it. The agent does not get to
grade its own homework.

## How it works: the Seven Gates

The Seven Gates (`spec/SEVEN-GATES.md`) are the standard a fix must clear. Each one
exists because skipping it shipped a wrong or unverified "fix" at least once - every
gate carries the real scar that motivated it.

They split into two kinds:

| Gate | Job | Where it lives |
|---|---|---|
| **G0** reproduce the symptom (it IS your acceptance test) | verify | PR / CI (re-run) |
| **G1** assert the rendered VALUE, not a placeholder | verify | PR / CI (re-run) |
| **G3** verify on the build that carries YOUR commit | verify | PR / CI |
| **G5** drive the flow to its TERMINAL action | verify | PR / CI (re-run) |
| **G2** pin the EXACT flow / component | target | agent-side |
| **G4** land on the surface the reporter SEES | target | agent-side |
| **G6** sweep the changed pattern's parallel TWINS | target | agent-side |

The **verify** gates (did you actually prove it works) are enforceable at the one
chokepoint every team shares regardless of which agent they use: the PR. The
**target** gates (did you fix the *right* thing) live inside the agent's loop, and
ship as adapters.

## What's in here

- **`spec/`** - the Seven Gates standard. The IP. Each gate + its real scar.
- **`enforcer/`** - the universal piece: a CI check / GitHub Action that blocks a
  "fixed" PR unless it carries, and *survives*, the receipt. Agent-agnostic - works
  no matter who or what wrote the code. **(in progress)**
- **`plugin/`** - a Claude Code plugin (the agent adapter): teaches your agent to
  produce receipts as it works, so its PRs pass the gate naturally.
- **`plugin/mcp/trajectory-kb/`** - the memory layer: what was tried on a surface and
  how it turned out, so the gates *learn* and stop the team repeating the same trap.

## Install

Two independent paths - use either or both.

**Enforce it at the PR (any agent):**
```bash
# add the receipts check to your CI; block fix-claims that lack a surviving receipt
# (GitHub Action - in progress)
```

**Teach your agent to pass it (Claude Code):**
```bash
claude plugin marketplace add <this-repo>
claude plugin install receipts
```

**Configure it for your project (any stack, any platform):**
```bash
receipts init   # detects your stack + deploy target, confirms with you, writes receipts.config.json
```

It works across any repo because the gate *logic* ships generic and only the project
*plumbing* (how to test, where it deploys, what marks a fix-claim) is detected per
project. See [enforcer/GENERALIZATION.md](enforcer/GENERALIZATION.md) for how,
[enforcer/INIT.md](enforcer/INIT.md) for what `init` detects vs asks, and
[receipts.config.example.json](receipts.config.example.json) for the output.

## Status

Honest: the *discipline* is battle-tested - it has run a production codebase's bug
pipeline for months and caught real money-path regressions.

Built and working today:
- the Seven Gates spec (`spec/SEVEN-GATES.md`)
- the focused `seven-gates` agent skill + two Stop-hook backstops (the Claude Code adapter)
- the `trajectory-kb` memory MCP
- `receipts init` - detects stack + deploy target, confirms, writes `receipts.config.json`

The next build is the **universal CI enforcer**: the re-verification at the PR
(design in `enforcer/GENERALIZATION.md`; a local Stop-hook precursor ships in the
plugin today).

## License

MIT. (The verification discipline should be free and everywhere.)
