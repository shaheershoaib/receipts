"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/*
 * `receipts doctor`. Previously untested, and it reported the agent-home shape that
 * `init` had just written as drift - so `init && doctor` failed on a fresh, correct
 * config. These also cover the two staleness checks INIT.md promises (a vanished test
 * runner, a vanished deploy platform) and the upgrade audit that asks an upgrading user
 * the reachability questions rather than telling them a field is missing.
 */

const CLI = path.join(__dirname, "..", "..", "bin", "receipts.js");

function runDoctor(files, config) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-doctor-"));
  for (const [name, body] of Object.entries(files || {})) {
    const fp = path.join(td, name);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, body);
  }
  if (config) fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify(config, null, 2));
  // doctor reports on STDERR (so --print stays pure JSON elsewhere) - capture both streams.
  const r = spawnSync("node", [CLI, "doctor", "--dir", td], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const PKG_WITH_TEST = JSON.stringify({ name: "x", scripts: { test: "jest" } });
const CONFIRMED = { confirmed: true, auth: "", bypass: "", data: "", browser_surfaces: [] };
// doctor now reports a version mismatch outright; these cases are about config HEALTH,
// so they carry the current stamp and let the dedicated tests cover staleness.
const OWN = require(path.join(__dirname, "..", "..", "package.json")).version;

test("an agent-home config is NOT reported as drift (it has no build/verify by design)", () => {
  const r = runDoctor({}, { version: 1, claim: {}, agent: { loop_skills: ["gates"], drive: CONFIRMED, receipts_version: OWN } });
  assert.equal(r.code, 0, `agent-home must pass clean, got:\n${r.out}`);
  assert.match(r.out, /looks current/);
  assert.match(r.out, /agent-home/);
  assert.doesNotMatch(r.out, /test_command is unset/, "the bug: it demanded a test command from a config that must not have one");
});

test("a healthy code-repo config passes clean", () => {
  const r = runDoctor({ "package.json": PKG_WITH_TEST }, {
    version: 1,
    build: { sha_source: "none", platform: "none" },
    verify: { test_command: "npm test -- {test}" },
    agent: { loop_skills: ["gates"], drive: CONFIRMED, receipts_version: OWN },
    gates: { enabled: "all", disabled: [] },
  });
  assert.equal(r.code, 0, r.out);
});

test("a VANISHED test runner is caught (INIT.md promises this)", () => {
  const r = runDoctor({}, {   // no package.json -> nothing detectable
    version: 1,
    build: { sha_source: "none", platform: "none" },
    verify: { test_command: "npm test -- {test}" },
    agent: { drive: CONFIRMED, receipts_version: OWN },
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /STALE/);
  assert.match(r.out, /no test runner is detectable/);
});

test("a VANISHED deploy platform is caught", () => {
  const r = runDoctor({ "package.json": PKG_WITH_TEST }, {
    version: 1,
    build: { sha_source: "git", platform: "vercel" },   // no vercel.json on disk
    verify: { test_command: "npm test -- {test}" },
    agent: { drive: CONFIRMED, receipts_version: OWN },
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /no deploy config for it is detectable/);
});

test("an upgraded config with no drive block is ASKED the four questions", () => {
  const r = runDoctor({ "package.json": PKG_WITH_TEST }, {
    version: 1,
    build: { sha_source: "none", platform: "none" },
    verify: { test_command: "npm test -- {test}" },
    agent: { loop_skills: ["gates"] },      // pre-drive config
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /NEEDS YOUR ANSWER/);
  assert.match(r.out, /predates the reachability interview/);
  assert.match(r.out, /REACH a signed-in state/);
  assert.match(r.out, /dev-mode shortcut/);
  assert.match(r.out, /realistic data/);
  assert.match(r.out, /BROWSER rather than by API/);
});

test("drive.confirmed=false is reported as an open question, not a confirmed 'none'", () => {
  const r = runDoctor({ "package.json": PKG_WITH_TEST }, {
    version: 1,
    build: { sha_source: "none", platform: "none" },
    verify: { test_command: "npm test -- {test}" },
    agent: { drive: { confirmed: false, auth: "", bypass: "", data: "", browser_surfaces: [] } },
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /skipped the reachability interview/i);
  assert.match(r.out, /OPEN QUESTION/);
});

test("a drive block from a version without `confirmed` is re-confirmed", () => {
  const r = runDoctor({ "package.json": PKG_WITH_TEST }, {
    version: 1,
    build: { sha_source: "none", platform: "none" },
    verify: { test_command: "npm test -- {test}" },
    agent: { drive: { auth: "test acct", bypass: "", data: "", browser_surfaces: [] } },
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /confirmed` is absent/);
});

test("a PINNED gate list is told which shipped gates are not running", () => {
  const r = runDoctor({ "package.json": PKG_WITH_TEST }, {
    version: 1,
    build: { sha_source: "none", platform: "none" },
    verify: { test_command: "npm test -- {test}" },
    agent: { drive: CONFIRMED, receipts_version: OWN },
    gates: { enabled: ["G0", "G1", "G3"], disabled: [] },
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /this version also ships/);
  assert.match(r.out, /G19/, "the newest shipped gate must be named");
  assert.match(r.out, /"enabled": "all"/, "and the self-updating alternative offered");
});

test('gates.enabled "all" is self-updating and never reported', () => {
  const r = runDoctor({ "package.json": PKG_WITH_TEST }, {
    version: 1,
    build: { sha_source: "none", platform: "none" },
    verify: { test_command: "npm test -- {test}" },
    agent: { drive: CONFIRMED, receipts_version: OWN },
    gates: { enabled: "all", disabled: ["G10"] },
  });
  assert.equal(r.code, 0, r.out);
});

test("SHIPPED_GATES has not drifted from the gate headings in GATES.md", () => {
  const gatesMd = fs.readFileSync(path.join(__dirname, "..", "..", "plugin", "skills", "gates", "references", "GATES.md"), "utf8");
  const documented = [...new Set((gatesMd.match(/^#+ *(G\d+)/gm) || []).map((h) => h.match(/G\d+/)[0]))]
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const cli = fs.readFileSync(CLI, "utf8");
  const listed = (cli.match(/const SHIPPED_GATES = \[([\s\S]*?)\];/)[1].match(/G\d+/g) || []);
  assert.deepEqual(listed, documented,
    "bin/receipts.js SHIPPED_GATES must match the gates documented in GATES.md - a new gate was added without updating doctor");
});
