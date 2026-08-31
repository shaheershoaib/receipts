"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/*
 * Version stamping + the upgrade path. Before this, a config carried no record of which
 * version wrote it, so `doctor` had to infer staleness from which fields happened to be
 * missing - a rule needing a rewrite for every new field - and nothing told a user after an
 * update that their per-repo configs might now be behind. The update step existed only as a
 * sentence in a skill someone had to remember to trigger.
 */

const ROOT = path.join(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "receipts.js");
const HOOK = path.join(ROOT, "plugin", "hooks", "session-memory.mjs");
const OWN = require(path.join(ROOT, "package.json")).version;

function project(extraFiles) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-upg-"));
  fs.writeFileSync(path.join(td, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" } }));
  for (const [n, b] of Object.entries(extraFiles || {})) fs.writeFileSync(path.join(td, n), b);
  return td;
}
const runInit = (dir, args = []) =>
  spawnSync("node", [CLI, "init", "--yes", "--no-scaffold", "--dir", dir, ...args], { encoding: "utf8" });
const runDoctor = (dir) => spawnSync("node", [CLI, "doctor", "--dir", dir], { encoding: "utf8" });
function runSession(dir) {
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ session_id: "s", cwd: dir, source: "startup" }),
    encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : null;
}

test("init stamps the version that wrote the config", () => {
  const d = project();
  runInit(d, ["--drive-auth", "none needed"]);
  const cfg = JSON.parse(fs.readFileSync(path.join(d, "receipts.config.json"), "utf8"));
  assert.equal(cfg.agent.receipts_version, OWN);
});

test("SessionStart announces a version mismatch and names doctor", () => {
  const d = project();
  fs.writeFileSync(path.join(d, "receipts.config.json"),
    JSON.stringify({ version: 1, agent: { receipts_version: "0.0.1", drive: { confirmed: true } } }));
  const ctx = runSession(d);
  assert.ok(ctx, "a stale config must not pass silently");
  assert.match(ctx, /written by version 0\.0\.1/);
  assert.match(ctx, /receipts doctor/);
  assert.match(ctx, /tell the user/, "the agent must surface it, not just read it");
});

test("SessionStart is silent when the versions match", () => {
  const d = project();
  const running = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;
  fs.writeFileSync(path.join(d, "receipts.config.json"),
    JSON.stringify({ version: 1, agent: { receipts_version: running, drive: { confirmed: true } } }));
  assert.equal(runSession(d), null, "a current project must not pay for the upgrade check");
});

test("SessionStart flags a config that records no version at all", () => {
  const d = project();
  fs.writeFileSync(path.join(d, "receipts.config.json"),
    JSON.stringify({ version: 1, agent: { drive: { confirmed: true } } }));
  assert.match(runSession(d), /does not record which version wrote it/);
});

test("doctor reports the mismatch directly, not by guessing at fields", () => {
  const d = project();
  fs.writeFileSync(path.join(d, "receipts.config.json"), JSON.stringify({
    version: 1, build: { sha_source: "none", platform: "none" },
    verify: { test_command: "npm test -- {test}" },
    agent: { receipts_version: "0.0.1", drive: { confirmed: true, auth: "", bypass: "", data: "", browser_surfaces: [] } },
  }));
  const r = runDoctor(d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /written by receipts 0\.0\.1/);
  assert.match(r.stderr, new RegExp(`running ${OWN.replace(/\./g, "\\.")}`));
});

test("a freshly-initialised project is clean end to end", () => {
  const d = project();
  runInit(d, ["--drive-auth", "none needed", "--drive-data", "realistic"]);
  assert.equal(runDoctor(d).status, 0, "init then doctor must be clean");
  // It DOES inject the recorded drive facts - that is the point of recording them. What a
  // current project must not get is the upgrade nag.
  const ctx = runSession(d) || "";
  assert.doesNotMatch(ctx, /written by version|does not record which version/,
    "a project initialised by THIS version must not be told it is out of date");
  assert.match(ctx, /auth route: none needed/, "the recorded answers still reach the session");
});

// ---- AGENTS.md ---------------------------------------------------------------------------

test("init writes AGENTS.md so a non-Claude agent gets the same discipline", () => {
  const d = project();
  runInit(d, ["--drive-auth", "none needed"]);
  const md = fs.readFileSync(path.join(d, "AGENTS.md"), "utf8");
  assert.match(md, /BEGIN receipts gates/);
  assert.match(md, /END receipts gates/);
  assert.match(md, /RECEIPT/i, "the adapter body must actually be in there");
});

test("an existing AGENTS.md is APPENDED to, never clobbered", () => {
  const d = project({ "AGENTS.md": "# House rules\n\nAlways rebase.\n" });
  runInit(d, ["--drive-auth", "none needed"]);
  const md = fs.readFileSync(path.join(d, "AGENTS.md"), "utf8");
  assert.match(md, /# House rules/, "the user's own content must survive");
  assert.match(md, /Always rebase\./);
  assert.match(md, /BEGIN receipts gates/);
});

test("re-running init REPLACES the block rather than stacking duplicates", () => {
  const d = project({ "AGENTS.md": "# House rules\n" });
  runInit(d, ["--drive-auth", "none needed"]);
  runInit(d, ["--force", "--drive-auth", "none needed"]);
  const md = fs.readFileSync(path.join(d, "AGENTS.md"), "utf8");
  assert.equal((md.match(/BEGIN receipts gates/g) || []).length, 1, "the block must not accumulate");
  assert.match(md, /# House rules/);
});

test("--no-agents opts out", () => {
  const d = project();
  runInit(d, ["--no-agents", "--drive-auth", "none needed"]);
  assert.ok(!fs.existsSync(path.join(d, "AGENTS.md")));
});

test("the adapter ships to npm, or init cannot write it", () => {
  const files = require(path.join(ROOT, "package.json")).files;
  assert.ok(files.some((f) => f === "adapters/AGENTS.md" || f === "adapters"),
    "adapters/AGENTS.md must be in package.json files - init reads it from the installed package");
});
