"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/*
 * Relayed interview answers. An agent cannot drive init's readline - a pipe drops the
 * buffered lines and a pty echoes them before readline attaches - so without these flags
 * there is no path for answers collected in conversation to reach the config, and the
 * write half of the interview was untestable.
 */

const CLI = path.join(__dirname, "..", "..", "bin", "receipts.js");

function initPrint(args, files) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-relay-"));
  for (const [n, b] of Object.entries(files || { "package.json": JSON.stringify({ name: "x", scripts: { test: "jest" } }) }))
    fs.writeFileSync(path.join(td, n), b);
  const r = spawnSync("node", [CLI, "init", "--print", "--yes", "--dir", td, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { cfg: JSON.parse(r.stdout), stderr: r.stderr };
}

test("relayed answers land in agent.drive and mark it confirmed", () => {
  const { cfg } = initPrint([
    "--drive-auth", "seeded test account qa@acme.test",
    "--drive-bypass", "fixed OTP 000000",
    "--drive-data", "realistic",
    "--drive-browser-surfaces", "invoice PDF, print view",
  ]);
  assert.deepEqual(cfg.agent.drive, {
    confirmed: true,
    auth: "seeded test account qa@acme.test",
    bypass: "fixed OTP 000000",
    data: "realistic",
    browser_surfaces: ["invoice PDF", "print view"],
  });
});

test("a partial relay still counts as asked (a human said 'none needed')", () => {
  const { cfg } = initPrint(["--drive-auth", "none needed"]);
  assert.equal(cfg.agent.drive.confirmed, true);
  assert.equal(cfg.agent.drive.auth, "none needed");
  assert.equal(cfg.agent.drive.bypass, "");
});

test("bare --yes stays unconfirmed and warns", () => {
  const { cfg, stderr } = initPrint([], { "package.json": JSON.stringify({ name: "x", scripts: { test: "jest" } }), "vercel.json": "{}" });
  assert.equal(cfg.agent.drive.confirmed, false);
  assert.match(stderr, /SKIPPED the reachability interview/);
});

test("relaying answers suppresses the skip warning", () => {
  const { stderr } = initPrint(["--drive-auth", "test acct"], { "package.json": JSON.stringify({ name: "x", scripts: { test: "jest" } }), "vercel.json": "{}" });
  assert.doesNotMatch(stderr, /SKIPPED the reachability interview/);
});

test("--env / --env-url bind the verify target without the interview", () => {
  const { cfg } = initPrint(["--env", "staging", "--env-url", "https://acme-staging.vercel.app", "--drive-auth", "none needed"],
    { "package.json": JSON.stringify({ name: "x", scripts: { test: "jest" } }), "vercel.json": "{}" });
  assert.equal(cfg.build.verify_against, "staging");
  assert.equal(cfg.build.environments.staging, "https://acme-staging.vercel.app");
});

test("a config built from relayed answers passes doctor clean", () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-relay-dr-"));
  fs.writeFileSync(path.join(td, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" } }));
  const init = spawnSync("node", [CLI, "init", "--yes", "--no-scaffold", "--dir", td,
    "--drive-auth", "none needed", "--drive-data", "realistic"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const dr = spawnSync("node", [CLI, "doctor", "--dir", td], { encoding: "utf8" });
  assert.equal(dr.status, 0, `doctor should be clean after a relayed init:\n${dr.stderr}`);
});
