"use strict";
/*
 * E2E tests for `receipts observe` (Phase 2: live receipts).
 *
 * `observe` probes the LIVE build NOW and prints ONE `LIVE-RECEIPT: {json}` marker line - the
 * hand-off the Stop hook reads. `met` uses the SAME red/green law as a command receipt (exit-0 /
 * 2xx floor + optional regex), and the observation is bound to the build (G3). Driven as a
 * subprocess: the real CLI contract. No test runner, no deploy - a `node -e` / `echo` command
 * stands in for a live probe, and a localhost `http` server started in-test stands in for a
 * deployed URL.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync, spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BIN = path.join(__dirname, "..", "..", "bin", "receipts.js");
const run = (args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status };
};
// ASYNC run - required for the --url tests: the in-test http server shares this process, and a
// SYNCHRONOUS spawnSync would block this event loop so the server could never answer the child's
// fetch (a deadlock). spawn keeps the loop serving while the child probes.
const runAsync = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [BIN, ...args], { encoding: "utf8" });
  let stdout = "", stderr = "";
  c.stdout.on("data", (d) => { stdout += d; });
  c.stderr.on("data", (d) => { stderr += d; });
  c.on("close", (code) => resolve({ stdout, stderr, code }));
});
// Parse the single marker line out of stdout. Asserts there is EXACTLY one.
function marker(stdout) {
  const lines = stdout.split("\n").filter((l) => l.includes("LIVE-RECEIPT:"));
  assert.equal(lines.length, 1, `expected exactly one LIVE-RECEIPT line, got ${lines.length}:\n${stdout}`);
  const json = lines[0].slice(lines[0].indexOf("LIVE-RECEIPT:") + "LIVE-RECEIPT:".length).trim();
  return JSON.parse(json);
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "observe-")), "live.json");

// --------------------------------------------------------------------- --cmd probes

test("observe --cmd: met (exit 0) prints the marker and exits 0", () => {
  const r = run(["observe", "--cmd", "echo paid"]);
  assert.equal(r.code, 0, "exit 0 when met");
  const rec = marker(r.stdout);
  assert.equal(rec.schema, "receipts/live-receipt@1");
  assert.equal(rec.probe.kind, "cmd");
  assert.equal(rec.probe.spec, "echo paid");
  assert.equal(rec.met, true);
  assert.equal(rec.expect, null);
  assert.equal(rec.artifact.kind, "none"); // no --sha given
  assert.ok(/paid/.test(rec.observed));
  assert.ok(rec.generated_at);
});

test("observe --cmd --expect: regex over output decides met", () => {
  const ok = run(["observe", "--cmd", "echo status=paid", "--expect", "/paid/"]);
  assert.equal(ok.code, 0);
  const okRec = marker(ok.stdout);
  assert.equal(okRec.met, true);
  assert.equal(okRec.expect, "paid"); // slashes stripped, stored as the source

  const bad = run(["observe", "--cmd", "echo status=pending", "--expect", "/paid/"]);
  assert.equal(bad.code, 1, "not-met exits non-zero");
  const badRec = marker(bad.stdout); // marker STILL prints (failed observation is evidence)
  assert.equal(badRec.met, false);
});

test("observe --cmd: non-zero exit is not met (exit-0 floor), marker still prints", () => {
  const r = run(["observe", "--cmd", "false"]);
  assert.equal(r.code, 1);
  assert.equal(marker(r.stdout).met, false);
});

test("observe --sha binds the artifact verbatim (deploy-sha)", () => {
  const r = run(["observe", "--cmd", "echo ok", "--sha", "4e3c1a9"]);
  const rec = marker(r.stdout);
  assert.equal(rec.artifact.kind, "deploy-sha");
  assert.equal(rec.artifact.id, "4e3c1a9");
  assert.match(rec.artifact.source, /verbatim/);
});

test("observe --sha-cmd resolves the artifact id (first non-empty line)", () => {
  const r = run(["observe", "--cmd", "echo ok", "--sha-cmd", "printf 'abc123def\\n'"]);
  const rec = marker(r.stdout);
  assert.equal(rec.artifact.kind, "deploy-sha");
  assert.equal(rec.artifact.id, "abc123def");
  assert.equal(rec.artifact.source, "printf 'abc123def\\n'");
});

test("observe --sha-cmd that fails / prints nothing is rejected (no phantom binding)", () => {
  const r = run(["observe", "--cmd", "echo ok", "--sha-cmd", "false"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /build binding could not be resolved/i);
  assert.ok(!r.stdout.includes("LIVE-RECEIPT:"), "no marker when the run is rejected up front");
});

// ------------------------------------------------------------- guardrails / rejections

test("observe --cmd with a masked exit is rejected (G9 - a masked exit fakes met)", () => {
  const r = run(["observe", "--cmd", "false ; echo done"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /mask/i);
  assert.ok(!r.stdout.includes("LIVE-RECEIPT:"));
});

test("observe --sha-cmd with a masked exit is rejected", () => {
  const r = run(["observe", "--cmd", "echo ok", "--sha-cmd", "echo a | tail -1"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /mask/i);
});

test("observe rejects both --cmd and --url", () => {
  const r = run(["observe", "--cmd", "echo x", "--url", "https://example.com"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage/i);
});

test("observe rejects neither --cmd nor --url", () => {
  const r = run(["observe"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage/i);
});

test("observe rejects both --sha and --sha-cmd", () => {
  const r = run(["observe", "--cmd", "echo x", "--sha", "a", "--sha-cmd", "echo b"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not both/i);
});

test("observe rejects an invalid --expect regex up front", () => {
  const r = run(["observe", "--cmd", "echo x", "--expect", "/[unterminated/"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not a valid regex/i);
  assert.ok(!r.stdout.includes("LIVE-RECEIPT:"));
});

test("observe --url rejects a non-https, non-localhost URL", () => {
  const r = run(["observe", "--url", "http://example.com/x"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /https/i);
});

// ------------------------------------------------------------------------ --out file

test("observe --out writes the full receipt JSON and still prints the marker", () => {
  const out = tmpFile();
  const r = run(["observe", "--cmd", "echo ok", "--sha", "a1", "--out", out]);
  assert.equal(r.code, 0);
  const fromStdout = marker(r.stdout);
  const fromFile = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual(fromFile, fromStdout, "the --out file matches the printed marker");
  assert.equal(fromFile.schema, "receipts/live-receipt@1");
});

// -------------------------------------------------------------------- --url probes
//
// A localhost http server stands in for a deployed URL. IMPORTANT: after the CLI child (which
// uses global fetch) returns, force-close active keep-alive sockets - server.close() alone waits
// on the child's lingering connection and would hang the test (found the hard way). closeAll
// Connections() (node >=18.2; CI runs 20/22) resolves it.
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", async () => {
      const port = srv.address().port;
      try { await fn(port); resolve(); }
      catch (e) { reject(e); }
      finally { srv.closeAllConnections(); srv.close(); }
    });
  });
}

test("observe --url: 2xx AND regex over the body => met", async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end('{"status":"paid"}'); },
    async (port) => {
      const r = await runAsync(["observe", "--url", `http://127.0.0.1:${port}/orders/42`, "--expect", "/paid/"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const rec = marker(r.stdout);
      assert.equal(rec.probe.kind, "url");
      assert.equal(rec.met, true);
      assert.ok(/paid/.test(rec.observed));
    },
  );
});

test("observe --url: a non-2xx status is not met even without a regex (2xx floor)", async () => {
  await withServer(
    (req, res) => { res.writeHead(500); res.end("boom"); },
    async (port) => {
      const r = await runAsync(["observe", "--url", `http://127.0.0.1:${port}/x`]);
      assert.equal(r.code, 1, "500 is not met");
      assert.equal(marker(r.stdout).met, false);
    },
  );
});

test("observe --url: 2xx but the body fails the regex => not met", async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end('{"status":"pending"}'); },
    async (port) => {
      const r = await runAsync(["observe", "--url", `http://127.0.0.1:${port}/x`, "--expect", "/paid/"]);
      assert.equal(r.code, 1);
      assert.equal(marker(r.stdout).met, false);
    },
  );
});

// ------------------------------------------------------------- doc conformance

test("every documented `receipts observe` --cmd/--sha-cmd example passes the exit-masking guard", () => {
  // The docs are part of the contract: a user copying a documented example must never be
  // rejected by masksExit. (Mirrors the receipt-cmd doc-conformance test in unit.test.js.)
  const { masksExit } = require("../verify.js");
  const doc = fs.readFileSync(path.join(__dirname, "..", "..", "spec", "LIVE-RECEIPT.md"), "utf8");
  const cmds = [...doc.matchAll(/--(?:cmd|sha-cmd)\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(cmds.length >= 4, `expected the documented observe examples to be found (got ${cmds.length})`);
  for (const c of cmds) assert.ok(!masksExit(c), `documented observe example must not mask its exit: ${c}`);
});
