import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * agent.drive was WRITE-ONLY: `receipts init` interviewed a human for the reachability
 * facts and nothing ever read them back, so escape hatch (d) ("I could not observe it")
 * stayed available on auth grounds even when the config recorded exactly how to get in -
 * and an empty block written by `--yes` was indistinguishable from a human confirming
 * "nothing needed". These assert the gate now cites both.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
// From the manifest, not a literal - a hardcoded version breaks on every bump.
const PLUGIN_VERSION = JSON.parse(fs.readFileSync(
  path.join(HERE, "..", "..", ".claude-plugin", "plugin.json"), "utf8")).version;
const HOOK = path.join(HERE, "..", "stop-gates.mjs");
const tu = (name, inp = {}) => ({ type: "tool_use", name, input: inp });

function runHook(events, projectConfig) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-drive-"));
  const tp = path.join(td, "transcript.jsonl");
  fs.writeFileSync(tp, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true });
  if (projectConfig) fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify(projectConfig));
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ transcript_path: tp, cwd: td, stop_hook_active: false }),
    encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
  }).trim();
  return out ? JSON.parse(out) : null;
}

// An unverified close-out: a ticket moved to a fixed status with no observation.
const CLOSEOUT = [tu("mcp__notion__notion-update-page", {
  properties: { Status: { select: { name: "Pending Retest" } } },
})];

test("a RECORDED auth route makes 'auth-walled' unavailable as escape hatch (d)", () => {
  const d = runHook(CLOSEOUT, {
    version: 1,
    agent: { drive: { confirmed: true, auth: "seeded test account qa@acme.test", bypass: "OTP 000000" } },
  });
  assert.ok(d && d.decision === "block", "the close-out must still block");
  assert.match(d.reason, /recorded way in/, "the gate must cite that a route exists");
  assert.match(d.reason, /qa@acme\.test/, "it must name the actual auth route from the config");
  assert.match(d.reason, /OTP 000000/, "and the dev shortcut");
  assert.match(d.reason, /NOT available as reason \(d\)/, "and refuse the auth-walled excuse");
});

test("an UNCONFIRMED (--yes) drive block is an open question, not proof of unreachability", () => {
  const d = runHook(CLOSEOUT, {
    version: 1,
    agent: { drive: { confirmed: false, auth: "", bypass: "", data: "", browser_surfaces: [] } },
  });
  assert.ok(d && d.decision === "block");
  assert.match(d.reason, /nobody has recorded how to reach a signed-in state/);
  assert.match(d.reason, /open question, not evidence/);
});

test("a CONFIRMED-empty drive block stays silent (a human said nothing was needed)", () => {
  const d = runHook(CLOSEOUT, {
    version: 1,
    agent: { drive: { confirmed: true, auth: "", bypass: "", data: "", browser_surfaces: [] } },
  });
  assert.ok(d && d.decision === "block", "still blocks on the missing observation");
  assert.doesNotMatch(d.reason, /nobody has recorded/, "but must NOT nag about reachability");
  assert.doesNotMatch(d.reason, /recorded way in/);
});

test("no drive block at all (pre-existing configs) changes nothing", () => {
  const d = runHook(CLOSEOUT, { version: 1, agent: {} });
  assert.ok(d && d.decision === "block");
  assert.doesNotMatch(d.reason, /recorded way in|nobody has recorded/);
});

// ---- SessionStart: the answers must reach the agent's context every session ----------------

const SESSION_HOOK = path.join(HERE, "..", "session-memory.mjs");

function runSession(projectConfig) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-sess-"));
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true });
  if (projectConfig) fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify(projectConfig));
  const out = execFileSync("node", [SESSION_HOOK], {
    input: JSON.stringify({ session_id: "s1", cwd: td, source: "startup" }),
    encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
  }).trim();
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
}

test("SessionStart injects the recorded way in, with NO trajectory memories present", () => {
  const ctx = runSession({
    version: 1,
    agent: { receipts_version: PLUGIN_VERSION, drive: { confirmed: true, auth: "test acct qa@acme.test", bypass: "OTP 000000", data: "realistic", browser_surfaces: ["invoice PDF"] } },
  });
  assert.ok(ctx, "expected context; a fresh project has no trajectories and must still get this");
  assert.match(ctx, /qa@acme\.test/);
  assert.match(ctx, /OTP 000000/);
  assert.match(ctx, /invoice PDF/);
  assert.match(ctx, /before reporting a surface unreachable/);
});

test("SessionStart flags an unconfirmed drive block so the agent asks", () => {
  const ctx = runSession({ version: 1, agent: { receipts_version: PLUGIN_VERSION, drive: { confirmed: false, auth: "", bypass: "" } } });
  assert.match(ctx, /skipped the reachability interview/);
  assert.match(ctx, /Ask the human/);
});

test("SessionStart stays silent for a confirmed-empty block and for no config", () => {
  assert.equal(runSession({ version: 1, agent: { receipts_version: PLUGIN_VERSION, drive: { confirmed: true, auth: "", bypass: "" } } }), null);
  assert.equal(runSession(null), null);
});
