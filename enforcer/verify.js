#!/usr/bin/env node
"use strict";
/*
 * receipts enforcer - re-prove a fix-claim at the PR.
 *
 * The receipt is a red-before / green-after acceptance test the fix carries. This
 * re-runs it: the changed test must FAIL on the base commit (it reproduces the
 * reported bug) and PASS on the head commit (the bug is gone). No receipt AND no
 * honest-downgrade tag => blocked. An honest downgrade tag => tracked, allowed.
 *
 * Zero dependencies (git + the project's own test command, from receipts.config.json).
 * It moves HEAD around to overlay the new test onto the base source, so it refuses
 * to run on a dirty tree and always restores the original checkout.
 *
 * Usage:
 *   node verify.js --base <sha> --head <sha> [--repo <dir>] [--config <path>]
 *                  [--pr-body <text> | --pr-body-file <path>] [--json]
 * Exit: 0 for PASS/WARN, 1 for BLOCK.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TEST_PATH = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|\/__tests__\/|_spec\.)/i;
let ARGS = {};

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (["base", "head", "config", "repo", "pr-body", "pr-body-file"].includes(k)) o[k] = argv[++i];
      else o[k] = true;
    } else o._.push(a);
  }
  return o;
}

function git(repo, args) {
  try { return { ok: true, out: execSync(`git -C "${repo}" ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status }; }
}

function runCmd(repo, cmd) {
  try { execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return { ok: true, out: "" }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status }; }
}

function emit(verdict, reason, detail) {
  if (ARGS.json) console.log(JSON.stringify({ verdict, reason, detail: detail || null }));
  else console.log(`receipts: ${verdict} - ${reason}` + (detail ? `\n  ${String(detail).trim()}` : ""));
  process.exit(verdict === "BLOCK" ? 1 : 0);
}

function main() {
  ARGS = parseArgs(process.argv.slice(2));
  const repo = path.resolve(ARGS.repo || process.cwd());
  const cfg = JSON.parse(fs.readFileSync(ARGS.config || path.join(repo, "receipts.config.json"), "utf8"));
  const { base, head } = ARGS;
  if (!base || !head) emit("BLOCK", "usage: --base <sha> --head <sha>");
  const prBody = ARGS["pr-body-file"] ? fs.readFileSync(ARGS["pr-body-file"], "utf8") : (ARGS["pr-body"] || "");

  const claim = cfg.claim || {};
  const degrade = cfg.degrade || {};
  const verify = cfg.verify || {};

  // Not a fix-claim -> nothing to re-verify (only skip when a body was given to check).
  const issueRe = new RegExp(claim.issue_link || "closes #(\\d+)", "i");
  if (prBody && !issueRe.test(prBody)) emit("PASS", "not a fix-claim (no issue link) - nothing to re-verify");

  // Honest downgrade -> tracked, not blocked (the honesty ladder).
  const tags = claim.downgrade_tags || ["unverified-reasoned", "speculative", "reverted"];
  const dg = tags.find((t) => new RegExp(t.replace(/-/g, "[- ]?"), "i").test(prBody));
  if (dg) emit("PASS", `honest downgrade '${dg}' present - tracked, not claimed as verified`);

  if (git(repo, "status --porcelain").out.trim())
    emit("BLOCK", "working tree not clean (the enforcer needs a clean checkout)");

  // The receipt = test files added/changed between base and head.
  const diff = git(repo, `diff --name-only ${base}..${head}`);
  if (!diff.ok) emit("BLOCK", `cannot diff ${base}..${head}`, diff.out);
  const tests = diff.out.split("\n").map((s) => s.trim()).filter((f) => f && TEST_PATH.test(f));

  if (!tests.length) {
    const mode = degrade.on_no_receipt || "require-downgrade-tag";
    if (mode === "warn") emit("WARN", "no receipt (no test added/changed) - allowed by config, but unverified");
    emit("BLOCK", "no receipt: this fix-claim adds no acceptance test. Add a test that FAILS before and PASSES after the fix, or tag the PR 'unverified-reasoned' / 'speculative'.");
  }

  const testCmd = verify.test_command;
  if (!testCmd || /REPLACE_ME/.test(testCmd))
    emit("BLOCK", "verify.test_command is not set in receipts.config.json (run `receipts init`)");
  const cmdFor = (files) => testCmd.replace("{test}", files.map((f) => `"${f}"`).join(" "));

  const original = git(repo, "rev-parse HEAD").out.trim();
  let red, green;
  try {
    // RED: base source, with head's receipt test(s) overlaid on top.
    if (!git(repo, `checkout -q -f ${base}`).ok) emit("BLOCK", `cannot checkout base ${base}`);
    git(repo, `checkout -q ${head} -- ${tests.map((f) => `"${f}"`).join(" ")}`);
    red = runCmd(repo, cmdFor(tests)); // expect FAIL = reproduces the bug
    // GREEN: full head (force-discards the overlay).
    git(repo, `checkout -q -f ${head}`);
    green = runCmd(repo, cmdFor(tests)); // expect PASS = bug gone
  } finally {
    git(repo, `checkout -q -f ${original}`);
  }

  if (red.ok)
    emit("WARN", "weak receipt: the test PASSES on the base commit, so it does not prove it reproduced the reported symptom. Make the test assert the actual symptom (G0/G1).");
  if (!green.ok)
    emit("BLOCK", "the fix does not pass its own receipt test on head", (green.out || "").split("\n").slice(-8).join("\n"));
  emit("PASS", "receipt verified: red on base, green on fix - the symptom is reproduced and now gone");
}

try { main(); }
catch (e) { console.error("receipts enforcer error: " + (e && e.message ? e.message : e)); process.exit(1); }
