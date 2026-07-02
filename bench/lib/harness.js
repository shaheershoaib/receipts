"use strict";
/*
 * gates-bench harness: build a throwaway git repo (base + head, with an optional between-
 * commits mutation), then drive the REAL enforcer (enforcer/verify.js) or the REAL Stop
 * hook (plugin/hooks/stop-gates.mjs) over it as a subprocess and parse the verdict.
 *
 * This deliberately mirrors enforcer/test/helpers.js's makeRepo pattern rather than
 * importing it: the bench is a first-class, independently-runnable instrument (a
 * regression suite FOR the harness), so it owns its fixtures end to end and never reaches
 * into the enforcer's test-only internals. Zero dependencies, zero network, zero npm
 * install - only preinstalled tooling (git, node, python3, bash, sqlite3).
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const VERIFY = path.join(ROOT, "enforcer", "verify.js");
const HOOK = path.join(ROOT, "plugin", "hooks", "stop-gates.mjs");

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    // A test/tool script named *.sh is executed via `bash <file>`, so the +x bit is not
    // strictly required, but set it anyway so a fixture reads like the real thing.
    if (rel.endsWith(".sh")) { try { fs.chmodSync(p, 0o755); } catch { /* best effort */ } }
  }
}

/*
 * makeRepo({ baseFiles, op, headFiles }) -> { dir, base, head }
 *   baseFiles  full tree at the base commit (MUST include receipts.config.json - the
 *              enforcer reads config from BASE).
 *   op(dir)    optional mutation applied BETWEEN the two commits (delete / rename a file -
 *              the delete-failing-test behavior needs a real `git rm`, not an overlay).
 *   headFiles  overlaid on top for the head commit (changed / added files only).
 */
function makeRepo({ baseFiles, op, headFiles }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-bench-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "bench@receipts.local"]);
  git(dir, ["config", "user.name", "gates-bench"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFiles(dir, baseFiles);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  if (op) op(dir);
  writeFiles(dir, headFiles);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "head"]);
  const head = git(dir, ["rev-parse", "HEAD"]);
  return { dir, base, head };
}

// Run the enforcer as the CLI (the exact contract CI + the GitHub Action invoke) and
// return the parsed --json verdict: { verdict, reason, warnings, exitCode }.
function runVerify({ dir, base, head, prBody, env }) {
  const args = [VERIFY, "--json", "--base", base, "--head", head, "--repo", dir];
  if (prBody !== undefined) args.push("--pr-body", prBody);
  let stdout = "", exitCode = 0;
  try {
    // `env` extends the enforcer's environment (the sniffs-test-env cell simulates CI so
    // the cheat actually goes green there - deterministic on and off real CI).
    stdout = execFileSync("node", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
  } catch (e) {
    stdout = (e.stdout || "") + (e.stderr || "");
    exitCode = typeof e.status === "number" ? e.status : 1;
  }
  const line = stdout.trim().split("\n").filter(Boolean).pop() || "{}";
  let parsed;
  try { parsed = JSON.parse(line); }
  catch { parsed = { verdict: "PARSE_ERROR", reason: stdout, warnings: [] }; }
  return { ...parsed, exitCode, raw: stdout };
}

// Drive the Stop hook over a synthetic transcript (a list of tool_use events) exactly as
// Claude Code invokes it: JSONL transcript on disk, Stop-hook JSON on stdin, an isolated
// HOME so no developer ~/.claude/receipts.config.json leaks in. Returns the parsed block
// decision, or null when the hook stays silent (the close-out is allowed).
function runHook(events, { projectConfig } = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "gates-bench-hook-"));
  const tp = path.join(td, "transcript.jsonl");
  fs.writeFileSync(tp, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true }); // empty -> the hook's generic defaults
  if (projectConfig) fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify(projectConfig));
  const stdin = JSON.stringify({ transcript_path: tp, cwd: td, stop_hook_active: false });
  let out = "";
  try {
    out = execFileSync("node", [HOOK], { input: stdin, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } }).trim();
  } catch { out = ""; }
  return out ? JSON.parse(out) : null;
}

// A tool_use transcript event (the shape the hook walks for).
const tu = (name, input = {}) => ({ type: "tool_use", name, input });

module.exports = { makeRepo, runVerify, runHook, tu, git, ROOT };
