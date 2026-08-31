import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Tests for the SessionStart scar-injection hook (session-memory.mjs).
 *
 * Hermetic like hooks.test.mjs: each run gets an isolated HOME (no developer
 * ~/.claude/receipts.config.json leaks in), a seeded JSONL store pointed at via
 * RECEIPTS_TRAJECTORY_STORE (the same override the MCP server honors), a project dir with
 * (or without) a receipts.config.json, and drives the real script over stdin - the exact
 * SessionStart contract Claude Code invokes ({session_id, transcript_path, cwd, source}).
 *
 * The invariants under test: injects for a matching repo; failures first + one per
 * surface_key; capped small; SILENT on empty / missing / corrupt store; SILENT when no
 * config is present at all (zero behavior change for a receipts-less repo); OFF when
 * agent.memory_inject is "off".
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "session-memory.mjs");

// Build an isolated sandbox: an empty HOME, a project dir, and a seeded store file.
function sandbox({ config, entries } = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-sess-"));
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true }); // empty -> no home config leaks in
  const proj = path.join(td, "proj");
  fs.mkdirSync(proj, { recursive: true });
  if (config) fs.writeFileSync(path.join(proj, "receipts.config.json"), JSON.stringify(config));
  const store = path.join(td, "trajectories.jsonl");
  if (entries != null) {
    const body = Array.isArray(entries) ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n" : String(entries);
    fs.writeFileSync(store, body);
  }
  return { td, home, proj, store };
}

// Drive the hook exactly as Claude Code does: SessionStart JSON on stdin, isolated HOME,
// the store pinned via RECEIPTS_TRAJECTORY_STORE. Accepts a sandbox object directly (its
// `proj` is the cwd) or an explicit `cwd`. Returns the parsed stdout (or null when silent).
function runHook({ cwd, proj, home, store, source = "startup", noStorePin = false } = {}) {
  cwd = cwd || proj;
  const stdin = JSON.stringify({ session_id: "s1", transcript_path: path.join(cwd, "t.jsonl"), cwd, source });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (!noStorePin && store) env.RECEIPTS_TRAJECTORY_STORE = store;
  else delete env.RECEIPTS_TRAJECTORY_STORE;
  const out = execFileSync("node", [HOOK], { input: stdin, encoding: "utf8", env }).trim();
  return out ? JSON.parse(out) : null;
}

const injectedText = (res) => {
  assert.ok(res, "expected an injection, hook was silent");
  assert.equal(res.hookSpecificOutput.hookEventName, "SessionStart");
  return res.hookSpecificOutput.additionalContext;
};

const entry = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  ts: "2026-01-01T00:00:00.000Z",
  repo: "web-app",
  surface: "checkout/PaymentForm.tsx",
  surface_key: "paymentform",
  symptom: "button disabled",
  root_cause: "stale ref",
  outcome: "fixed",
  what_worked: [],
  what_failed: [],
  files: ["src/checkout/PaymentForm.tsx"],
  regressed: [],
  tags: [],
  supersedes: null,
  ...over,
});

// -------------------------------------------------------------- injects for the repo

test("injects prior attempts for the current repo (config present + matching entries)", () => {
  const sb = sandbox({
    config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app" } },
    entries: [
      entry({ id: "1", surface_key: "paymentform", outcome: "reverted", what_failed: ["patched the disabled prop directly - wrong layer"] }),
      entry({ id: "2", repo: "other-app", surface_key: "login", outcome: "fixed" }),
    ],
  });
  const text = injectedText(runHook(sb));
  assert.match(text, /receipts trajectory memory/, "carries the header");
  assert.match(text, /paymentform/, "surfaces the matching-repo entry by surface_key");
  assert.match(text, /wrong layer/, "carries the what_failed dead end");
  assert.ok(!/login/.test(text), "does NOT leak another repo's entry");
});

test("failures are surfaced first and deduped one-per-surface_key", () => {
  const sb = sandbox({
    config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app" } },
    entries: [
      // A clean fix (should sort AFTER failures)
      entry({ id: "ok", ts: "2026-01-09T00:00:00.000Z", surface_key: "cleanspot", outcome: "fixed" }),
      // Two attempts on ONE key - only one should appear (dedupe)
      entry({ id: "f1", ts: "2026-01-02T00:00:00.000Z", surface_key: "trouble", outcome: "reverted", what_failed: ["first dead end"] }),
      entry({ id: "f2", ts: "2026-01-05T00:00:00.000Z", surface_key: "trouble", outcome: "unverified-reasoned", what_failed: ["second dead end"] }),
    ],
  });
  const text = injectedText(runHook(sb));
  const iTrouble = text.indexOf("trouble");
  const iClean = text.indexOf("cleanspot");
  assert.ok(iTrouble >= 0 && iClean >= 0, "both surfaces appear");
  assert.ok(iTrouble < iClean, "the failing surface is listed before the clean fix");
  // dedupe: "trouble" appears exactly once as a surface line
  const troubleLines = text.split("\n").filter((l) => /- trouble\b/.test(l));
  assert.equal(troubleLines.length, 1, "one line per surface_key (deduped)");
});

test("a clean-fix-only entry shows its root_cause (still teaches something)", () => {
  const sb = sandbox({
    config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app" } },
    entries: [entry({ id: "1", surface_key: "usagechart", outcome: "fixed", what_failed: [], root_cause: "prod auth header missing" })],
  });
  const text = injectedText(runHook(sb));
  assert.match(text, /prod auth header missing/);
});

// ------------------------------------------------------------------- the hard cap

test("total injected context is capped small (loads into every session)", () => {
  const many = [];
  for (let i = 0; i < 40; i++) {
    many.push(entry({
      id: "e" + i,
      surface_key: "surface-" + i, // distinct keys so dedupe does not collapse them
      outcome: "reverted",
      what_failed: ["a very long dead-end description ".repeat(20)],
    }));
  }
  const sb = sandbox({ config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app" } }, entries: many });
  const text = injectedText(runHook(sb));
  assert.ok(text.length <= 1500, `cap respected (was ${text.length})`);
  // and it never emits a truncated mid-line: the last char is not a bare partial token dangling
  const surfaceLines = text.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(surfaceLines.length <= 5, `at most 5 entries (was ${surfaceLines.length})`);
});

// ------------------------------------------------------ silent: empty / missing / corrupt

test("empty store -> silent", () => {
  const sb = sandbox({ config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app" } }, entries: "" });
  assert.equal(runHook(sb), null);
});

test("missing store file -> silent", () => {
  const sb = sandbox({ config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app" } } }); // entries omitted -> no file
  assert.equal(runHook(sb), null);
});

test("corrupt lines are tolerated; a valid matching line still injects", () => {
  const sb = sandbox({ config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app" } } });
  fs.writeFileSync(sb.store, '{not json\n\n{"id":"z","ts":"2026-01-01T00:00:00.000Z","repo":"web-app","surface_key":"k","outcome":"reverted","what_failed":["boom"]}\n');
  const text = injectedText(runHook(sb));
  assert.match(text, /- k\b/);
  assert.match(text, /boom/);
});

test("a fully corrupt store -> silent (no valid entries)", () => {
  const sb = sandbox({ config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app" } } });
  fs.writeFileSync(sb.store, "{bad\n{also bad\n");
  assert.equal(runHook(sb), null);
});

// ------------------------------------------------ silent: no config / no repo match / off

test("NO receipts config anywhere -> silent (zero behavior change for a receipts-less repo)", () => {
  // No project config (config omitted), HOME is empty. Even with the store pinned to a file
  // full of matching entries, configFound is false -> the hook must emit NOTHING: a repo that
  // never opted into receipts gets no injected context.
  const sb = sandbox({ entries: [entry({ id: "1", outcome: "reverted", what_failed: ["x"] })] });
  assert.equal(runHook(sb), null, "even with a matching store, no config on any walk-up = no injection");
});

test("config present but NO entry matches this repo -> silent", () => {
  const sb = sandbox({
    config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "nonesuch-repo" } },
    entries: [entry({ id: "1", repo: "web-app", outcome: "reverted", what_failed: ["x"] })],
  });
  assert.equal(runHook(sb), null);
});

test("agent.memory_inject: 'off' -> silent even with matching entries", () => {
  const sb = sandbox({
    config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app", memory_inject: "off" } },
    entries: [entry({ id: "1", outcome: "reverted", what_failed: ["x"] })],
  });
  assert.equal(runHook(sb), null);
});

test("agent.memory_inject: 'on' (explicit) with a config present -> injects", () => {
  const sb = sandbox({
    config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app", memory_inject: "on" } },
    entries: [entry({ id: "1", outcome: "reverted", what_failed: ["explicit on works"] })],
  });
  assert.match(injectedText(runHook(sb)), /explicit on works/);
});

// ---------------------------------------------------------- repo identity fallbacks

test("matches on the directory basename when no repo_name is configured", () => {
  // config present (so the feature is on) but no agent.repo_name; the cwd basename should
  // be tried as a candidate. Name the project dir to match an entry's repo.
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-sess-"));
  const home = path.join(td, "home"); fs.mkdirSync(home, { recursive: true });
  const proj = path.join(td, "widgets"); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "receipts.config.json"), JSON.stringify({ version: 1 }));
  const store = path.join(td, "trajectories.jsonl");
  fs.writeFileSync(store, JSON.stringify(entry({ id: "1", repo: "widgets", surface_key: "sk", outcome: "reverted", what_failed: ["basename match"] })) + "\n");
  const text = injectedText(runHook({ cwd: proj, home, store }));
  assert.match(text, /basename match/);
});

// ---------------------------------------------------------------- robustness

test("garbage stdin -> silent (fail open, never crashes the session)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-sess-"));
  const out = execFileSync("node", [HOOK], {
    input: "this is not json",
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  }).trim();
  assert.equal(out, "");
});

test("superseded entries are not surfaced", () => {
  const sb = sandbox({
    config: { version: 1, agent: { receipts_version: "0.5.1",  repo_name: "web-app" } },
    entries: [
      entry({ id: "old", surface_key: "sk", outcome: "reverted", what_failed: ["the OLD wrong theory"] }),
      entry({ id: "new", surface_key: "sk", outcome: "reverted", what_failed: ["the corrected note"], supersedes: "old" }),
    ],
  });
  const text = injectedText(runHook(sb));
  assert.ok(!/OLD wrong theory/.test(text), "the superseded entry is retired");
  assert.match(text, /corrected note/, "the correcting entry stands");
});
