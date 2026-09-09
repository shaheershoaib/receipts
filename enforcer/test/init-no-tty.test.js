"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/*
 * `receipts init` with no terminal. An agent's stdin is never a TTY, so readline has
 * nobody to ask: before this test, init printed the first prompt, hit end of input and
 * exited 0 having written NOTHING - a green exit code and no config, which is the exact
 * silence the product exists to remove. The interview has to travel with the CLI: name
 * the questions, name the relay flags, exit non-zero, write nothing.
 */

const CLI = path.join(__dirname, "..", "..", "bin", "receipts.js");

function freshProject() {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-init-notty-"));
  fs.writeFileSync(path.join(td, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" } }));
  return td;
}

function runInit(td, args) {
  // stdin: "ignore" = /dev/null, which is what an agent's Bash tool hands a child.
  const r = spawnSync("node", [CLI, "init", "--dir", td, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

test("bare init with no terminal refuses loudly: exit 2, nothing written, the four questions and the relay flags on stderr", () => {
  const td = freshProject();
  const r = runInit(td, []);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}\nstdout:\n${r.out}\nstderr:\n${r.err}`);
  assert.equal(fs.existsSync(path.join(td, "receipts.config.json")), false, "must not write a config nobody answered");
  assert.match(r.err, /signed-in state/, "question 1 must be printed");
  assert.match(r.err, /browser/i, "question 4 must be printed");
  assert.match(r.err, /--drive-auth/, "the relay form must be printed so the caller can pass the answers back");
  assert.match(r.err, /--yes/, "the relay form includes --yes");
});

test("init --yes --print with no terminal still previews (the setup skill's grounding step)", () => {
  const td = freshProject();
  const r = runInit(td, ["--yes", "--print"]);
  assert.equal(r.code, 0, `preview must stay allowed, got ${r.code}\n${r.err}`);
  assert.match(r.out, /"agent"/, "the previewed config is on stdout");
  assert.equal(fs.existsSync(path.join(td, "receipts.config.json")), false, "--print writes nothing");
});
