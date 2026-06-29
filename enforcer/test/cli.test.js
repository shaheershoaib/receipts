"use strict";
/*
 * Engine CLI (Phase 3): `receipts verify` / `replay` / `explain`.
 *
 * `verify` runs the SAME enforcer the CI action runs (no second engine to drift). `replay`
 * re-runs a recorded verification and checks the verdict reproduces. `explain` summarizes a
 * receipt. Driven as a subprocess - the real CLI contract.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cfg, makeRepo, testAsserting, modReturning } = require("./helpers.js");

const BIN = path.join(__dirname, "..", "..", "bin", "receipts.js");
const run = (args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status };
};
const tmpReceipt = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")), "receipt.json");

function fixRepo() {
  return makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
}

test("receipts verify runs the engine and re-proves a receipt", () => {
  const r = fixRepo();
  const out = run(["verify", "--json", "--base", r.base, "--head", r.head, "--repo", r.dir, "--pr-body", "closes #1"]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const v = JSON.parse(out.stdout.trim().split("\n").filter(Boolean).pop());
  assert.match(v.reason, /receipt verified/i);
});

test("receipts verify exits non-zero on a BLOCK", () => {
  const r = makeRepo({
    baseFiles: { "mod.js": modReturning(1), "receipts.config.json": cfg() },
    headFiles: { "mod.js": modReturning(2) }, // real change, but no test => no receipt
  });
  const out = run(["verify", "--json", "--base", r.base, "--head", r.head, "--repo", r.dir, "--pr-body", "closes #1"]);
  assert.equal(out.code, 1, "BLOCK must exit 1");
  assert.match(out.stdout, /no receipt/i);
});

test("receipts replay re-runs a receipt and confirms the verdict reproduces", () => {
  const r = fixRepo();
  const out = tmpReceipt();
  run(["verify", "--json", "--base", r.base, "--head", r.head, "--repo", r.dir, "--pr-body", "closes #1", "--receipt-out", out]);
  const rep = run(["replay", out, "--repo", r.dir]);
  assert.equal(rep.code, 0, rep.stdout + rep.stderr);
  assert.match(rep.stdout, /REPRODUCED/);
});

test("receipts explain summarizes a receipt artifact", () => {
  const r = fixRepo();
  const out = tmpReceipt();
  run(["verify", "--json", "--base", r.base, "--head", r.head, "--repo", r.dir, "--pr-body", "closes #1", "--receipt-out", out]);
  const ex = run(["explain", out]);
  assert.equal(ex.code, 0, ex.stderr);
  assert.match(ex.stdout, /receipt \(receipts\/receipt@1\)/);
  assert.match(ex.stdout, /red \(reproduced on base\): true/);
  assert.match(ex.stdout, /receipt-green@head|\$ /); // shows the commands run
});
