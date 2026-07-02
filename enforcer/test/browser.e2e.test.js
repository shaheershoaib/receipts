"use strict";
/*
 * Browser receipts end-to-end (Phase 3, the web medium).
 *
 * The adapter runs a browser/e2e command against a PR's PREVIEW deployment as a HEAD-ONLY
 * acceptance check, IN ADDITION to the carried red->green receipt. These tests drive the real
 * verify.js CLI (like every other e2e) with a FAKE "browser" command: a committed node script
 * that reads RECEIPTS_PREVIEW_URL from the env receipts exports and asserts on it - no real
 * Playwright, no real network. url_source: "env" (and "command") keep it fully offline.
 *
 * Every case carries a genuine red->green file receipt too (a fix-claim needs one), so we are
 * testing the browser adapter as the ADD-ON it is: it must never change the primary verdict on
 * its own except when it (block-mode) fails, and it must degrade honestly when the URL/command
 * can't run.
 *
 * The env source reads a var (PREVIEW_URL here) from the enforcer PROCESS's environment. The
 * helper's runVerify spawns verify.js with `execFileSync` inheriting process.env, so we set the
 * var on process.env for the call and restore it after (withEnv) - no change to shared helpers.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const { cfg, makeRepo, runVerify, testAsserting, modReturning } = require("./helpers.js");

// Run `fn` with extra env vars set on process.env, restored afterward (the enforcer subprocess
// inherits process.env; env-sourced URL resolution reads from there).
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

// A committed fake "browser" script. It asserts RECEIPTS_PREVIEW_URL is present and (optionally)
// matches a probe; exits 0 = the head-only acceptance check passed. `fail=true` inverts it.
const browserScript = ({ fail = false, needle = "http" } = {}) => `
const u = process.env.RECEIPTS_PREVIEW_URL || "";
if (!u) { console.error("no RECEIPTS_PREVIEW_URL"); process.exit(2); }
if (!u.includes(${JSON.stringify(needle)})) { console.error("url mismatch: " + u); process.exit(3); }
console.log("browsed " + u);
process.exit(${fail ? 1 : 0});
`;
// A committed fake "sleep forever" browser script, to exercise the timeout.
const hangScript = `setTimeout(() => process.exit(0), 60000); console.log("hanging");\n`;
// A committed fake "url printer" for url_source: "command".
const urlPrinter = (url) => `console.log("resolving..."); console.log(${JSON.stringify(url)});\n`;

// A fix-claim PR body that pins its receipt (a real red->green test), so the browser adapter is
// the only thing under test past the main dance.
const PR = "closes #7\nreceipt: mod.test.js";

// Base tree: a config with the browser_receipt block, a module that returns 1 (the "bug"), and
// a test asserting it returns 2 (fails on base). Head flips the module to 2 (test passes).
function repoWith(browserCfg, { extraFiles = {} } = {}) {
  const baseFiles = {
    // A trivially-green suite_command so the BASELINE verdict is a clean PASS (no G9
    // "suite not checked" warn) - isolating the browser receipt as the only variable.
    "receipts.config.json": cfg({ verify: { test_command: "node {test}", suite_command: "node -e \"process.exit(0)\"", browser_receipt: browserCfg } }),
    "mod.js": modReturning(1),
    "mod.test.js": testAsserting(2),
    ...extraFiles,
  };
  const headFiles = { "mod.js": modReturning(2) };
  return makeRepo({ baseFiles, headFiles });
}

const brWarn = (v) => (v.warnings || []).find((w) => /browser-receipt@preview/i.test(w));
const out = (name) => os.tmpdir() + `/br-${name}-${process.pid}.json`;

test("ok: a passing browser receipt records a PASS row and does not disturb the verdict", () => {
  const r = repoWith(
    { command: "node browser.js", url_source: "env", url_env: "PREVIEW_URL" },
    { extraFiles: { "browser.js": browserScript() } }
  );
  const v = withEnv({ PREVIEW_URL: "https://pr-7.example.app" },
    () => runVerify({ ...r, prBody: PR, receiptOut: out("ok") }));
  assert.equal(v.verdict, "PASS", v.raw);
  assert.ok(v.receipt && v.receipt.browser_receipt, "browser_receipt recorded in the artifact");
  assert.equal(v.receipt.browser_receipt.ok, true, JSON.stringify(v.receipt.browser_receipt));
  assert.equal(v.receipt.browser_receipt.source, "env");
  assert.equal(v.receipt.browser_receipt.url, "https://pr-7.example.app");
  assert.ok((v.receipt.commands || []).some((c) => /browser-receipt@preview \(head-only\)/.test(c.label)),
    "the browser command is in commands[]");
});

test("failing (default mode warn): WARN, exit 0 - the red->green verdict stands", () => {
  const r = repoWith(
    { command: "node browser.js", url_source: "env", url_env: "PREVIEW_URL" },
    { extraFiles: { "browser.js": browserScript({ fail: true }) } }
  );
  const v = withEnv({ PREVIEW_URL: "https://pr-7.example.app" },
    () => runVerify({ ...r, prBody: PR, receiptOut: out("warnfail") }));
  assert.equal(v.exitCode, 0, v.raw);
  assert.equal(v.verdict, "WARN", v.raw);
  const w = brWarn(v);
  assert.ok(w && /FAILED on the preview/i.test(w), "expected a browser-failure WARN: " + JSON.stringify(v.warnings));
  assert.match(w, /head-only/i);
  assert.equal(v.receipt.browser_receipt.ok, false);
});

test("failing + mode:block: BLOCK", () => {
  const r = repoWith(
    { command: "node browser.js", url_source: "env", url_env: "PREVIEW_URL", mode: "block" },
    { extraFiles: { "browser.js": browserScript({ fail: true }) } }
  );
  const v = withEnv({ PREVIEW_URL: "https://pr-7.example.app" },
    () => runVerify({ ...r, prBody: PR }));
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /browser-receipt@preview.*FAILED on the preview/is);
});

test("missing URL (env source, var unset): honest degrade WARN, ok null, verdict stands", () => {
  const r = repoWith(
    { command: "node browser.js", url_source: "env", url_env: "PREVIEW_URL_UNSET_XYZ" },
    { extraFiles: { "browser.js": browserScript() } }
  );
  const v = runVerify({ ...r, prBody: PR, receiptOut: out("nourl") });
  assert.equal(v.exitCode, 0, v.raw);
  assert.equal(v.verdict, "WARN", v.raw);
  const w = brWarn(v);
  assert.ok(w && /could not resolve preview URL/i.test(w), "expected an honest could-not-resolve WARN: " + JSON.stringify(v.warnings));
  assert.equal(v.receipt.browser_receipt.ok, null);
  assert.equal(v.receipt.browser_receipt.url, null);
});

test("url_cmd resolution (command source): the printed URL is used and exported", () => {
  const r = repoWith(
    { command: "node browser.js", url_source: "command", url_cmd: "node print-url.js" },
    { extraFiles: { "browser.js": browserScript({ needle: "resolved-preview" }), "print-url.js": urlPrinter("https://resolved-preview.example.app") } }
  );
  const v = runVerify({ ...r, prBody: PR, receiptOut: out("urlcmd") });
  assert.equal(v.verdict, "PASS", v.raw);
  assert.equal(v.receipt.browser_receipt.ok, true, JSON.stringify(v.receipt.browser_receipt));
  assert.equal(v.receipt.browser_receipt.url, "https://resolved-preview.example.app");
  assert.equal(v.receipt.browser_receipt.source, "command");
});

test("timeout respected: a hanging browser command is killed and reported (WARN by default)", () => {
  const r = repoWith(
    { command: "node browser.js", url_source: "env", url_env: "PREVIEW_URL", timeout_ms: 800 },
    { extraFiles: { "browser.js": hangScript } }
  );
  const t0 = Date.now();
  const v = withEnv({ PREVIEW_URL: "https://pr-7.example.app" },
    () => runVerify({ ...r, prBody: PR, receiptOut: out("timeout") }));
  assert.ok(Date.now() - t0 < 30000, "should not have waited the full 60s hang");
  assert.equal(v.exitCode, 0, v.raw);
  const w = brWarn(v);
  assert.ok(w, "expected a browser WARN on timeout: " + JSON.stringify(v.warnings));
  const cmd = (v.receipt.commands || []).find((c) => /browser-receipt@preview/.test(c.label));
  assert.ok(cmd && cmd.timed_out === true, "the browser command is marked timed_out: " + JSON.stringify(cmd));
});

test("exit-masking command is refused (G9): WARN + not run, never executed", () => {
  const r = repoWith(
    { command: "node browser.js ; echo masked", url_source: "env", url_env: "PREVIEW_URL" },
    { extraFiles: { "browser.js": browserScript() } }
  );
  const v = withEnv({ PREVIEW_URL: "https://pr-7.example.app" },
    () => runVerify({ ...r, prBody: PR, receiptOut: out("mask") }));
  assert.equal(v.exitCode, 0, v.raw);
  const w = brWarn(v);
  assert.ok(w && /mask its own exit/i.test(w), "expected a G9 masking WARN: " + JSON.stringify(v.warnings));
  assert.equal(v.receipt.browser_receipt.ran, false);
  assert.ok(!(v.receipt.commands || []).some((c) => /browser-receipt@preview/.test(c.label)), "masked command not run");
});

test("not configured: no browser_receipt field, no browser row, clean PASS", () => {
  const r = repoWith(undefined); // no browser_receipt block at all (JSON.stringify drops undefined)
  const v = runVerify({ ...r, prBody: PR, receiptOut: out("off") });
  assert.equal(v.verdict, "PASS", v.raw);
  assert.ok(!v.receipt.browser_receipt, "no browser_receipt when unconfigured");
  assert.ok(!brWarn(v), "no browser warning when unconfigured");
});
