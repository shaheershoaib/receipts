# The Live Receipt artifact

A **live receipt** is machine-validated evidence that a fix's reported symptom is gone *on
the running system* - the deployed URL, the staging database, the installed CLI. Where the
[command receipt](RECEIPT.md#the-command-receipt-a-receipt-is-any-re-runnable-command) proves
a fix at the **pull request** (red on base, green on head, re-run by the enforcer in CI), the
live receipt proves it at the **close-out** (the agent's Stop-cycle): it is a *probe run
against the live build*, with its output captured, its expectation evaluated, and the
observation **bound to the build** it was taken on.

It exists to close the biggest weak-agent hole in the deployed-build backstop. The Stop hook
used to accept prose/pattern-matched evidence: "a navigate happened, then a screenshot
happened" satisfied the gate even when the value on screen was wrong (the screenshot was of a
failure, or of the old build). The live receipt replaces that heuristic with a structured
artifact whose `met` is computed by the same red/green law a command receipt uses -
**exit-0/2xx floor plus an optional regex** over the captured output - so "I observed it" can
no longer be faked by observing *something*.

It is produced by one command, `receipts observe`, which prints exactly one marker line into
the agent's transcript; the Stop hook reads that line. See "How it is produced" below.

## Schema (`receipts/live-receipt@1`)

```json
{
  "schema": "receipts/live-receipt@1",
  "probe": { "kind": "cmd", "spec": "curl -fsS https://acme-staging.vercel.app/api/orders/42" },
  "expect": "\"status\":\\s*\"paid\"",
  "observed": "…captured output / response-body tail, bounded ~2KB…",
  "met": true,
  "artifact": {
    "kind": "deploy-sha",
    "id": "4e3c1a9b2f…",
    "source": "gh api repos/acme/app/deployments --jq '.[0].sha'"
  },
  "generated_at": "2026-07-01T15:04:05.000Z"
}
```

## Field notes

- **`probe`** - what was run against the live system.
  - `kind: "cmd"` - a shell command (a `curl` against a deployed URL, a `psql`/`sqlite3`
    staging query, a CLI invocation against the installed artifact). `spec` is the command
    string verbatim.
  - `kind: "url"` - an HTTPS URL fetched directly (Node's global `fetch`, node >=18). `spec`
    is the URL. `met` requires a 2xx status (and the regex over the body, if given).
  - The probe MUST run against the **live** build - the point of a live receipt is that it is
    not a local unit test (that is the [command receipt](RECEIPT.md)'s job at the PR). A `curl`
    to `localhost` is only a live probe if `localhost` *is* the deployed build under test (a
    port-forwarded staging box, a preview server); prefer the real deployed host.
- **`expect`** - the regex SOURCE string the observation must match, or `null` for
  exit-0/2xx-only. Same semantics as a command receipt's `expect:/…/`: compiled multiline,
  tested against the captured output (`cmd`: stdout+stderr; `url`: the response body).
- **`observed`** - the captured output, bounded to ~2KB (the **tail** is kept - the end of a
  response body or command output is where the asserted value usually lands). Evidence, not a
  full log: enough to see *why* `met` is what it is, re-readable in the transcript.
- **`met`** - did the probe MEET its expectation? The identical floor a command receipt uses:
  - `cmd`: process **exit 0** AND (if `expect` given) the regex matches the output.
  - `url`: HTTP **2xx** AND (if `expect` given) the regex matches the body.
  A `met: false` receipt is still evidence - it records that the symptom is **not** gone (the
  probe failed). The Stop hook treats a met:false-only close-out as an explicitly FAILED
  observation, a more precise signal than "no evidence at all".
- **`artifact`** - binds the observation to the build it was taken on (**G3**: verify on the
  build that carries your commit). Without this binding, a green probe could be a green
  against the *old* build - the classic false-positive the deployed-build gate exists to stop.
  - `kind: "deploy-sha"` - a commit sha the live build reports (e.g. a `/version` endpoint, a
    `gh api …/deployments` lookup, a build-info header). The strongest binding.
  - `kind: "pkg-version"` - a released/installed version string (e.g. `mytool --version`,
    an npm dist-tag) - the binding for a library/CLI where "deployed" means "published".
  - `kind: "none"` - no build identifier was resolved. **Allowed but weaker**, and
    deliberately so: some media have no deploy to bind to (a pure library consumed only as
    source, a CLI verified from a local build, a probe where no version/sha channel exists).
    A live receipt with `kind: "none"` records an honest observation but does **not** satisfy
    the deployed-build gate's binding requirement - it needs a real artifact id to do that.
    Prefer resolving *some* id (a `--sha`/`--sha-cmd`); fall back to `none` only when there
    genuinely is no build channel, the same spirit as the honesty ladder.
  - `id` - the resolved string (a sha, a version), or `null` for `kind: "none"`.
  - `source` - HOW the id was resolved: the `--sha-cmd` command string, or `"--sha (verbatim)"`
    when passed directly. Auditability - a reader can re-resolve the same id.
- **`generated_at`** - ISO-8601 timestamp of when the probe ran.

## How it is produced (`receipts observe`)

One command produces a valid live receipt, so a weak agent can be *right* by running one
line. It runs the probe NOW, captures the output, evaluates `met`, resolves the artifact, and
prints exactly one marker line to stdout:

```
LIVE-RECEIPT: {"schema":"receipts/live-receipt@1","probe":{…},"expect":…,"observed":…,"met":…,"artifact":{…},"generated_at":…}
```

That single line - `LIVE-RECEIPT: ` followed by compact single-line JSON - is the hand-off to
the Stop hook. It lands in the agent's transcript (inside the command's tool-result), and the
hook scans the close-out window for it.

```
# a deployed URL, asserting the rendered value, bound to the live deploy's sha
receipts observe \
  --cmd 'curl -fsS https://acme-staging.vercel.app/api/orders/42' \
  --expect '/"status":\s*"paid"/' \
  --sha-cmd 'gh api repos/acme/app/deployments --jq ".[0].sha"'

# a direct HTTPS fetch (met = 2xx AND the body matches), version-bound
receipts observe \
  --url 'https://acme-staging.vercel.app/health' \
  --expect '/"ok":true/' \
  --sha 4e3c1a9

# a staging DB by-value read (a data ticket), sha-bound
receipts observe \
  --cmd 'psql "$STAGING_DB_URL" -tAc "select status from orders where id=42"' \
  --expect '/^paid$/' \
  --sha-cmd 'gh api repos/acme/app/deployments --jq ".[0].sha"'
```

**Flags.**

| Flag | Meaning |
|---|---|
| `--cmd '<command>'` | Run a shell command; `met` = exit 0 (+ regex if `--expect`). Mutually exclusive with `--url`. |
| `--url '<https url>'` | Fetch a URL; `met` = 2xx (+ regex over the body if `--expect`). Must be `https://` (or `http://localhost` / `http://127.0.0.1`). |
| `--expect '/<regex>/'` | Optional stdout/body assertion. Same grammar as `receipt-cmd`'s `expect:/…/` - a JS regex between slashes; the surrounding `/…/` is stripped. |
| `--sha-cmd '<command>'` | Resolve the artifact id by running this command; its first non-empty output line becomes `artifact.id` (`kind: "deploy-sha"`). |
| `--sha '<id>'` | Take the artifact id verbatim (`kind: "deploy-sha"`). Mutually exclusive with `--sha-cmd`. |
| `--out '<file>'` | Also write the full receipt JSON to this file (the marker still prints to stdout). |

**Exit code.** `0` when `met`, non-zero when not met - so a script can branch on the outcome.
The marker is **always** printed either way (a failed observation is evidence too).

**Trust posture.** `--cmd` and `--sha-cmd` are checked with the SAME exit-masking guard the
enforcer applies to test/receipt commands (`masksExit`): a command that can hide its own exit
code (`;`, `||`, a pipe, a background `&`, a newline, `` ` ``/`$(`) is **rejected** with a
clear message, because a masked exit could fake `met: true`. `--url` must be HTTPS (localhost
http allowed for port-forwarded staging). These are the same self-deception guards as the
command receipt - the live receipt is *not* a security boundary against a hostile author (see
GATES.md "What the Gates do NOT defend against"): it raises the floor on honesty.

## How the Stop hook uses it

The deployed-build backstop (`plugin/hooks/stop-gates.mjs`) already blocks an UNVERIFIED
"fixed" close-out: a ticket moved to a fixed status without, after the last merge, BOTH a
**deploy-binding** (you are pointed at the deployed build) AND an **observation** (you read the
rendered value). The live receipt slots into that gate:

- The hook scans the close-out window (the same merge-floor windowing) for `LIVE-RECEIPT: {…}`
  marker lines anywhere in the transcript entries.
- A live receipt with **`met: true` AND `artifact.kind != "none"`** satisfies BOTH the binding
  and the observation at once - it *is* the by-value read bound to the build. The close-out is
  allowed.
- If the only live-receipt evidence is **`met: false`**, the block message says the
  observation FAILED (the symptom is not gone) - a more precise nudge than "no evidence".
- **Backward compatible.** The existing heuristics (navigate + screenshot, a DOM read, a
  staging query) still satisfy the gate by default; the live receipt is an *additional* way to
  clear it.
- **Opt-in strictness.** Set `agent.evidence: "live-receipt"` in `receipts.config.json` and
  ONLY a valid live receipt (met:true + a real artifact) satisfies the gate - the heuristics no
  longer count. The block message then tells the agent the exact one command to run. Default
  (key absent) preserves the current behavior.

## Why it matters

A screenshot proves a pixel; a live receipt proves a **value**, and binds it to the **build**.
"The agent said it observed the fix" becomes "here is the probe it ran against the live system,
the output it captured, the expectation that output met, and the sha that build carried - re-run
it yourself." It is the deployed-build half of *don't trust, re-verify*: the [command
receipt](RECEIPT.md) does it at the PR, the live receipt does it at the close-out.
