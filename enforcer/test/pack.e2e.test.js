"use strict";
/*
 * Packed-tarball smoke test (the dynamic half of the shipped-artifact defense): `npm
 * pack` the real package, extract it, and run a real red->green verification THROUGH
 * the packed bin. The unit and e2e suites run from the repo tree, where every module
 * exists regardless of the `files` allowlist - so they can be green while the published
 * artifact is broken (0.2.0 shipped exactly that way: verify.js without g6.js). Only
 * executing the tarball itself proves the artifact.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cfg, makeRepo, testAsserting, modReturning } = require("./helpers.js");

const ROOT = path.join(__dirname, "..", "..");

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

test("the packed npm artifact verifies a real receipt (no missing shipped modules)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-pack-"));
  // Pack the CURRENT tree's package.json/files into a tarball, then extract it.
  const packOut = sh("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: ROOT }).trim();
  const tgz = path.join(tmp, packOut.split("\n").filter(Boolean).pop());
  sh("tar", ["-xzf", tgz, "-C", tmp]);
  const packedBin = path.join(tmp, "package", "bin", "receipts.js");

  // A minimal fix-claim fixture, verified through the PACKED bin - the same code path
  // `npx receipts-cli verify` takes on a user's machine.
  const { dir, base, head } = makeRepo({
    baseFiles: {
      "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" } }),
      "mod.js": modReturning(1),
    },
    // The fix carries its own receipt: the test is added at head (red on base via
    // overlay, green on head), alongside the fix itself.
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  let out = "", code = 0;
  try {
    out = sh("node", [packedBin, "verify", "--json", "--base", base, "--head", head, "--repo", dir, "--pr-body", "closes #1"]);
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
    code = typeof e.status === "number" ? e.status : 1;
  }
  // Diagnostics quote the CLI's output with "Cannot find module" rewritten to the error
  // CODE - otherwise, when THIS test is itself a receipt (red on a broken base), the
  // enforcer's load-error heuristic would misread the quoted crash text as a load-error red.
  const safe = (s) => String(s).replace(/cannot find module/gi, "MODULE_NOT_FOUND:");
  assert.ok(
    !/cannot find module/i.test(out),
    `the packed CLI is missing a shipped module (the 0.2.0 failure class):\n${safe(out)}`
  );
  let verdict = null;
  try { verdict = JSON.parse(out.trim().split("\n").filter(Boolean).pop()).verdict; } catch { /* asserted below */ }
  assert.equal(verdict, "PASS", `expected the packed bin to re-prove the receipt (PASS), got:\n${safe(out)}`);
  assert.equal(code, 0, "packed verify must exit 0 on PASS");
});
