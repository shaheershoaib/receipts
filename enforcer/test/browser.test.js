"use strict";
/*
 * Unit tests for the browser-receipt adapter's pure functions (I/O injected, no network).
 * The sha_match logic uses a STUBBED deployments response (a plain object graph), so the whole
 * suite runs offline - the real GitHub fetch lives in verify.js and is never called here.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { firstUrlLine, pickPreviewDeployment, resolvePreviewUrl, runBrowserReceipt } = require("../browser.js");

test("firstUrlLine: takes the first http(s) line, ignores noise, rejects non-URLs", () => {
  assert.equal(firstUrlLine("https://a.example.app\n"), "https://a.example.app");
  assert.equal(firstUrlLine("resolving preview...\nhttps://pr-9.vercel.app\ndone"), "https://pr-9.vercel.app");
  assert.equal(firstUrlLine("http://localhost:3000"), "http://localhost:3000");
  assert.equal(firstUrlLine("not a url\nstill not"), null);
  assert.equal(firstUrlLine(""), null);
  assert.equal(firstUrlLine("ftp://x/y"), null, "only http(s)");
});

test("pickPreviewDeployment: environment_url from a status wins; success is preferred", () => {
  const deps = [
    { id: 1, sha: "head1", environment: "Preview" },
    { id: 2, sha: "head1", environment: "Preview", environment_url: "https://from-deployment.app" },
  ];
  const statuses = new Map([
    [1, [{ state: "failure" }]],
    [2, [{ state: "success", environment_url: "https://from-status.app" }]],
  ]);
  const pick = pickPreviewDeployment(deps, statuses);
  assert.equal(pick.url, "https://from-status.app", "a status environment_url beats the deployment payload");
  assert.equal(pick.sha, "head1");
  assert.equal(pick.succeeded, true);
});

test("pickPreviewDeployment: falls back to a non-success deployment that has a URL", () => {
  const deps = [{ id: 5, sha: "abc", environment_url: "https://building.app" }];
  const statuses = new Map([[5, [{ state: "in_progress" }]]]);
  const pick = pickPreviewDeployment(deps, statuses);
  assert.equal(pick.url, "https://building.app");
  assert.equal(pick.succeeded, false);
});

test("pickPreviewDeployment: no environment_url anywhere -> url null", () => {
  const pick = pickPreviewDeployment([{ id: 9, sha: "z" }], new Map([[9, [{ state: "success" }]]]));
  assert.equal(pick.url, null);
  assert.equal(pick.sha, null);
});

test("resolvePreviewUrl env: reads the var, validates it is a URL", () => {
  assert.deepEqual(
    resolvePreviewUrl({ url_source: "env", url_env: "MY_URL" }, null, { env: { MY_URL: "https://x.app" } }),
    { ok: true, url: "https://x.app", source: "env", sha: null });
  const unset = resolvePreviewUrl({ url_source: "env", url_env: "MY_URL" }, null, { env: {} });
  assert.equal(unset.ok, false);
  assert.match(unset.reason, /\$MY_URL is unset/);
  const bad = resolvePreviewUrl({ url_source: "env", url_env: "MY_URL" }, null, { env: { MY_URL: "not-a-url" } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not an http\(s\) URL/);
});

test("resolvePreviewUrl env: default var name is RECEIPTS_PREVIEW_URL", () => {
  const r = resolvePreviewUrl({ url_source: "env" }, null, { env: { RECEIPTS_PREVIEW_URL: "https://d.app" } });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://d.app");
});

test("resolvePreviewUrl command: runs url_cmd, takes the first URL line; honest fail otherwise", () => {
  const ok = resolvePreviewUrl({ url_source: "command", url_cmd: "print" }, null,
    { runCmd: () => ({ ok: true, out: "noise\nhttps://cmd.app\n" }) });
  assert.deepEqual(ok, { ok: true, url: "https://cmd.app", source: "command", sha: null });

  const nonzero = resolvePreviewUrl({ url_source: "command", url_cmd: "print" }, null,
    { runCmd: () => ({ ok: false, out: "" }) });
  assert.equal(nonzero.ok, false);
  assert.match(nonzero.reason, /exited non-zero/);

  const nourl = resolvePreviewUrl({ url_source: "command", url_cmd: "print" }, null,
    { runCmd: () => ({ ok: true, out: "just logs, no url" }) });
  assert.equal(nourl.ok, false);
  assert.match(nourl.reason, /printed no http\(s\) URL/);

  const missing = resolvePreviewUrl({ url_source: "command" }, null, { runCmd: () => ({ ok: true, out: "" }) });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /url_cmd is not set/);
});

test("resolvePreviewUrl github-deployment: resolves via the stubbed API, carries the sha", () => {
  const gh = () => ({
    ok: true,
    deployments: [{ id: 3, sha: "deadbeef", environment: "Preview", environment_url: "https://gh.app" }],
    statusesById: new Map([[3, [{ state: "success" }]]]),
  });
  const r = resolvePreviewUrl({ url_source: "github-deployment" }, "deadbeef", { ghDeployments: gh });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://gh.app");
  assert.equal(r.sha, "deadbeef");
});

test("resolvePreviewUrl github-deployment: honest degrade when the API is unavailable / empty", () => {
  const noFetcher = resolvePreviewUrl({ url_source: "github-deployment" }, "sha", {});
  assert.equal(noFetcher.ok, false);
  assert.match(noFetcher.reason, /GITHUB_TOKEN \/ GITHUB_REPOSITORY not available/);

  const apiFail = resolvePreviewUrl({ url_source: "github-deployment" }, "sha",
    { ghDeployments: () => ({ ok: false, reason: "deployments API: 404" }) });
  assert.equal(apiFail.ok, false);
  assert.match(apiFail.reason, /404/);

  const empty = resolvePreviewUrl({ url_source: "github-deployment" }, "sha",
    { ghDeployments: () => ({ ok: true, deployments: [], statusesById: new Map() }) });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no deployment for head/);
});

test("resolvePreviewUrl: unknown url_source degrades honestly", () => {
  const r = resolvePreviewUrl({ url_source: "carrier-pigeon" }, null, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown url_source/);
});

test("runBrowserReceipt: sha_match is true on head-match, false on mismatch (G3 binding)", () => {
  const gh = (sha) => ({
    ok: true,
    deployments: [{ id: 1, sha, environment_url: "https://p.app" }],
    statusesById: new Map([[1, [{ state: "success" }]]]),
  });
  const deps = (deploySha) => ({
    runCmd: () => ({ ok: true, out: "browsed" }),
    resolveDeps: { ghDeployments: () => gh(deploySha) },
  });
  const match = runBrowserReceipt({ command: "run", url_source: "github-deployment" }, "HEADSHA", deps("HEADSHA"));
  assert.equal(match.sha_match, true);
  assert.equal(match.ok, true);
  const mismatch = runBrowserReceipt({ command: "run", url_source: "github-deployment" }, "HEADSHA", deps("OTHERSHA"));
  assert.equal(mismatch.sha_match, false, "a preview built from a different sha is flagged");
});

test("runBrowserReceipt: sha_match is null for non-deployment sources (N/A)", () => {
  const res = runBrowserReceipt({ command: "run", url_source: "env" }, "HEADSHA",
    { runCmd: () => ({ ok: true, out: "" }), resolveDeps: { env: { RECEIPTS_PREVIEW_URL: "https://p.app" } } });
  assert.equal(res.sha_match, null);
  assert.equal(res.ok, true);
});

test("runBrowserReceipt: exports RECEIPTS_PREVIEW_URL to the command", () => {
  let seenEnv = null;
  runBrowserReceipt({ command: "run", url_source: "env" }, null, {
    runCmd: (_cmd, envExtra) => { seenEnv = envExtra; return { ok: true, out: "" }; },
    resolveDeps: { env: { RECEIPTS_PREVIEW_URL: "https://exported.app" } },
  });
  assert.deepEqual(seenEnv, { RECEIPTS_PREVIEW_URL: "https://exported.app" });
});

test("runBrowserReceipt: not configured (no command) -> {configured:false}, no work", () => {
  assert.deepEqual(runBrowserReceipt(undefined, "s", {}), { configured: false });
  assert.deepEqual(runBrowserReceipt({}, "s", {}), { configured: false });
  assert.deepEqual(runBrowserReceipt({ url_source: "env" }, "s", {}), { configured: false }, "no command = nothing to run");
});

test("runBrowserReceipt: degrades (no run) when the URL can't be resolved", () => {
  let ran = false;
  const res = runBrowserReceipt({ command: "run", url_source: "env" }, null, {
    runCmd: () => { ran = true; return { ok: true, out: "" }; },
    resolveDeps: { env: {} }, // RECEIPTS_PREVIEW_URL unset
  });
  assert.equal(res.degraded, true);
  assert.equal(res.ok, null);
  assert.match(res.reason, /could not resolve preview URL/);
  assert.equal(ran, false, "the browser command must not run without a URL");
});
