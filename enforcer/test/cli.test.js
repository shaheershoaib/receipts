"use strict";
/*
 * Engine CLI (Phase 3): `receipts verify` / `replay` / `explain`.
 *
 * `verify` runs the SAME enforcer the CI action runs (no second engine to drift). `replay`
 * re-runs a recorded verification and checks the verdict reproduces. `explain` summarizes a
 * receipt. Driven as a subprocess - the real CLI contract.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cfg, makeRepo, testAsserting, modReturning } = require("./helpers.js");

const BIN = path.join(__dirname, "..", "..", "bin", "receipts.js");
const run = (args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status };
};
const tmpReceipt = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")), "receipt.json");

function fixRepo() {
  return makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
}

test("receipts verify runs the engine and re-proves a receipt", () => {
  const r = fixRepo();
  const out = run(["verify", "--json", "--base", r.base, "--head", r.head, "--repo", r.dir, "--pr-body", "closes #1"]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const v = JSON.parse(out.stdout.trim().split("\n").filter(Boolean).pop());
  assert.match(v.reason, /receipt verified/i);
});

test("receipts verify exits non-zero on a BLOCK", () => {
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2) }, // real change, but no test => no receipt
  });
  const out = run(["verify", "--json", "--base", r.base, "--head", r.head, "--repo", r.dir, "--pr-body", "closes #1"]);
  assert.equal(out.code, 1, "BLOCK must exit 1");
  assert.match(out.stdout, /no receipt/i);
});

test("receipts replay re-runs a receipt and confirms the verdict reproduces", () => {
  const r = fixRepo();
  const out = tmpReceipt();
  run(["verify", "--json", "--base", r.base, "--head", r.head, "--repo", r.dir, "--pr-body", "closes #1", "--receipt-out", out]);
  const rep = run(["replay", out, "--repo", r.dir]);
  assert.equal(rep.code, 0, rep.stdout + rep.stderr);
  assert.match(rep.stdout, /REPRODUCED/);
});

test("receipts replay reconstructs a command receipt and reproduces the verdict", () => {
  // A command-receipt-only PR: red on base (flag BAD), green on head (flag GOOD), no test runner.
  const r = makeRepo({
    baseFiles: { "flag.txt": "BAD\n", "receipts.config.json": cfg({ verify: { test_command: "REPLACE_ME" } }) },
    headFiles: { "flag.txt": "GOOD\n" },
  });
  const cmd = `node -e "process.exit(require('fs').readFileSync('flag.txt','utf8').trim()==='GOOD'?0:1)"`;
  const out = tmpReceipt();
  run(["verify", "--json", "--base", r.base, "--head", r.head, "--repo", r.dir, "--pr-body", `closes #1\nreceipt-cmd: ${cmd}`, "--receipt-out", out]);
  const rep = run(["replay", out, "--repo", r.dir]);
  assert.equal(rep.code, 0, rep.stdout + rep.stderr);
  assert.match(rep.stdout, /REPRODUCED/);
});

test("receipts explain summarizes a receipt artifact", () => {
  const r = fixRepo();
  const out = tmpReceipt();
  run(["verify", "--json", "--base", r.base, "--head", r.head, "--repo", r.dir, "--pr-body", "closes #1", "--receipt-out", out]);
  const ex = run(["explain", out]);
  assert.equal(ex.code, 0, ex.stderr);
  assert.match(ex.stdout, /receipt \(receipts\/receipt@1\)/);
  assert.match(ex.stdout, /red \(reproduced on base\): true/);
  assert.match(ex.stdout, /receipt-green@head|\$ /); // shows the commands run
});

// ── receipts init: the loop-skill scaffold is opt-in ─────────────────────────
// `gates` ships with the plugin and already drives the fix loop. Scaffolding a project twin
// by default duplicated its trigger (both opened "Use when fixing a bug"), so every bug was
// a coin flip between the two; `--yes` now writes no skill unless `--scaffold` asks for one.
function initRepo(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-init-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" } }));
  const r = run(["init", "--yes", "--dir", dir, ...args]);
  assert.equal(r.code, 0, r.stderr);
  return { dir, cfg: JSON.parse(fs.readFileSync(path.join(dir, "receipts.config.json"), "utf8")) };
}

test("init --yes writes NO loop skill by default; gates alone is registered", () => {
  const { dir, cfg } = initRepo([]);
  assert.ok(!fs.existsSync(path.join(dir, ".claude", "skills")), "no .claude/skills entry may appear unasked");
  assert.deepEqual(cfg.agent.loop_skills, ["gates"]);
});

test("init --yes --scaffold writes .claude/skills/<repo>-fix-loop/SKILL.md and registers it", () => {
  const { dir, cfg } = initRepo(["--scaffold"]);
  const skill = path.join(dir, ".claude", "skills", "x-fix-loop", "SKILL.md");
  assert.ok(fs.existsSync(skill), "the scaffold must land at .claude/skills/<repo>-fix-loop/SKILL.md");
  assert.deepEqual(cfg.agent.loop_skills, ["gates", "x-fix-loop"]);
  const md = fs.readFileSync(skill, "utf8");
  assert.doesNotMatch(md, /\{\{/, "every template placeholder must be filled");
  // The description COMPLEMENTS `gates` (the memory touchpoints + this repo's facts) instead
  // of repeating its trigger.
  const desc = md.match(/^description: >-\n([\s\S]*?)\n---/m)[1];
  assert.doesNotMatch(desc, /^\s*Use when fixing a bug/);
  for (const own of [/query_trajectory/, /append_trajectory/, /`gates`/]) assert.match(desc, own);
});

test("--no-scaffold is still accepted and wins over --scaffold", () => {
  const { dir, cfg } = initRepo(["--scaffold", "--no-scaffold"]);
  assert.ok(!fs.existsSync(path.join(dir, ".claude", "skills")));
  assert.deepEqual(cfg.agent.loop_skills, ["gates"]);
});
