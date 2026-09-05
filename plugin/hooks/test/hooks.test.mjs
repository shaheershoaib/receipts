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

// Enforcement is OPT-IN: the gate acts only where a receipts.config.json exists (project walk-up
// or agent-home), so the driver writes a minimal project config by default and the fixtures
// exercise exactly what a configured repo gets (generic defaults, nothing tuned). Pass
// `projectConfig: null` for the zero-config case, `homeConfig` for the agent-home layer.
function runHook(events, { projectConfig = { version: 1 }, homeConfig } = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-hook-"));
  const tp = path.join(td, "transcript.jsonl");
  fs.writeFileSync(tp, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true });
  if (projectConfig) fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify(projectConfig));
  if (homeConfig) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "receipts.config.json"), JSON.stringify(homeConfig));
  }
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

// A live receipt as `receipts observe` emits it.
const liveReceipt = (over = {}) => ({
  schema: "receipts/live-receipt@1",
  probe: { kind: "cmd", spec: "curl -fsS https://acme-staging.vercel.app/api/orders/42" },
  expect: "\"status\":\\s*\"paid\"",
  observed: '{"status":"paid"}',
  met: true,
  artifact: { kind: "deploy-sha", id: "4e3c1a9", source: "gh api ...deployments" },
  generated_at: "2026-07-01T00:00:00.000Z",
  ...over,
});
// The REAL shape the marker lands in: `receipts observe`'s stdout captured into a Bash
// tool_result's text, then JSON-stringified into the JSONL line (so the marker's own JSON is
// escaped in the raw line). This is the extraction the hook must survive.
const liveResult = (over = {}) => ({
  type: "user",
  message: { role: "user", content: [ { type: "tool_result", tool_use_id: "toolu_obs",
    content: [ { type: "text", text: "LIVE-RECEIPT: " + JSON.stringify(liveReceipt(over)) + "\n" } ] } ] },
});

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

// ------------------------------------------------------ opt-in: the gate needs a config

test("zero-config (no receipts.config.json anywhere): an unverified close-out is NOT blocked", () => {
  // Installing the plugin must change nothing in a repo that never opted in - the rule the
  // SessionStart memory hook already follows. Before this, a fresh install blocked `gh issue
  // close` in every library repo on the machine for lacking deployed-build evidence.
  silent([MERGE, tu("mcp__linear__update_issue", { state: "Done" })], { projectConfig: null });
});

test("an agent-home config alone turns the gate on for every repo (the split topology)", () => {
  blocks([MERGE, tu("mcp__linear__update_issue", { state: "Done" })],
    { projectConfig: null, homeConfig: { version: 1 } });
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
  fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify({ version: 1 })); // opted in
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ transcript_path: tp, cwd: td, stop_hook_active: true }),
    encoding: "utf8",
    env: { ...process.env, HOME: td, USERPROFILE: td },
  }).trim();
  assert.equal(out, "");
});

// ---------------------------------------------- anchored statuses: value decoration

test("an emoji/symbol-decorated status value is still a close-out (prefix tolerance)", () => {
  // Some trackers render the status pill INTO the value ("[x] Pending Retest",
  // "🔁 Pending Retest"). A non-word prefix must not defeat detection.
  blocks([tu("mcp__notion__notion-update-page", {
    properties: { Status: { select: { name: "🔁 Pending Retest" } } },
  })]);
});

test("a status value carrying a trailing note is still a close-out (suffix tolerance)", () => {
  blocks([tu("mcp__linear__update_issue", { state: "Pending Retest - awaiting tester" })]);
});

test("a WORD-prefixed value stays excluded (prose is not a status)", () => {
  silent([tu("mcp__notion__notion-update-page", {
    properties: { "Resolution Note": "will move to Pending Retest after the tester run" },
  })]);
});

// ------------------------------- trajectory exit tags: hyphen/space tolerance

test("exit-tag variants ('unverified reasoned', \"won't  fix\") still nudge the trajectory append", () => {
  const spaced = blocks([
    tu("Skill", { skill: "gates" }),
    tu("mcp__linear__update_issue", { comment: "closing: unverified reasoned, cannot drive the UI here" }),
  ]);
  assert.match(spaced.reason, /append_trajectory/, "space variant of a downgrade tag counts as a loop exit");
  const wontFix = blocks([
    tu("Skill", { skill: "gates" }),
    tu("mcp__linear__update_issue", { comment: "closing as won't  fix per triage" }),
  ]);
  assert.match(wontFix.reason, /append_trajectory/, "whitespace-run in won't fix still counts");
});

// -------------------------------------------------- live receipts (Phase 2 evidence)

test("a met:true, build-bound live receipt in the window satisfies binding+observation (silent)", () => {
  // The marker is embedded in a realistic JSONL-stringified Bash tool_result - the hook must
  // extract it from there, not from a tool_use.
  silent([MERGE, liveResult(), tu("mcp__linear__update_issue", { state: "Done" })]);
});

test("a met:FALSE live receipt is a FAILED observation -> block with the precise message", () => {
  const d = blocks([MERGE, liveResult({ met: false }), tu("mcp__linear__update_issue", { state: "Done" })]);
  assert.match(d.reason, /FAILED observation/, "the block names it a failed observation, not 'no evidence'");
  assert.match(d.reason, /not gone/i);
});

test("a live receipt with artifact.kind 'none' does NOT satisfy the binding (block)", () => {
  // met:true but unbound - it cannot prove it ran against the build that carries the commit (G3).
  const d = blocks([MERGE, liveResult({ artifact: { kind: "none", id: null, source: null } }),
    tu("mcp__linear__update_issue", { state: "Done" })]);
  assert.equal(d.decision, "block");
});

test("a live receipt BEFORE the shipping merge is out of window (block)", () => {
  const d = blocks([liveResult(), MERGE, tu("mcp__linear__update_issue", { state: "Done" })]);
  assert.equal(d.decision, "block");
});

test("STRICT mode (agent.evidence: live-receipt): heuristic navigate+screenshot no longer satisfies", () => {
  const d = blocks(
    [MERGE, NAV, SHOT, tu("mcp__linear__update_issue", { state: "Done" })],
    { projectConfig: { version: 1, agent: { evidence: "live-receipt" } } },
  );
  assert.match(d.reason, /receipts observe/, "the block tells the agent the exact command to run");
  assert.match(d.reason, /machine-validated/i);
});

test("STRICT mode: a valid live receipt satisfies the gate (silent)", () => {
  silent(
    [MERGE, liveResult(), tu("mcp__linear__update_issue", { state: "Done" })],
    { projectConfig: { version: 1, agent: { evidence: "live-receipt" } } },
  );
});

test("STRICT mode: a met:false live receipt blocks with the failed-probe message", () => {
  const d = blocks(
    [MERGE, liveResult({ met: false }), tu("mcp__linear__update_issue", { state: "Done" })],
    { projectConfig: { version: 1, agent: { evidence: "live-receipt" } } },
  );
  assert.match(d.reason, /met:false|NOT gone/i);
});

test("default mode is unchanged: heuristic navigate+screenshot still satisfies with no live receipt", () => {
  // Backward-compat guard: the Phase-1 behavior (already covered above) must not regress when the
  // new evidence path exists but no live receipt and no strict config are present.
  silent([MERGE, NAV, SHOT, tu("mcp__linear__update_issue", { state: "Done" })]);
});

test("a live receipt embedded in a JSONL-stringified tool_result is detected (marker extraction)", () => {
  // Explicitly assert the extraction survives the double-encoding: build the entry, round-trip it
  // through JSON (as the JSONL file does), and confirm the escaped marker still clears the gate.
  const entry = liveResult();
  const roundTripped = JSON.parse(JSON.stringify(entry)); // exactly what readFileSync->JSON.parse yields
  silent([MERGE, roundTripped, tu("mcp__linear__update_issue", { state: "Done" })]);
});

// ---------------------------------------------- #74: close-outs the matchers did not see

const CLOSE_LINEAR = tu("mcp__linear__update_issue", { state: "Done" });

test("#74: GitHub MCP issue_write with state closed is a close-out (noun-then-verb tool name)", () => {
  // TRACKER_WRITE read verb-then-noun (update_issue, close_issue); the current GitHub MCP exposes
  // issue_write, so its closes were invisible while `gh issue close` in Bash was caught.
  blocks([MERGE, tu("mcp__github__issue_write", { method: "update", owner: "o", repo: "r", issue_number: 12, state: "closed", state_reason: "completed" })]);
});

test("#74: an issue_write that only retitles is not a close-out (allow)", () => {
  silent([MERGE, tu("mcp__github__issue_write", { method: "update", issue_number: 12, title: "clearer title" })]);
});

test("#74: gh global flags before the subcommand are still a close-out (block)", () => {
  // Every real `gh issue close` in one machine's transcripts put --repo/-R first.
  blocks([MERGE, tu("Bash", { command: "gh -R o/r issue close 12" })]);
  blocks([MERGE, tu("Bash", { command: "GH_TOKEN=x gh --repo o/r issue close 12 -c 'fixed'" })]);
});

test("#74: a flag-first `gh -R o/r pr merge` is the merge that moves the evidence window (block)", () => {
  // Evidence gathered BEFORE the shipping merge is out of window; a merge the regex could not see
  // let stale evidence count for the close-out.
  blocks([NAV, SHOT, tu("Bash", { command: "gh -R o/r pr merge 7 --squash" }), CLOSE_LINEAR]);
});

// ------------------------------------- #74: what counts as the DEPLOYED build (binding)

test("#74: a LOCAL preview plus a DOM read is not deployed-build evidence (block)", () => {
  // Any tool name containing `preview_` bound the gate, so a dev server on localhost read as the
  // deployed build - the opposite of what G3 asks.
  const d = blocks([MERGE, tu("mcp__Claude_Browser__preview_start", { url: "http://localhost:3000" }),
    tu("mcp__Claude_Browser__read_page", {}), tu("Bash", { command: "gh issue close 12" })]);
  assert.match(d.reason, /DEPLOYED/);
});

test("#74: a preview whose URL is a deployed host still binds (allow)", () => {
  silent([MERGE, tu("mcp__vercel__preview_open", { url: "https://app-git-fix-12.vercel.app" }),
    tu("mcp__Claude_Browser__read_page", {}), CLOSE_LINEAR]);
});

test("#74: a bare DB query is an observation, not a deploy binding (block)", () => {
  // mysql_query alone, or psql against $DATABASE_URL, satisfied BOTH halves of the gate - while the
  // block message itself asks a data ticket for the query AND a sha-confirm. A local dev database
  // is the common target of a bare query.
  blocks([MERGE, tu("mcp__mysql__mysql_query", { sql: "select status from orders where id=42" }), tu("Bash", { command: "gh issue close 12" })]);
  blocks([MERGE, tu("Bash", { command: "psql $DATABASE_URL -tAc 'select status from orders where id=42'" }), CLOSE_LINEAR]);
});

test("#74: a query that names a STAGING host binds and observes: STAGING_DB_URL, a db proxy, or a configured pattern (allow)", () => {
  silent([MERGE, tu("Bash", { command: "psql $STAGING_DB_URL -tAc 'select status from orders where id=42'" }), CLOSE_LINEAR]);
  silent([MERGE, tu("Bash", { command: "mysql -h proxy.rlwy.net -e 'select 1'" }), CLOSE_LINEAR],
    { projectConfig: { version: 1, agent: { staging_query_patterns: ["proxy.rlwy.net"] } } });
});

test("#74: a DB observation plus a get_deployment binding satisfies the gate (the message's option b)", () => {
  silent([MERGE, tu("mcp__vercel__get_deployment", { id: "dpl_1" }), tu("mcp__mysql__mysql_query", { sql: "select 1" }), CLOSE_LINEAR]);
});
