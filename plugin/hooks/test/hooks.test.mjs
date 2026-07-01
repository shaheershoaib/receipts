import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Tests for the combined Stop-hook backstop (stop-gates.mjs).
 *
 * Hermetic: each run gets an isolated HOME (no developer ~/.claude/receipts.config.json
 * leaks in) and drives the real script over stdin - the exact contract Claude Code
 * invokes. Ports the python test suite 1:1, plus the regression cases for the anchored
 * status matching (a comment MENTIONING a status is not a close-out) and the combined
 * single-pass output.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "stop-gates.mjs");

const tu = (name, inp = {}) => ({ type: "tool_use", name, input: inp });

function runHook(events, { projectConfig } = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-hook-"));
  const tp = path.join(td, "transcript.jsonl");
  fs.writeFileSync(tp, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true }); // empty -> generic defaults
  if (projectConfig) fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify(projectConfig));
  const stdin = JSON.stringify({ transcript_path: tp, cwd: td, stop_hook_active: false });
  const out = execFileSync("node", [HOOK], {
    input: stdin, encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  }).trim();
  return out ? JSON.parse(out) : null;
}

const NAV = tu("mcp__chrome__navigate", { url: "https://acme-staging.vercel.app/checkout" });
const SHOT = tu("mcp__chrome__screenshot");
const MERGE = tu("mcp__github__merge_pull_request", { pull_number: 1 });

const blocks = (events, opts) => {
  const d = runHook(events, opts);
  assert.ok(d, "expected a block decision, hook was silent");
  assert.equal(d.decision, "block");
  return d;
};
const silent = (events, opts) => assert.equal(runHook(events, opts), null, "expected no block, hook fired");

// --------------------------------------------------- gate: tracker-agnostic close-out

test("notion close-out is detected", () => {
  blocks([tu("mcp__notion__notion-update-page", { properties: { Status: "Verified" } })]);
});

test("linear state=Done is detected", () => {
  blocks([tu("mcp__linear__update_issue", { state: "Done" })]);
});

test("jira transition to Resolved is detected", () => {
  blocks([tu("mcp__jira__transition_issue", { status: "Resolved" })]);
});

test("gh issue close is detected at a command boundary", () => {
  blocks([tu("Bash", { command: "gh issue close 42 -c 'fixed'" })]);
});

test("a close_issue tool is itself the fixed signal", () => {
  blocks([tu("mcp__github__close_issue", { issue_number: 42 })]);
});

test("over-fire guard: a priority update is not a close-out", () => {
  silent([tu("mcp__linear__update_issue", { priority: "high" })]);
});

test("verified close-out (binding + observation after the merge) is allowed", () => {
  silent([MERGE, NAV, SHOT, tu("mcp__linear__update_issue", { state: "Done" })]);
});

test("an honest downgrade is allowed", () => {
  silent([tu("mcp__linear__update_issue", { state: "Done", comment: "unverified-reasoned: cannot observe in CI" })]);
});

// --------------------------------------------- anchored statuses (the regression fix)

test("a comment MENTIONING a fixed status is not a close-out (anchored value match)", () => {
  // The old substring check (`status in serialized_input`) false-fired here: the status
  // appears inside a longer comment string, not as a status VALUE.
  silent([tu("mcp__notion__notion-update-page", {
    properties: { "Resolution Note": "reporter says this moved to Pending Retest earlier, checking" },
  })]);
});

test("a NESTED status value (Notion select shape) is still a close-out", () => {
  blocks([tu("mcp__notion__notion-update-page", {
    properties: { Status: { select: { name: "Pending Retest" } } },
  })]);
});

test("a batched verify (browser_batch navigate + screenshot) counts as binding + observation", () => {
  silent([
    MERGE,
    tu("mcp__chrome__browser_batch", {
      actions: [{ name: "navigate", url: "https://acme-staging.vercel.app/x" }, { name: "screenshot" }],
    }),
    tu("mcp__linear__update_issue", { state: "Done" }),
  ]);
});

test("a library config (sha_source: none) stands the deployed-build gate down", () => {
  silent(
    [tu("mcp__linear__update_issue", { state: "Done" })],
    { projectConfig: { version: 1, build: { sha_source: "none", platform: "none" } } }
  );
});

// ------------------------------------------------------------- trajectory reminder

test("a loop close-out without an append gets the trajectory nudge (combined output)", () => {
  const d = blocks([tu("Skill", { skill: "gates" }), tu("mcp__linear__update_issue", { state: "Done" })]);
  assert.match(d.reason, /append_trajectory/, "the trajectory half fires");
  assert.match(d.reason, /moved to a fixed status/, "the verification half fires too");
  assert.match(d.reason, /--- also ---/, "both reasons carried in ONE decision");
});

test("no loop skill ran => no trajectory nudge (the gate may still fire)", () => {
  const d = blocks([tu("mcp__linear__update_issue", { state: "Done" })]);
  assert.ok(!/append_trajectory/.test(d.reason), "no trajectory text without a loop");
});

test("an append AFTER the close-out satisfies the reminder", () => {
  const d = runHook([
    tu("Skill", { skill: "gates" }),
    MERGE, NAV, SHOT,
    tu("mcp__linear__update_issue", { state: "Done" }),
    tu("mcp__trajectory-kb__append_trajectory", { repo: "x", outcome: "fixed" }),
  ]);
  assert.equal(d, null, "verified + recorded -> fully silent");
});

test("naming a loop skill as ARGS of another skill does not count as running it", () => {
  const d = runHook([
    tu("Skill", { skill: "code-review", args: "use the gates skill please" }),
    MERGE, NAV, SHOT,
    tu("mcp__linear__update_issue", { state: "Done" }),
  ]);
  assert.equal(d, null, "structural field match only - no false loop detection");
});

test("stop_hook_active short-circuits (never loop)", () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-hook-"));
  const tp = path.join(td, "t.jsonl");
  fs.writeFileSync(tp, JSON.stringify(tu("mcp__linear__update_issue", { state: "Done" })) + "\n");
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ transcript_path: tp, cwd: td, stop_hook_active: true }),
    encoding: "utf8",
    env: { ...process.env, HOME: td, USERPROFILE: td },
  }).trim();
  assert.equal(out, "");
});
