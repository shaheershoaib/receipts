#!/usr/bin/env python3
"""Tests for the Stop-hook backstops (Phase 0 self-verification).

Zero-dependency (stdlib unittest), and hermetic: each run uses an isolated $HOME so a
developer's real ~/.claude/receipts.config.json never leaks in. Drives the real hook
scripts over a constructed transcript via stdin - the exact contract Claude Code invokes -
rather than importing the (hyphen-named) modules.

Focus: finding #3 - the "claimed fixed" / close-out detection must be tracker-AGNOSTIC
(Notion, Linear, Jira, GitHub), not Notion-only, without over-firing on non-closeouts.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, "..", "stop-verification-gate.py")
REMINDER = os.path.join(HERE, "..", "stop-trajectory-reminder.py")


def tu(name, **inp):
    """A tool_use transcript event."""
    return {"type": "tool_use", "name": name, "input": inp}


def run_hook(script, events):
    """Write events as a transcript, run the hook with an isolated HOME, and return the
    parsed decision dict (or None if the hook stayed silent)."""
    with tempfile.TemporaryDirectory() as td:
        tp = os.path.join(td, "transcript.jsonl")
        with open(tp, "w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")
        home = os.path.join(td, "home")
        os.makedirs(home)  # empty -> no ~/.claude/receipts.config.json -> generic defaults
        stdin = json.dumps({"transcript_path": tp, "cwd": td, "stop_hook_active": False})
        env = dict(os.environ, HOME=home)
        p = subprocess.run([sys.executable, script], input=stdin,
                           capture_output=True, text=True, env=env)
        out = p.stdout.strip()
        assert p.returncode == 0, f"hook crashed: {p.stderr}"
        return json.loads(out) if out else None


NAV = tu("mcp__chrome__navigate", url="https://acme-staging.vercel.app/checkout")
SHOT = tu("mcp__chrome__screenshot")
MERGE = tu("mcp__github__merge_pull_request", pull_number=1)


class GateClassDetection(unittest.TestCase):
    """The gate blocks an unverified close-out across trackers (was Notion-only)."""

    def _blocks(self, events):
        d = run_hook(GATE, events)
        self.assertIsNotNone(d, "expected a block decision, hook was silent")
        self.assertEqual(d.get("decision"), "block")

    def _silent(self, events):
        self.assertIsNone(run_hook(GATE, events), "expected no block, hook fired")

    def test_notion_closeout_still_detected(self):
        self._blocks([tu("mcp__notion__notion-update-page", properties={"Status": "Verified"})])

    def test_linear_done_now_detected(self):
        self._blocks([tu("mcp__linear__update_issue", state="Done")])

    def test_jira_transition_to_resolved_detected(self):
        self._blocks([tu("mcp__jira__transition_issue", status="Resolved")])

    def test_github_gh_issue_close_detected(self):
        self._blocks([tu("Bash", command="gh issue close 42 -c 'fixed'")])

    def test_close_issue_tool_detected(self):
        self._blocks([tu("mcp__github__close_issue", issue_number=42)])

    def test_priority_update_is_not_a_closeout(self):
        # over-fire guard: changing priority is a tracker write but NOT a fixed close-out
        self._silent([tu("mcp__linear__update_issue", priority="high")])

    def test_verified_closeout_does_not_block(self):
        # binding (navigate to staging) + observation (screenshot) after the merge => allowed
        self._silent([MERGE, NAV, SHOT, tu("mcp__linear__update_issue", state="Done")])

    def test_honest_downgrade_does_not_block(self):
        self._silent([tu("mcp__linear__update_issue", state="Done",
                         comment="unverified-reasoned: cannot observe in CI")])


class ReminderClassDetection(unittest.TestCase):
    """The trajectory nudge also fires across trackers when a loop closed without a record."""

    def test_linear_closeout_after_loop_nudges(self):
        d = run_hook(REMINDER, [tu("Skill", skill="gates"),
                                tu("mcp__linear__update_issue", state="Done")])
        self.assertIsNotNone(d, "expected a trajectory nudge")
        self.assertEqual(d.get("decision"), "block")

    def test_no_loop_no_nudge(self):
        # a close-out with no loop skill run this session => nothing to record, stay silent
        self.assertIsNone(run_hook(REMINDER, [tu("mcp__linear__update_issue", state="Done")]))


if __name__ == "__main__":
    unittest.main()
