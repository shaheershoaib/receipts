"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/*
 * The interview is the observation contract, reasoned by the agent (docs/superpowers/specs/
 * 2026-09-09-observation-contract-interview-design.md). `init --agent` hands detection + the
 * medium's contract drafts + the residue to an agent as JSON and writes nothing; `--answers`
 * carries the agent-composed answers back; the guard and doctor speak the DETECTED medium's
 * residue, not the web row's. Before this, a CLI tool was asked about signed-in states.
 */
const ROOT = path.join(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "receipts.js");
const media = require(path.join(ROOT, "spec", "media.json"));

const FIX = {
  cli: { "package.json": JSON.stringify({ name: "mytool", bin: { mytool: "bin/x.js" }, scripts: { test: "jest" } }) },
  web: { "package.json": JSON.stringify({ name: "app", dependencies: { react: "18" }, scripts: { test: "jest" } }), "vercel.json": "{}" },
  infra: { "main.tf": 'resource "x" "y" {}' },
};
function fixture(kind) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-agent-" + kind + "-"));
  for (const [f, body] of Object.entries(FIX[kind])) fs.writeFileSync(path.join(td, f), body);
  return td;
}
function run(args, td, stdin = "ignore") {
  const r = spawnSync("node", [CLI, ...args, "--dir", td], { encoding: "utf8", stdio: [stdin, "pipe", "pipe"] });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

test("init --agent prints detection, the medium's contract drafts and its residue as JSON, and writes nothing", () => {
  const td = fixture("cli");
  const r = run(["init", "--agent"], td);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.medium, "cli");
  assert.equal(j.draft.agent.observe.surface, media.media.cli.row.surface, "contract drafts come from the medium row");
  assert.equal(j.draft.agent.observe.confirmed, false, "a draft nobody confirmed says so");
  assert.equal(j.draft.gates.medium, "cli");
  const access = j.residue.find((q) => q.key === "access").question;
  assert.match(access, /installed and invoked/, "a CLI tool is asked how it is invoked, not about a signed-in state");
  assert.doesNotMatch(access, /signed-in/);
  assert.equal(j.contract.length, 9);
  assert.match(j.write, /--answers/);
  assert.equal(fs.existsSync(path.join(td, "receipts.config.json")), false);
});

test("a runner-less repo with a DETECTED medium is a project, not the agent home: the draft keeps observe and gates", () => {
  // Before: any directory with no test runner and no deploy platform was treated as the
  // agent home and lost build/verify/gates - and with them the observe block - which is
  // exactly wrong for a Terraform repo, a data pipeline, or a CLI without a runner.
  const j = JSON.parse(run(["init", "--agent"], fixture("infra")).out);
  assert.equal(j.medium, "infra");
  assert.ok(j.draft.agent.observe, "the observe block must be drafted for a detected medium");
  assert.equal(j.draft.agent.observe.surface, media.media.infra.row.surface);
  assert.equal(j.draft.gates.medium, "infra", "gates.medium must survive for a runner-less project");
  assert.ok(j.draft.verify, "verify stays (with the receipt-cmd placeholder) so doctor can ask for it");
});

test("init --agent on a web project asks the web residue", () => {
  const j = JSON.parse(run(["init", "--agent"], fixture("web")).out);
  assert.equal(j.medium, "web");
  assert.match(j.residue.find((q) => q.key === "access").question, /signed-in state/);
  assert.ok(j.residue.some((q) => q.key === "environment"), "a deployed platform adds the environment question");
});

test("--answers merges the agent's answers over detection and marks the block confirmed", () => {
  const td = fixture("cli");
  const answers = path.join(td, "answers.json");
  fs.writeFileSync(answers, JSON.stringify({
    gates: { medium: "cli" },
    agent: { observe: { twin: "none", reach: { access: "npx mytool from any directory", shortcut: "--yes", fixtures: "any directory", special_surfaces: ["interactive prompts"] } } },
  }));
  const r = run(["init", "--yes", "--no-agents", "--answers", answers], td);
  assert.equal(r.code, 0, r.err);
  const cfg = JSON.parse(fs.readFileSync(path.join(td, "receipts.config.json"), "utf8"));
  assert.equal(cfg.agent.observe.confirmed, true, "answers ARE the interview");
  assert.equal(cfg.agent.observe.reach.access, "npx mytool from any directory");
  assert.deepEqual(cfg.agent.observe.reach.special_surfaces, ["interactive prompts"]);
  assert.equal(cfg.agent.observe.twin, "none");
  assert.equal(cfg.agent.observe.surface, media.media.cli.row.surface, "unanswered contract fields keep the row draft");
  assert.equal(cfg.agent.drive, undefined, "the old block is not written any more");
  assert.equal(cfg.agent.observe.reach.shortcut, "--yes");
});

test("--drive-* still relay, into observe.reach, with a deprecation warning", () => {
  const td = fixture("web");
  const r = run(["init", "--yes", "--no-agents", "--drive-auth", "qa@x.test", "--drive-browser-surfaces", "PDF"], td);
  assert.equal(r.code, 0, r.err);
  const cfg = JSON.parse(fs.readFileSync(path.join(td, "receipts.config.json"), "utf8"));
  assert.equal(cfg.agent.observe.confirmed, true);
  assert.equal(cfg.agent.observe.reach.access, "qa@x.test");
  assert.deepEqual(cfg.agent.observe.reach.special_surfaces, ["PDF"]);
  assert.match(r.err, /deprecated/);
});

test("the no-terminal guard prints the DETECTED medium's residue", () => {
  const infra = run(["init"], fixture("infra"));
  assert.equal(infra.code, 2);
  assert.match(infra.err, /plan/i, "a Terraform repo is asked where it can plan safely");
  assert.doesNotMatch(infra.err, /signed-in state/);
  assert.match(infra.err, /--answers/);
  const web = run(["init"], fixture("web"));
  assert.match(web.err, /signed-in state/);
});

test("doctor migrates agent.drive into agent.observe, backing the file up first", () => {
  const td = fixture("web");
  const p = path.join(td, "receipts.config.json");
  const own = require(path.join(ROOT, "package.json")).version;
  fs.writeFileSync(p, JSON.stringify({ version: 1, claim: {}, build: {}, verify: { test_command: "jest {test}" }, gates: { medium: "web" },
    agent: { loop_skills: ["gates"], receipts_version: own, drive: { confirmed: true, auth: "qa@x.test", bypass: "OTP 000000", data: "realistic", browser_surfaces: ["PDF"] } } }, null, 2));
  const r = spawnSync("node", [CLI, "doctor", "--dir", td], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.match(out, /migrat/i);
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(cfg.agent.drive, undefined);
  assert.equal(cfg.agent.observe.confirmed, true);
  assert.equal(cfg.agent.observe.reach.access, "qa@x.test");
  assert.deepEqual(cfg.agent.observe.reach.special_surfaces, ["PDF"]);
  assert.equal(cfg.agent.observe.surface, media.media.web.row.surface);
  assert.ok(fs.readdirSync(td).some((f) => f.startsWith("receipts.config.json.bak")), "a backup is written before rewriting");
});
