import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Tests for the in-session TRIPWIRES:
 *   - the PreToolUse hook (pre-gates.mjs): commit-without-verification + G11-live referee.
 *   - the Stop-hook refire DAMPING (stop-gates.mjs): stand down on the 3rd identical nag after a
 *     fresh user turn; re-arm on any new close-out / evidence.
 *   - hooks.json registration correctness (both hooks, node command, ${CLAUDE_PLUGIN_ROOT}).
 *
 * Hermetic like hooks.test.mjs: an isolated HOME (no developer receipts.config.json leaks in), a
 * transcript file, and the real script driven over stdin - the exact contract Claude Code uses.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRE_HOOK = path.join(HERE, "..", "pre-gates.mjs");
const STOP_HOOK = path.join(HERE, "..", "stop-gates.mjs");
const HOOKS_JSON = path.join(HERE, "..", "hooks.json");

// --- transcript-entry constructors (the real JSONL shapes) -----------------------------------
const useEntry = (name, input = {}) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
});
const resultEntry = (text) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text }] }] },
});
const userTurn = (text = "please continue") => ({
  type: "user",
  message: { role: "user", content: text },
});

// --- PreToolUse driver -----------------------------------------------------------------------
// Writes the transcript, drives pre-gates.mjs over stdin with {tool_name, tool_input, ...}.
// Returns the parsed decision object, or null when the hook allowed (emitted nothing).
// Enforcement is OPT-IN: the tripwires act only where a receipts.config.json exists (project
// walk-up or agent-home), so the driver writes a minimal project config by default and the
// fixtures exercise exactly what a configured repo gets (generic defaults, nothing tuned). Pass
// `projectConfig: null` for the zero-config case, `homeConfig` for the agent-home layer.
// The default MODE depends on whether a human can be prompted: `ask` outside CI, `deny` under it.
// The driver pins CI=1 unless told otherwise, so the firing-condition tests below read as plain
// denies whatever machine runs them; the mode tests pass `ci: null` to get the interactive default.
function runPre(toolName, toolInput, transcriptEntries, { projectConfig = { version: 1 }, homeConfig, ci = "1" } = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-pre-"));
  const tp = path.join(td, "transcript.jsonl");
  fs.writeFileSync(tp, (transcriptEntries || []).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true });
  if (projectConfig) fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify(projectConfig));
  if (homeConfig) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "receipts.config.json"), JSON.stringify(homeConfig));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CI;
  if (ci) env.CI = ci;
  const stdin = JSON.stringify({ tool_name: toolName, tool_input: toolInput, transcript_path: tp, cwd: td });
  const out = execFileSync("node", [PRE_HOOK], { input: stdin, encoding: "utf8", env }).trim();
  return out ? JSON.parse(out) : null;
}
const denies = (name, inp, entries, opts) => {
  const d = runPre(name, inp, entries, opts);
  assert.ok(d, "expected a deny decision, hook was silent");
  assert.equal(d.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(d.hookSpecificOutput.permissionDecision, "deny");
  return d.hookSpecificOutput.permissionDecisionReason;
};
const allows = (name, inp, entries, opts) =>
  assert.equal(runPre(name, inp, entries, opts), null, "expected allow (no output), hook denied");
const asks = (name, inp, entries, opts) => {
  const d = runPre(name, inp, entries, opts);
  assert.ok(d, "expected an ask decision, hook was silent");
  assert.equal(d.hookSpecificOutput.permissionDecision, "ask");
  return d.hookSpecificOutput.permissionDecisionReason;
};
// warn = the tool call proceeds (no permission decision at all) and the agent is TOLD, through
// additionalContext, what it skipped - the channel PreToolUse hooks gained after this tripwire
// was written with "warn is a no-op" baked in.
const warns = (name, inp, entries, opts) => {
  const d = runPre(name, inp, entries, opts);
  assert.ok(d, "expected a warning, hook was silent");
  assert.equal(d.hookSpecificOutput.permissionDecision, undefined, "warn must not decide the permission");
  assert.ok(d.hookSpecificOutput.additionalContext, "warn carries additionalContext");
  return d.hookSpecificOutput.additionalContext;
};

const PROD_EDIT = useEntry("Edit", { file_path: "src/pay.js", old_string: "a", new_string: "b" });

// ============================================================ opt-in: the tripwires need a config

test("zero-config (no receipts.config.json anywhere): a commit after a production edit is ALLOWED", () => {
  // Enforcement is opt-in by config, the rule the SessionStart memory hook already follows: a repo
  // that never ran `receipts init` gets zero behavior change from installing the plugin. Before
  // this, a fresh install denied a version-bump commit in every unrelated repo on the machine.
  allows("Bash", { command: "git commit -m 'fix pay'" }, [PROD_EDIT], { projectConfig: null });
});

test("zero-config: editing a test seen failing is ALLOWED (the G11-live referee is opt-in too)", () => {
  allows("Edit", { file_path: "src/pay.test.js", new_string: "x" },
    [resultEntry("FAIL src/pay.test.js")], { projectConfig: null });
});

test("an agent-home config alone (no project config) turns the tripwires on", () => {
  // The split topology: skills + session cwd in one place, code repos elsewhere. The home layer
  // is the deliberate opt-in for every repo on the machine.
  const reason = denies("Bash", { command: "git commit -m fix" }, [PROD_EDIT],
    { projectConfig: null, homeConfig: { version: 1 } });
  assert.match(reason, /commit-without-verification/);
});

// ============================================================ commit-without-verification tripwire

test("commit right after a production edit with no test run is DENIED", () => {
  const reason = denies("Bash", { command: "git commit -m 'fix pay'" }, [PROD_EDIT]);
  assert.match(reason, /commit-without-verification/);
  assert.match(reason, /src\/pay\.js/, "names the unverified edit");
  assert.match(reason, /RECEIPTS_ACK/, "offers the explicit greppable escape");
});

test("a test command AFTER the edit clears the commit tripwire (allow)", () => {
  allows("Bash", { command: "git commit -m fix" },
    [PROD_EDIT, useEntry("Bash", { command: "npm test" })]);
});

test("a receipts observe after the edit also clears it (allow)", () => {
  allows("Bash", { command: "git commit -m fix" },
    [PROD_EDIT, useEntry("Bash", { command: "receipts observe --url https://x/api --expect '/ok/'" })]);
});

test("output text alone does NOT clear the commit tripwire - the invoked COMMAND is the signal (DENY)", () => {
  // Only a test/receipt COMMAND counts; a runner's stdout echoed in a tool_result is format-
  // dependent and could false-allow from prose, so it is deliberately ignored. Without a Bash
  // test command after the edit, the tripwire still fires.
  const reason = denies("Bash", { command: "git commit -m fix" },
    [PROD_EDIT, resultEntry("PASS src/pay.test.js\n  3 passing")]);
  assert.match(reason, /commit-without-verification/);
});

test("the RECEIPTS_ACK escape tag allows the commit even with no test", () => {
  allows("Bash", { command: "RECEIPTS_ACK='wip checkpoint, tests before PR' git commit -m wip" }, [PROD_EDIT]);
});

test("the --no-verify-receipts escape allows the commit", () => {
  allows("Bash", { command: "git commit -m 'docs only --no-verify-receipts'" }, [PROD_EDIT]);
});

test("RECEIPTS_TRIPWIRE=off inline escape allows the commit", () => {
  allows("Bash", { command: "RECEIPTS_TRIPWIRE=off git commit -m fix" }, [PROD_EDIT]);
});

test("a git commit embedded in a printf/echo string is DATA, not a commit (allow)", () => {
  allows("Bash", { command: "printf 'next: git commit -m done\\n'" }, [PROD_EDIT]);
});

test("a git commit on its own line INSIDE a heredoc body is DATA, not a commit (allow)", () => {
  // Every heredoc line starts after "\n", which the boundary regex treats as a command start.
  // Writing a runbook that MENTIONS the command must not be denied as if it RAN it.
  const cmd = "cat > notes.md <<'EOF'\nRemember to run:\ngit commit -m 'fix: x'\nEOF";
  allows("Bash", { command: cmd }, [PROD_EDIT]);
});

test("a heredoc-fed script whose body contains a commit as a string is DATA (allow)", () => {
  const cmd = "python3 - <<'PY'\ncmd = \"cd /x && git commit -m 'fix: y'\"\nprint(cmd)\nPY";
  allows("Bash", { command: cmd }, [PROD_EDIT]);
});

test("a REAL commit that merely reads its message from a heredoc is still a commit (deny)", () => {
  // `git commit -F -` is the command; the heredoc is only its message. Stripping the body
  // must leave the opener in place so the command itself is still seen.
  const cmd = "git commit -F - <<'EOF'\nfix: z\n\nbody\nEOF";
  const reason = denies("Bash", { command: cmd }, [PROD_EDIT]);
  assert.ok(reason, "commit -F - with a heredoc message must still be a commit");
});

test("a non-commit Bash command is allowed", () => {
  allows("Bash", { command: "git status" }, [PROD_EDIT]);
});

test("commit after editing ONLY a test/doc file (no production edit) is allowed", () => {
  allows("Bash", { command: "git commit -m 'add test'" },
    [useEntry("Edit", { file_path: "src/pay.test.js", new_string: "x" }),
     useEntry("Write", { file_path: "README.md", content: "docs" })]);
});

test("env-prefixed git commit (FOO=bar git commit) is still detected as a commit -> DENY", () => {
  const reason = denies("Bash", { command: "GIT_AUTHOR_NAME=x git commit -m fix" }, [PROD_EDIT]);
  assert.match(reason, /commit-without-verification/);
});

test("commit_unverified: off disables the commit tripwire (allow)", () => {
  allows("Bash", { command: "git commit -m fix" }, [PROD_EDIT],
    { projectConfig: { version: 1, agent: { tripwires: { commit_unverified: "off" } } } });
});

// ============================================================ modes: deny / ask / warn / off

test("default mode OUTSIDE CI is ask: the human is prompted with the tripwire's reason", () => {
  // A human at the keyboard can approve a wip commit; only an unattended run has nobody to ask.
  const reason = asks("Bash", { command: "git commit -m fix" }, [PROD_EDIT], { ci: null });
  assert.match(reason, /commit-without-verification/);
});

test("default mode UNDER CI is deny (nobody can be asked)", () => {
  denies("Bash", { command: "git commit -m fix" }, [PROD_EDIT], { ci: "true" });
});

test("commit_unverified: deny (explicit) denies even outside CI - the untrusted-agent posture", () => {
  denies("Bash", { command: "git commit -m fix" }, [PROD_EDIT],
    { ci: null, projectConfig: { version: 1, agent: { tripwires: { commit_unverified: "deny" } } } });
});

test("commit_unverified: ask (explicit) prompts even under CI", () => {
  asks("Bash", { command: "git commit -m fix" }, [PROD_EDIT],
    { projectConfig: { version: 1, agent: { tripwires: { commit_unverified: "ask" } } } });
});

test("commit_unverified: warn lets the commit through and tells the agent what it skipped", () => {
  const ctx = warns("Bash", { command: "git commit -m fix" }, [PROD_EDIT],
    { projectConfig: { version: 1, agent: { tripwires: { commit_unverified: "warn" } } } });
  assert.match(ctx, /commit-without-verification/);
  assert.match(ctx, /src\/pay\.js/, "still names the unverified edit");
});

test("g11_live: default outside CI is ask, warn is advisory, deny is explicit", () => {
  const failing = [resultEntry("FAIL src/pay.test.js")];
  const edit = ["Edit", { file_path: "src/pay.test.js", new_string: "x" }];
  assert.match(asks(...edit, failing, { ci: null }), /G11/);
  assert.match(warns(...edit, failing, { projectConfig: { version: 1, agent: { tripwires: { g11_live: "warn" } } } }), /G11/);
  denies(...edit, failing, { ci: null, projectConfig: { version: 1, agent: { tripwires: { g11_live: "deny" } } } });
});

test("a project-configured test_command_pattern counts as running the code (allow)", () => {
  // A bespoke runner the defaults don't know about, declared in config.
  allows("Bash", { command: "git commit -m fix" },
    [PROD_EDIT, useEntry("Bash", { command: "./scripts/run-checks.sh" })],
    { projectConfig: { version: 1, agent: { tripwires: { test_command_patterns: ["run-checks\\.sh"] } } } });
});

// ============================================================ what counts as "the tests ran"

test("the project's OWN verify.test_command counts as running the code, with no second declaration", () => {
  // `receipts init` wrote `make test` as the suite command and the tripwire then denied every
  // commit that followed a `make test`, because the default runner list had never heard of it.
  // The config already says how THIS project runs its tests; the tripwire reads it.
  allows("Bash", { command: "git commit -m fix" },
    [PROD_EDIT, useEntry("Bash", { command: "./scripts/check src/pay.test.js" })],
    { projectConfig: { version: 1, verify: { test_command: "./scripts/check {test}" } } });
});

test("verify.suite_command counts too, and a placeholder mid-command matches its invoked form", () => {
  allows("Bash", { command: "git commit -m fix" },
    [PROD_EDIT, useEntry("Bash", { command: "./scripts/suite --all" })],
    { projectConfig: { version: 1, verify: { test_command: "pytest {test}", suite_command: "./scripts/suite" } } });
  allows("Bash", { command: "git commit -m fix" },
    [PROD_EDIT, useEntry("Bash", { command: "mvn -Dtest=PayTest test" })],
    { projectConfig: { version: 1, verify: { test_command: "mvn -Dtest={test_classes} test" } } });
});

test("a REPLACE_ME placeholder command is not a runner (never a false allow)", () => {
  denies("Bash", { command: "git commit -m fix" },
    [PROD_EDIT, useEntry("Bash", { command: "REPLACE_ME: no test runner detected" })],
    { projectConfig: { version: 1, verify: { test_command: "REPLACE_ME: no test runner detected" } } });
});

test("the default runner list covers the common wrappers and runtimes", () => {
  // Each of these was a false DENY: `init` detects several of them, and none was in the list.
  for (const cmd of [
    "make test", "make check", "./gradlew test", "./mvnw test", "bun test", "deno test",
    "bin/rails test", "bundle exec rake test", "python -m unittest", "python3 -m pytest",
    "swift test", "flutter test", "dart test", "nx test app", "npx nx run app:test",
    "turbo run test", "sbt test", "zig build test", "cabal test", "stack test", "lein test",
    "elm-test", "npx ava", "karma start", "npx cypress run", "behave", "robot tests/",
  ]) {
    assert.equal(runPre("Bash", { command: "git commit -m fix" }, [PROD_EDIT, useEntry("Bash", { command: cmd })]), null,
      `expected "${cmd}" to count as running the tests`);
  }
});

test("only the LAST production edit matters: a test then a LATER unverified edit re-arms the tripwire", () => {
  const reason = denies("Bash", { command: "git commit -m fix" }, [
    useEntry("Edit", { file_path: "src/a.js", new_string: "1" }),
    useEntry("Bash", { command: "npm test" }),
    useEntry("Edit", { file_path: "src/b.js", new_string: "2" }), // edited AFTER the test, unverified
  ]);
  assert.match(reason, /src\/b\.js/, "the tripwire names the latest unverified edit");
});

// ================================================================= G11-live referee tripwire

test("editing a test seen FAILING (no green since) is DENIED with the G11 mandate", () => {
  const reason = denies("Edit", { file_path: "src/pay.test.js", new_string: "expect(2).toBe(2)" },
    [resultEntry("FAIL src/pay.test.js\n  expected 5 received 4")]);
  assert.match(reason, /G11/);
  assert.match(reason, /fix the CODE/i);
  assert.match(reason, /test-removal|RECEIPTS_ACK/, "offers the explicit ack escape");
});

test("editing an UNRELATED test (never seen failing) is allowed (conservative)", () => {
  allows("Edit", { file_path: "src/other.test.js", new_string: "x" },
    [resultEntry("FAIL src/pay.test.js\n  expected 5 received 4")]);
});

test("editing a test that was failing but then PASSED (green since) is allowed", () => {
  allows("Edit", { file_path: "src/pay.test.js", new_string: "x" }, [
    resultEntry("FAIL src/pay.test.js"),
    resultEntry("PASS src/pay.test.js\n  4 passing"),
  ]);
});

test("editing a NON-test production file is never a G11-live concern (allow)", () => {
  // Even if the file appears in a failing log, the tripwire only guards edits to TEST files.
  allows("Edit", { file_path: "src/pay.js", new_string: "x" },
    [resultEntry("FAIL src/pay.js line 3")]);
});

test("a Write to a failing test file with a test-removal ack is allowed", () => {
  allows("Write", { file_path: "src/pay.test.js", content: "// test-removal: feature deleted in #123" },
    [resultEntry("FAIL src/pay.test.js")]);
});

test("a fail token that is NOT on the same line as the test file does not bind (conservative allow)", () => {
  // The file name and the FAIL token are on separate lines -> not a per-file status line.
  allows("Edit", { file_path: "src/pay.test.js", new_string: "x" },
    [resultEntry("Running src/pay.test.js\n... lots of setup ...\nSome unrelated module FAILED to load")]);
});

test("MultiEdit on a failing test file is guarded the same as Edit (DENY)", () => {
  const reason = denies("MultiEdit", { file_path: "src/pay.test.js", edits: [{ old_string: "a", new_string: "b" }] },
    [resultEntry("FAIL src/pay.test.js")]);
  assert.match(reason, /G11/);
});

test("g11_live: off disables the referee tripwire (allow)", () => {
  allows("Edit", { file_path: "src/pay.test.js", new_string: "x" },
    [resultEntry("FAIL src/pay.test.js")],
    { projectConfig: { version: 1, agent: { tripwires: { g11_live: "off" } } } });
});

// ================================================================= Stop-hook refire DAMPING

// Damping drives the REAL Stop hook across multiple invocations with a growing transcript and a
// PERSISTENT HOME (the state file keys off transcript_path and lives in os.tmpdir()). This driver
// keeps one td/home for the whole scenario so the state accumulates as it would in a real session.
function makeStopSession() {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-damp-"));
  const tp = path.join(td, "transcript.jsonl");
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify({ version: 1 })); // opted in
  const entries = [];
  const flush = () => fs.writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return {
    add(e) { entries.push(e); flush(); return this; },
    stop() {
      const out = execFileSync("node", [STOP_HOOK], {
        input: JSON.stringify({ transcript_path: tp, cwd: td, stop_hook_active: false }),
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      }).trim();
      return out ? JSON.parse(out) : null; // {decision:"block",reason} or null
    },
  };
}
const CLOSEOUT = useEntry("mcp__linear__update_issue", { state: "Done" });
const MERGE = useEntry("mcp__github__merge_pull_request", { pull_number: 1 });
const NAV = useEntry("mcp__chrome__navigate", { url: "https://acme-staging.vercel.app/x" });
const SHOT = useEntry("mcp__chrome__screenshot");

test("damping: 3rd identical stop AFTER a user turn stands down silently (never on 1st/2nd)", () => {
  const s = makeStopSession();
  s.add(CLOSEOUT);
  assert.ok(s.stop(), "1st stop blocks");
  s.add(userTurn());
  assert.ok(s.stop(), "2nd stop still blocks (never damp on the 2nd)");
  s.add(userTurn());
  assert.equal(s.stop(), null, "3rd identical stop after a fresh user turn is damped (silent)");
  s.add(userTurn());
  assert.equal(s.stop(), null, "and stays damped for the same signature");
});

test("damping: NO user turn between stops -> keeps blocking (the human hasn't seen/moved on)", () => {
  const s = makeStopSession();
  s.add(CLOSEOUT);
  assert.ok(s.stop(), "1st blocks");
  assert.ok(s.stop(), "2nd blocks (no user turn)");
  assert.ok(s.stop(), "3rd still blocks (no user turn -> no damp)");
  assert.ok(s.stop(), "4th still blocks");
});

test("damping: a tool_result 'user' entry is NOT a user turn (does not enable damping)", () => {
  const s = makeStopSession();
  s.add(CLOSEOUT);
  assert.ok(s.stop(), "1st blocks");
  s.add(resultEntry("some tool output")); // role:user but a tool_result, not a human message
  assert.ok(s.stop(), "2nd blocks");
  s.add(resultEntry("more tool output"));
  assert.ok(s.stop(), "3rd still blocks - tool_results don't count as the human seeing it");
});

test("damping: a NEW close-out re-arms enforcement (signature changed)", () => {
  const s = makeStopSession();
  s.add(CLOSEOUT);
  s.stop(); s.add(userTurn()); s.stop(); s.add(userTurn());
  assert.equal(s.stop(), null, "damped on the 3rd");
  s.add(CLOSEOUT); // a fresh close-out -> new signature
  assert.ok(s.stop(), "the new close-out re-arms the gate (blocks again)");
});

test("damping: added EVIDENCE changes the outcome (the gate is satisfied, silent - not a damp)", () => {
  const s = makeStopSession();
  s.add(MERGE).add(CLOSEOUT);
  assert.ok(s.stop(), "1st blocks (merge+closeout, no evidence)");
  s.add(userTurn());
  assert.ok(s.stop(), "2nd blocks");
  // Now the agent actually verifies: navigate + screenshot after the merge, then re-closes.
  s.add(NAV).add(SHOT).add(CLOSEOUT);
  assert.equal(s.stop(), null, "with evidence in the window the gate is satisfied (silent, earned)");
});

test("damping: state-file unwritable -> fail-open to blocking (never a lost gate)", () => {
  // Point os.tmpdir() at a non-writable path so writeState fails; the hook must still BLOCK.
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-damp-ro-"));
  const tp = path.join(td, "t.jsonl");
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tp, JSON.stringify(CLOSEOUT) + "\n");
  fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify({ version: 1 })); // opted in
  const roTmp = path.join(td, "ro-tmp");
  fs.mkdirSync(roTmp);
  fs.chmodSync(roTmp, 0o500); // read+execute, no write
  const stop = () => {
    const out = execFileSync("node", [STOP_HOOK], {
      input: JSON.stringify({ transcript_path: tp, cwd: td, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: roTmp },
    }).trim();
    return out ? JSON.parse(out) : null;
  };
  try {
    assert.ok(stop(), "1st blocks");
    fs.appendFileSync(tp, JSON.stringify(userTurn()) + "\n");
    assert.ok(stop(), "2nd blocks");
    fs.appendFileSync(tp, JSON.stringify(userTurn()) + "\n");
    // With a broken state file the count never persists past 1, so it can never reach the
    // >=2 damp threshold: enforcement holds (block) rather than silently standing down.
    assert.ok(stop(), "3rd STILL blocks: a lost state file fails open to the gate, not to a stand-down");
  } finally {
    fs.chmodSync(roTmp, 0o700); // restore so the tmp dir can be cleaned
  }
});

// ================================================================= hooks.json registration

test("hooks.json registers BOTH hooks with node + ${CLAUDE_PLUGIN_ROOT}", () => {
  const j = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf8"));
  const stop = j.hooks.Stop?.[0]?.hooks?.[0]?.command || "";
  assert.match(stop, /node .*\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/stop-gates\.mjs/, "Stop hook registered");
  const pre = j.hooks.PreToolUse?.[0];
  assert.ok(pre, "PreToolUse block present");
  assert.match(pre.matcher, /Bash/, "PreToolUse matches Bash");
  assert.match(pre.matcher, /Edit/, "PreToolUse matches Edit");
  assert.match(pre.matcher, /Write/, "PreToolUse matches Write");
  assert.match(pre.matcher, /MultiEdit/, "PreToolUse matches MultiEdit");
  const preCmd = pre.hooks?.[0]?.command || "";
  assert.match(preCmd, /node .*\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/pre-gates\.mjs/, "pre-gates registered with node + plugin root");
});
