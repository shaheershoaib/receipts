"use strict";
/*
 * E2E tests for G13 through the real enforcer. The coverage command in the fixtures is
 * a node script that WRITES a crafted lcov - the engine under test is the plumbing
 * (run command -> read lcov -> intersect with the diff), not any one coverage tool;
 * lcov is the interchange contract.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { cfg, makeRepo, runVerify, testAsserting, modReturning } = require("./helpers.js");

// Writes an lcov marking mod.js line 1 covered - and nothing else.
const MAKE_LCOV = `const fs=require("fs");
fs.mkdirSync("coverage",{recursive:true});
fs.writeFileSync("coverage/lcov.info","SF:mod.js\\nDA:1,1\\nend_of_record\\n");
`;

function fixture(gatesOver) {
  return makeRepo({
    baseFiles: {
      "receipts.config.json": cfg({
        verify: { suite_command: "node mod.test.js" },
        gates: { G13: { coverage_command: "node make-lcov.js" }, ...(gatesOver || {}) },
      }),
      "mod.js": modReturning(1),
      "make-lcov.js": MAKE_LCOV,
    },
    headFiles: {
      "mod.js": modReturning(2),              // covered per the crafted lcov
      "shadow.js": "module.exports = () => 'rode along unverified';\n", // never executed
      "mod.test.js": testAsserting(2),
    },
  });
}

test("G13: changed lines no test executed are named (warn default)", () => {
  const { dir, base, head } = fixture();
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "WARN", r.reason);
  assert.ok(
    r.warnings.some((w) => /G13 claim-scope congruence/.test(w) && /shadow\.js/.test(w) && /not loaded by any test/.test(w)),
    `the unexercised rider is named: ${JSON.stringify(r.warnings)}`
  );
  assert.ok(!r.warnings.some((w) => /G13/.test(w) && /mod\.js:/.test(w)), "the covered fix line is clean");
});

test("G13 block mode: the unexercised diff fails the gate", () => {
  const { dir, base, head } = fixture({ G13: { coverage_command: "node make-lcov.js", mode: "block" } });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /G13 claim-scope congruence/);
});

test("G13: a missing lcov degrades loudly, never silently", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: {
      "receipts.config.json": cfg({
        verify: { suite_command: "node mod.test.js" },
        gates: { G13: { coverage_command: "node -e \"process.exit(0)\"" } }, // writes nothing
      }),
      "mod.js": modReturning(1),
    },
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "WARN");
  assert.ok(r.warnings.some((w) => /G13 not evaluated/.test(w) && /no lcov/.test(w)), JSON.stringify(r.warnings));
});

test("G13 is opt-in: no coverage_command, no check, no noise", () => {
  const { dir, base, head } = makeRepo({
    baseFiles: {
      "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" } }),
      "mod.js": modReturning(1),
    },
    headFiles: { "mod.js": modReturning(2), "rider.js": "x", "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.ok(!r.warnings.some((w) => /G13/.test(w)), JSON.stringify(r.warnings));
});
