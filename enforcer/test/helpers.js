"use strict";
/*
 * Test harness for the enforcer (Phase 0 self-verification).
 *
 * Zero-dependency, mirroring the enforcer itself: build a throwaway git repo with a
 * real base commit and head commit, then run enforcer/verify.js against it AS A
 * SUBPROCESS and parse its --json verdict. This tests the actual CLI contract (the
 * thing CI and the GitHub Action invoke), not internals.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VERIFY = path.join(__dirname, "..", "verify.js");

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

// Serialize a receipts.config.json. Sensible zero-deploy defaults; override per test.
function cfg(over = {}) {
  const base = {
    version: 1,
    claim: {
      issue_link: "closes #(\\d+)",
      downgrade_tags: ["unverified-reasoned", "speculative", "reverted"],
    },
    build: { sha_source: "none", platform: "none" },
    verify: { test_command: "node {test}" },
    degrade: {},
    gates: { enabled: "all", disabled: [] },
  };
  const merged = { ...base, ...over };
  // shallow-merge the nested blocks a test commonly tweaks
  for (const k of ["claim", "build", "verify", "degrade", "gates"]) {
    if (over[k]) merged[k] = { ...base[k], ...over[k] };
  }
  return JSON.stringify(merged, null, 2) + "\n";
}

/*
 * makeRepo({ baseFiles, headFiles }) -> { dir, base, head }
 * baseFiles is the full tree at the base commit (include receipts.config.json - the
 * enforcer reads config from BASE). headFiles is overlaid on top for the head commit
 * (changed/added files only).
 */
function makeRepo({ baseFiles, headFiles }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-fix-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@receipts.local"]);
  git(dir, ["config", "user.name", "receipts-test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFiles(dir, baseFiles);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFiles(dir, headFiles);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "head"]);
  const head = git(dir, ["rev-parse", "HEAD"]);
  return { dir, base, head };
}

/*
 * makeDivergedRepo: head does NOT descend from base (base moved on after head branched),
 * so `merge-base --is-ancestor base head` is false - the G8 stale-base case.
 *   root -> head (branch)            (the PR's head)
 *   root -> base (main moved ahead)  (the base it will merge into)
 */
function makeDivergedRepo({ rootFiles, headFiles, baseFiles }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-stale-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@receipts.local"]);
  git(dir, ["config", "user.name", "receipts-test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFiles(dir, rootFiles);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "root"]);
  const root = git(dir, ["rev-parse", "HEAD"]);
  // head branch off root
  git(dir, ["checkout", "-q", "-b", "pr"]);
  writeFiles(dir, headFiles);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "head"]);
  const head = git(dir, ["rev-parse", "HEAD"]);
  // base = main moved ahead of root, independent of head
  git(dir, ["checkout", "-q", "main"]);
  writeFiles(dir, baseFiles || { "MOVED.txt": "main advanced\n" });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base advanced"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "pr"]);
  return { dir, base, head, root };
}

function runVerify({ dir, base, head, prBody, config, receiptOut }) {
  const args = [VERIFY, "--json", "--base", base, "--head", head, "--repo", dir];
  if (config) args.push("--config", config);
  if (receiptOut) args.push("--receipt-out", receiptOut);
  if (prBody !== undefined) args.push("--pr-body", prBody);
  let stdout = "", exitCode = 0;
  try {
    stdout = execFileSync("node", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    stdout = (e.stdout || "") + (e.stderr || "");
    exitCode = typeof e.status === "number" ? e.status : 1;
  }
  const line = stdout.trim().split("\n").filter(Boolean).pop() || "{}";
  let parsed;
  try { parsed = JSON.parse(line); }
  catch { parsed = { verdict: "PARSE_ERROR", reason: stdout, warnings: [] }; }
  let receipt = null;
  if (receiptOut) { try { receipt = JSON.parse(fs.readFileSync(receiptOut, "utf8")); } catch { /* none written */ } }
  return { ...parsed, exitCode, raw: stdout, receipt };
}

// A node "test" script: asserts require('./mod')() === expected. Runs as `node {test}`.
const testAsserting = (expected) =>
  `const f=require("./mod");const v=f();if(v!==${expected}){console.error("FAIL got "+v);process.exit(1)}console.log("ok");\n`;
const modReturning = (val) => `module.exports=()=>${val};\n`;

module.exports = {
  cfg, makeRepo, makeDivergedRepo, runVerify, git,
  testAsserting, modReturning,
};
