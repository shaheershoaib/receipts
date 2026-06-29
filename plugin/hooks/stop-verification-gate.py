#!/usr/bin/env python3
"""Stop hook: block an UNVERIFIED "fixed" close-out.

The recurring failure: a ticket is moved to Fixed / Pending-Retest (or Verified)
on the strength of a PROXY (green CI, a passing unit test, a DB row read early,
a confident code read) WITHOUT observing the reporter's symptom gone on the
DEPLOYED build. The tester then catches it and resubmits. The verification gate
(the Gates G0/G1/G3) is the one step with no external referee, so it
gets skipped under the pull-to-finish. This hook is that referee.

Fires (decision:block, at most once per stop-cycle) when, this session:
  * a ticket was moved to a "fixed" status (the "claiming fixed" action: a
    notion-update-page setting that Status), AND
  * that close-out is NOT honestly downgraded (no unverified-reasoned /
    unverified / speculative tag in the update), AND
  * the session does NOT show, AFTER the last merge, BOTH of:
      (1) DEPLOY-BINDING - you are pointed at the deployed build: a navigate to
          a deploy host / the staging domain, a get_deployment sha-confirm, a
          Preview tool, or a staging DB query; AND
      (2) an OBSERVATION - you actually saw the rendered value/state, not just
          arrived: a screenshot, a by-value DOM read (read_page / get_page_text /
          javascript_tool / *snapshot / evaluate), or a by-value staging query.

The OLD floor accepted a bare navigate or a lone get_deployment as "verified."
Both are touches, not observations: a navigate proves you arrived, get_deployment
proves the sha is live (G3) - neither proves the reporter's symptom is GONE (G1).
So the bar is now binding AND observation: a UI close needs navigate-to-host PLUS
a screenshot or a DOM value-read; a data close needs a by-value staging query
(which is itself both) PLUS the get_deployment sha-confirm.

Project specifics (which hosts are the deployed build, which DB-query patterns
count, which tracker statuses mean "fixed", which tags are honest downgrades)
come from receipts.config.json - written by `receipts init`, found by walking up
from the session cwd, and MERGED OVER the generic defaults below. With no config
the hook uses the generic defaults, so it still works zero-config.

Detection is STRUCTURAL + ORDERED (real tool_use events + their fields, command
boundaries), mirroring stop-trajectory-reminder.py. Fails SAFE on any parse
problem (a missed nudge beats a spurious block). The by-type bar (which exact
observation each symptom class needs) lives in the skill; this hook is the FLOOR:
binding + SOME observation, or an explicit downgrade, must exist.

Input: Stop-hook JSON on stdin ({transcript_path, cwd, stop_hook_active, ...}).
Output: {"decision":"block","reason":...} when it fires; nothing otherwise.
"""
import sys, json, re, os

# `gh pr merge` only at a command boundary (so a printf/grep containing the
# string as data does not match) - same guard as the trajectory hook.
GH_MERGE = re.compile(r"(?:^|[;&|]|\n)\s*gh\s+pr\s+merge\b")

# Generic default matcher SOURCES (inner alternations). receipts.config.json
# extends these per project; `_extend` ORs the config patterns onto the default.
DEFAULT_DEPLOYED_HOST_SRC = (
    r"\.vercel\.app|\.railway\.app|\.up\.railway\.app|\.netlify\.app|\.fly\.dev|"
    r"\.onrender\.com|\.pages\.dev|stg\.|staging|\.preview\."
)
DEFAULT_STAGING_QUERY_SRC = r"STAGING_DB_URL|DATABASE_URL|db[_-]?proxy|mysql_query|psql"
DEFAULT_DOWNGRADE_SRC = r"unverified[- ]?reasoned|unverified|speculative"
DEFAULT_FIXED_STATUSES = ("Pending Retest", "Verified")

# Compiled defaults; main() reassigns these from receipts.config.json when present.
DEPLOYED_HOST = re.compile("(?:%s)" % DEFAULT_DEPLOYED_HOST_SRC, re.I)
STAGING_QUERY = re.compile("(?:%s)" % DEFAULT_STAGING_QUERY_SRC, re.I)
DOWNGRADE = re.compile("(?:%s)" % DEFAULT_DOWNGRADE_SRC, re.I)
FIXED_STATUSES = DEFAULT_FIXED_STATUSES

# A SCREENSHOT of the rendered build (visual proof you looked at it): the Preview
# screenshot tool, chrome-devtools / Playwright / Firefox screenshot tools, the
# Claude-in-Chrome gif_creator.
SCREENSHOT_TOOL = re.compile(r"screenshot|gif_creator", re.I)
# A BY-VALUE read of the rendered DOM/state (G1 "assert the value"): the authed-
# browser readers and the Preview/devtools snapshot/eval tools.
DOM_READ_TOOL = re.compile(
    r"read_page|get_page_text|javascript_tool|preview_snapshot|preview_eval|"
    r"preview_inspect|evaluate_script|browser_snapshot|browser_evaluate|take_snapshot",
    re.I,
)
# A (Bug) Status property set to a closeout value. Covers boards that label a fix
# 'Fixed' / 'Closed' / 'Verified'. Anchored on the status KEY + value so a
# "1. Fixed the..." Resolution Note does not false-match (that is a different key).
CLOSEOUT_STATUS = re.compile(r'"(?:bug\s+)?status"\s*:\s*"\s*(?:fixed|closed|verified)\b', re.I)


def _read_config_file(p):
    """Read one receipts.config.json. None if absent; {} if present-but-unreadable
    (signals 'found' so the walk-up stops; fail-safe to generics, never crash)."""
    try:
        with open(p) as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception:
        return {}


def _deep_merge(base, over):
    out = dict(base or {})
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_receipts_config(start):
    """Effective config: the agent-home (~/.claude/receipts.config.json) as the base,
    with the nearest project receipts.config.json (walked up from `start`) merged
    over it. Either/both may be absent -> {} (fail-safe to the generic defaults).
    The home layer is what makes a split repo work - skills + session cwd separate
    from the code repo: the agent config lives in one place and applies everywhere."""
    home = _read_config_file(os.path.join(os.path.expanduser("~"), ".claude", "receipts.config.json")) or {}
    proj = {}
    d = os.path.abspath(start or ".")
    for _ in range(40):
        c = _read_config_file(os.path.join(d, "receipts.config.json"))
        if c is not None:
            proj = c
            break
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return _deep_merge(home, proj)


def _glob_to_substr(g):
    # "*.vercel.app" -> "\.vercel\.app"; "reliablepremium.com" -> "reliablepremium\.com".
    g = (g or "").strip()
    if g.startswith("*"):
        g = g[1:]
    return re.escape(g)


def _extend(default_src, extra):
    parts = [default_src] + [_glob_to_substr(p) for p in (extra or []) if (p or "").strip()]
    return re.compile("(?:%s)" % "|".join(parts), re.I)


def gate_on(gates, gid):
    """A gate runs unless the project's `gates` config turns it off (by ID, G0-G10).
    No `gates` block => all on (backward-compatible). Mirrors the enforcer's gateOn."""
    if not gates:
        return True
    if gid in (gates.get("disabled") or []):
        return False
    en = gates.get("enabled")
    if not en or en == "all":
        return True
    return (gid in en) if isinstance(en, list) else True


def walk_tool_uses(obj, out):
    if isinstance(obj, dict):
        if obj.get("type") == "tool_use" and "name" in obj:
            out.append((str(obj.get("name", "")), obj.get("input", {})))
        for v in obj.values():
            walk_tool_uses(v, out)
    elif isinstance(obj, list):
        for v in obj:
            walk_tool_uses(v, out)


def sget(inp, key):
    return inp.get(key) if isinstance(inp, dict) else None


def _txt(inp):
    return inp if isinstance(inp, str) else json.dumps(inp)


def is_fixed_closeout(name, inp):
    """A notion-update-page that sets a Status / Bug Status to a 'this is fixed'
    value (the project's configured fixed-statuses, or the generic Fixed/Closed/
    Verified)."""
    if "notion-update-page" not in name.lower():
        return False
    s = _txt(inp)
    if any(st in s for st in FIXED_STATUSES):
        return True
    return bool(CLOSEOUT_STATUS.search(s))


def is_merge(name, inp):
    if "merge_pull_request" in name.lower():
        return True
    return name == "Bash" and bool(GH_MERGE.search(str(sget(inp, "command") or "")))


def is_deploy_binding(name, inp):
    """Evidence you are POINTED AT the deployed build (not which value you saw):
    a live navigate to the app host, a Preview tool driving a running build, a
    deploy-sha confirm, or a staging DB query (inherently against staging)."""
    n = name.lower()
    if "navigate" in n and DEPLOYED_HOST.search(str(sget(inp, "url") or "")):
        return True
    if "claude_preview" in n or "preview_" in n:
        return True
    if "get_deployment" in n:
        return True
    if "mysql_query" in n:
        return True
    if name == "Bash" and STAGING_QUERY.search(str(sget(inp, "command") or "")):
        return True
    # browser_batch wraps its real actions in input.actions (e.g. a navigate to
    # the deployed host), so the binding is named there, not in the top-level
    # tool name. A batched navigate to a deployed host is the same binding as a
    # top-level one. Gated to the batch wrapper so an unrelated payload that
    # merely mentions a host string cannot false-count.
    if "browser_batch" in n:
        actions = _txt(inp)
        if "navigate" in actions and DEPLOYED_HOST.search(actions):
            return True
    return False


def is_observation(name, inp):
    """Evidence you OBSERVED the rendered value/state (not just arrived): a
    screenshot, a by-value DOM read, a computer-use screenshot action, or a
    by-value staging query (the value IS the observation for data tickets)."""
    n = name.lower()
    if SCREENSHOT_TOOL.search(n):
        return True
    if DOM_READ_TOOL.search(n):
        return True
    # Claude-in-Chrome computer-use: a screenshot action captures the screen.
    if "computer" in n and "screenshot" in _txt(inp).lower():
        return True
    if "mysql_query" in n:
        return True
    if name == "Bash" and STAGING_QUERY.search(str(sget(inp, "command") or "")):
        return True
    # browser_batch wraps its real actions in input.actions, so a batched
    # screenshot / DOM-read / computer-screenshot is named there, not in the
    # top-level tool name - the name-based checks above all miss it. Scan the
    # serialized actions so a batched observation counts exactly like a
    # top-level one (the recurring false-positive: the live verify was driven
    # via browser_batch, the hook saw only "browser_batch" and fired). Gated to
    # the batch wrapper so an unrelated tool whose payload merely mentions
    # "screenshot" (e.g. a Resolution Note) never false-counts.
    if "browser_batch" in n:
        actions = _txt(inp)
        if SCREENSHOT_TOOL.search(actions) or DOM_READ_TOOL.search(actions):
            return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if data.get("stop_hook_active"):
        return
    tp = data.get("transcript_path")
    if not tp:
        return

    # Per-project overrides (or generic defaults). Reassign the module matchers the
    # detection functions read, extended with the config patterns.
    global DEPLOYED_HOST, STAGING_QUERY, DOWNGRADE, FIXED_STATUSES
    cfg = load_receipts_config(data.get("cwd"))
    agent = cfg.get("agent") or {}
    # A non-dict `build` (e.g. a typo'd `"build": "none"`) must not crash the hook or let it
    # silently stand down - coerce to {} so .get is safe and the stand-down check below sees
    # no valid build block, i.e. keeps enforcing.
    build = cfg.get("build") if isinstance(cfg.get("build"), dict) else {}
    claim = cfg.get("claim") or {}
    DEPLOYED_HOST = _extend(DEFAULT_DEPLOYED_HOST_SRC, build.get("deploy_host_patterns"))
    STAGING_QUERY = _extend(DEFAULT_STAGING_QUERY_SRC, agent.get("staging_query_patterns"))
    DOWNGRADE = _extend(DEFAULT_DOWNGRADE_SRC, claim.get("downgrade_tags"))
    FIXED_STATUSES = tuple(agent.get("closeout_fixed_statuses") or DEFAULT_FIXED_STATUSES)

    # This hook enforces verification on a URL-DEPLOYED build (the Gates G1/G3). It does
    # NOT apply when THIS repo has no such build to observe: a library/CLI/artifact config
    # (a `build` block whose sha_source is none / ci-artifact) or one that disables G1/G3 -
    # there the receipt re-run at the PR is the proof. A config with NO `build` block (an
    # agent-home: skills + session cwd, the code repos deploy elsewhere) is left alone, so
    # the split-topology case still enforces. Honors gates.enabled/disabled like the enforcer.
    gates = cfg.get("gates") or {}
    if isinstance(cfg.get("build"), dict):
        # Stand down ONLY on an EXPLICIT no-URL-deploy build (a library/CLI/artifact) or an
        # explicit G1/G3 disable. A missing or typo'd sha_source is treated as unknown ->
        # keep enforcing (fail toward verification), so a malformed build block cannot
        # silently weaken the gate.
        explicit_no_url = build.get("sha_source") in ("none", "ci-artifact")
        if explicit_no_url or not (gate_on(gates, "G1") and gate_on(gates, "G3")):
            return

    try:
        with open(tp, "r", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return

    seq = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            walk_tool_uses(json.loads(line), seq)
        except Exception:
            continue
    if not seq:
        return  # no structured tool calls -> fail safe

    last_closeout = -1
    last_closeout_downgraded = False
    merge_idxs = []
    binding_idxs = []
    obs_idxs = []
    for i, (name, inp) in enumerate(seq):
        if is_merge(name, inp):
            merge_idxs.append(i)
        if is_deploy_binding(name, inp):
            binding_idxs.append(i)
        if is_observation(name, inp):
            obs_idxs.append(i)
        if is_fixed_closeout(name, inp):
            last_closeout = i
            last_closeout_downgraded = bool(DOWNGRADE.search(_txt(inp)))

    if last_closeout < 0:
        return  # nothing was claimed fixed this session
    if last_closeout_downgraded:
        return  # honestly flagged as unverified -> allowed

    # Require, AFTER the merge that shipped THIS fix and at/before the close-out,
    # BOTH a deploy-binding (you are on the deployed build) AND an observation
    # (you saw the rendered value/state). The relevant merge is the LAST one
    # BEFORE the close-out - a merge that lands AFTER the close-out belongs to
    # other, not-yet-closed work and must NOT retroactively invalidate an
    # already-verified close-out (the old-closeout + newer-merge false-positive).
    # If no merge precedes the close-out (a re-verify / no-code close), floor is
    # -1, so any qualifying call before the close-out counts.
    floor = max([m for m in merge_idxs if m < last_closeout], default=-1)
    has_binding = any(floor < e <= last_closeout for e in binding_idxs)
    has_obs = any(floor < e <= last_closeout for e in obs_idxs)
    if has_binding and has_obs:
        return  # bound to the deployed build AND observed by value -> allowed

    # Tailor the nudge to which half is missing (often only the observation is).
    if has_binding and not has_obs:
        gap = (
            "you reached the deployed build (a navigate / get_deployment) but never "
            "OBSERVED the value there. Arriving is not verifying: a navigate proves you "
            "got there, get_deployment proves the sha is live - neither shows the "
            "reporter's symptom GONE. Capture the proof: take a screenshot AND read the "
            "rendered value by DOM (javascript_tool / read_page) on the deployed app, or "
            "for a data ticket run a by-value staging query."
        )
    else:
        gap = (
            "this session shows NO by-value verification on the DEPLOYED build after the "
            "merge. Drive the reporter's exact flow on the deployed app and OBSERVE the "
            "result, do not stop at CI-green / a passing test / a code or DB read."
        )
    reason = (
        "A ticket was moved to a fixed status, but " + gap + " "
        "(the Gates G0/G1/G3). Before stopping, either: (a) BEHAVIOR/UI ticket -> "
        "drive the reporter's exact flow on the deployed app (a real browser on your "
        "staging / production URL), then SCREENSHOT it and read the rendered value; "
        "or (b) DATA/seed ticket -> run a by-value staging query (DB proxy / API) and a "
        "get_deployment sha-confirm; or (c) if you truly cannot observe it (NOT 'my first "
        "try failed', and NEVER for a surface reachable by clicking a visible button), "
        "re-open the close-out note with an explicit 'unverified-reasoned: <why "
        "unobservable + the unit test covering it>' tag and route it to the reporter. "
        "Cite the observed value in the close-out note. Then stop."
    )
    print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    main()
