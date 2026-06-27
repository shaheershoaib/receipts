#!/usr/bin/env python3
"""Stop hook: nudge the agent to append a trajectory-kb entry at loop close-out.

Fires (decision:block, at most once per stop-cycle) ONLY when this session
actually ran a fix/build loop AND reached an EXIT - a clean close-out (PR merge /
deploy-verify / Pending-Retest|Verified) OR an honest downgrade / Won't-Fix - but
recorded no trajectory afterward. Failure exits are the entries most worth
capturing (a success-only store is survivorship bias that blinds retrieval), so a
downgraded / blocked / reverted exit needs a trajectory too, not just a clean fix.

Detection is tool-based, ORDERED, and STRUCTURAL - it inspects real tool_use
events and their FIELDS (the Skill `skill` field; an actual `gh pr merge` at a
command boundary; the MCP merge/notion tools), NOT substrings of the input. That
matters: naming a loop skill inside ANOTHER skill's args, or writing "gh pr
merge" as data in a printf/grep, must NOT count (that false-fired once during
the hook's own build). Fails SAFE (no nudge) on any parse problem: a missed
reminder beats a spurious block.

Input: Stop-hook JSON on stdin ({transcript_path, stop_hook_active, ...}).
Output: {"decision":"block","reason":...} when it fires; nothing otherwise.
"""
import sys, json, re

LOOP_SKILLS = ("feedback-fix-loop", "parity-builder")  # add your project's loop skills here
# `gh pr merge` only at a command boundary (start / ; / && / | / newline) - so a
# printf/echo/grep that merely CONTAINS the string as data does not match.
GH_MERGE = re.compile(r"(?:^|[;&|]|\n)\s*gh\s+pr\s+merge\b")
# A loop EXIT that is not a clean fix but still must leave a trajectory: an honest
# downgrade (unverified-reasoned / speculative) or a Won't-Fix close. The store was
# ~100% 'fixed' (survivorship bias) because only clean closes got recorded; a
# downgraded / blocked exit is the entry most worth keeping, so it needs one too.
EXIT_DISPOSITION = re.compile(r"unverified[- ]?reasoned|speculative|won'?t fix", re.I)


def walk_tool_uses(obj, out):
    """Recursively collect {type:'tool_use'} events as (name, input_obj)."""
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


def is_loop(name, inp):
    # Real Skill invocation of a loop skill - match the `skill` FIELD, not a
    # substring of the whole input.
    return name == "Skill" and sget(inp, "skill") in LOOP_SKILLS


def is_closeout(name, inp):
    n = name.lower()
    if "merge_pull_request" in n:
        return True
    if name == "Bash" and GH_MERGE.search(str(sget(inp, "command") or "")):
        return True
    if "notion-update-page" in n:
        s = inp if isinstance(inp, str) else json.dumps(inp)
        return ("Pending Retest" in s) or ("Verified" in s) or bool(EXIT_DISPOSITION.search(s))
    if name == "Skill" and sget(inp, "skill") == "deploy-verify":
        return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if data.get("stop_hook_active"):
        return  # already nudged this stop-cycle; never loop
    tp = data.get("transcript_path")
    if not tp:
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

    loop_seen = False
    last_closeout = -1
    last_append = -1
    for i, (name, inp) in enumerate(seq):
        if is_loop(name, inp):
            loop_seen = True
        if is_closeout(name, inp):
            last_closeout = i
        if "append_trajectory" in name.lower():
            last_append = i

    if not (loop_seen and last_closeout >= 0 and last_append < last_closeout):
        return

    reason = (
        "A fix/build loop ran and reached an exit (close-out: PR merge / deploy-verify "
        "/ ticket moved to Pending Retest / Verified, OR a downgrade / Won't-Fix), but no "
        "trajectory-kb entry was recorded afterward. Per feedback-fix-loop step 10, call "
        "mcp__trajectory-kb__append_trajectory({repo, surface, symptom, root_cause, "
        "outcome, what_worked, what_failed, files}) now with the HONEST outcome - 'fixed' "
        "for a clean fix, or 'unverified-reasoned' / 'speculative' / 'reverted' for a "
        "downgraded, blocked, or backed-out exit (put the dead-end / blocker in "
        "what_failed; those failure entries are what stop the next loop hitting the same "
        "wall) - OR briefly state why it does not apply (e.g. the loop is genuinely "
        "mid-flight and paused, not exited). Then stop."
    )
    print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    main()
