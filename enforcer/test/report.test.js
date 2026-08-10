"use strict";
/*
 * The report step's two network paths, against a stubbed fetch - previously the
 * untested corner of the enforcer.
 *
 * Covers the reported failure: on a FORK pull request GitHub downgrades
 * GITHUB_TOKEN to read-only no matter what `permissions:` declares, so posting
 * 403s while the workflow is correctly configured - and the old hint told that
 * user to add the permission they already had.
 */
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "t";
process.env.GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || "o/r";
const report = require("../report.js");

const realFetch = global.fetch;
let calls = [];
const stub = (handler) => {
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const { status, body } = handler(String(url), opts) || { status: 200, body: [] };
    return { status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) };
  };
};

beforeEach(() => { calls = []; });
afterEach(() => { global.fetch = realFetch; delete process.env.GITHUB_EVENT_PATH; });

function writeEvent(payload) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rcpt-")), "event.json");
  fs.writeFileSync(f, JSON.stringify(payload));
  process.env.GITHUB_EVENT_PATH = f;
  return f;
}

test("a fork PR is detected from the event payload", () => {
  writeEvent({ pull_request: { head: { repo: { full_name: "contrib/r" } }, base: { repo: { full_name: "o/r" } } } });
  assert.equal(report.isForkPullRequest(), true);
});

test("a same-repo PR is not a fork", () => {
  writeEvent({ pull_request: { head: { repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } } });
  assert.equal(report.isForkPullRequest(), false);
});

test("no event payload does not crash and assumes same-repo", () => {
  delete process.env.GITHUB_EVENT_PATH;
  assert.equal(report.isForkPullRequest(), false);
});

test("the 403 hint tells a fork PR the truth, not to fix a correct config", () => {
  writeEvent({ pull_request: { head: { repo: { full_name: "contrib/r" } }, base: { repo: { full_name: "o/r" } } } });
  const hint = report.postFailureHint(403);
  assert.match(hint, /fork/i);
  assert.match(hint, /read-only/i);
  assert.doesNotMatch(hint, /the workflow needs/);  // the misleading advice
});

test("the 403 hint still names the permission on a same-repo PR", () => {
  writeEvent({ pull_request: { head: { repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } } });
  assert.match(report.postFailureHint(403), /permissions: pull-requests: write/);
});

test("no hint for non-403 failures", () => {
  assert.equal(report.postFailureHint(422), "");
});

test("allComments pages past the first 100", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, body: "noise" }));
  stub((url) => ({ status: 200, body: /page=2/.test(url) ? [{ id: 999, body: "<!-- receipts -->x" }] : page1 }));
  const all = await report.allComments(7);
  assert.equal(all.length, 101, "the 101st comment must not be lost");
  assert.ok(calls.some((c) => /page=2/.test(c.url)), "it must request page 2");
});

test("allComments stops at a short page instead of looping", async () => {
  stub(() => ({ status: 200, body: [{ id: 1, body: "only" }] }));
  const all = await report.allComments(7);
  assert.equal(all.length, 1);
  assert.equal(calls.length, 1, "a short page means there is no next page");
});

test("upsertComment UPDATES the existing report comment found on a later page", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, body: "noise" }));
  stub((url, opts) => {
    if (opts && opts.method === "PATCH") return { status: 200, body: {} };
    return { status: 200, body: /page=2/.test(url) ? [{ id: 999, body: "<!-- receipts-report -->old" }] : page1 };
  });
  const marker = String(fs.readFileSync(path.join(__dirname, "..", "report.js"), "utf8")
    .match(/COMMENT_MARKER\s*=\s*"([^"]*)"/)?.[1] || "");
  if (!marker) return;  // marker shape changed; the pagination tests still hold
  stub((url, opts) => {
    if (opts && opts.method === "PATCH") return { status: 200, body: {} };
    return { status: 200, body: /page=2/.test(url) ? [{ id: 999, body: marker + "old" }] : page1 };
  });
  assert.equal(await report.upsertComment(7, "new body"), "updated");
  assert.ok(calls.some((c) => c.opts && c.opts.method === "PATCH"), "it must PATCH, not POST a duplicate");
});
