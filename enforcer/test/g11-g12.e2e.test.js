"use strict";
/*
 * E2E tests for the optimizing-agent gates, through the real enforcer subprocess:
 *   G11 referee integrity - deleted tests / added skips / snapshot churn / renames /
 *       the `test-removal:` acknowledgment
 *   G12 silencing - removed throw / added empty catch on a fix-claim
 * Per the suite's convention: a valid case, an invalid case, and the malicious case
 * each gate exists for.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cfg, runVerify, git, testAsserting, modReturning } = require("./helpers.js");

// makeRepo, extended: `op(dir)` runs between the base and head commits, so a test can
// DELETE or RENAME files (the shared helper only overlays).
function makeRepoOps({ baseFiles, op, headFiles }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-g11-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@receipts.local"]);
  git(dir, ["config", "user.name", "receipts-test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  const write = (files) => {
    for (const [rel, content] of Object.entries(files || {})) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  };
  write(baseFiles);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  if (op) op(dir);
  write(headFiles);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "head"]);
  const head = git(dir, ["rev-parse", "HEAD"]);
  return { dir, base, head };
}

// A fix-claim fixture whose receipt is real (red on base, green on head) - the G11/G12
// finding rides on TOP of an otherwise-clean fix, which is exactly the malicious shape.
const FIX = {
  "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" } }),
  "mod.js": modReturning(1),
};

// ------------------------------------------------------------------------------- G11

test("G11 malicious: an unrelated failing test deleted to get green is flagged (warn default)", () => {
  const { dir, base, head } = makeRepoOps({
    baseFiles: { ...FIX, "unrelated.test.js": `const f=require("./mod");if(f()!==3){console.error("always red");process.exit(1)}` },
    op: (d) => fs.rmSync(path.join(d, "unrelated.test.js")),
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "WARN", `default is warn, not block: ${r.reason}`);
  assert.ok(r.warnings.some((w) => /G11 referee integrity/.test(w) && /unrelated\.test\.js/.test(w)),
    `the deleted referee is named: ${JSON.stringify(r.warnings)}`);
});

test("G11 block mode: the deletion fails the gate", () => {
  const { dir, base, head } = makeRepoOps({
    baseFiles: {
      ...FIX,
      "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" }, gates: { G11: { mode: "block" } } }),
      "unrelated.test.js": `process.exit(1)`,
    },
    op: (d) => fs.rmSync(path.join(d, "unrelated.test.js")),
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /G11 referee integrity/);
});

test("G11 honest: `test-removal:` acknowledges the deletion - tracked, never blocked", () => {
  const { dir, base, head } = makeRepoOps({
    baseFiles: {
      ...FIX,
      "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" }, gates: { G11: { mode: "block" } } }),
      "dead-feature.test.js": `process.exit(1)`,
    },
    op: (d) => fs.rmSync(path.join(d, "dead-feature.test.js")),
    headFiles: { "mod.js": modReturning(2), "mod.test.js": testAsserting(2) },
  });
  const r = runVerify({
    dir, base, head,
    prBody: "closes #1\ntest-removal: the feature it covered was deleted in this PR",
  });
  assert.equal(r.verdict, "WARN", `acknowledged removal must not block even in block mode: ${r.reason}`);
  assert.ok(r.warnings.some((w) => /acknowledged/.test(w)), JSON.stringify(r.warnings));
});

test("G11: a RENAMED test is not a deletion (no false positive)", () => {
  const { dir, base, head } = makeRepoOps({
    baseFiles: { ...FIX, "old-name.test.js": testAsserting(2) },
    op: (d) => fs.renameSync(path.join(d, "old-name.test.js"), path.join(d, "new-name.test.js")),
    headFiles: { "mod.js": modReturning(2) },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.ok(!r.warnings.some((w) => /G11 referee integrity/.test(w)),
    `a rename keeps the referee: ${JSON.stringify(r.warnings)}`);
});

test("G11: an added .skip on a changed test is flagged; snapshot churn warns softly", () => {
  const { dir, base, head } = makeRepoOps({
    baseFiles: { ...FIX, "other.test.js": `console.log("ok");` },
    headFiles: {
      "mod.js": modReturning(2),
      "mod.test.js": testAsserting(2),
      "other.test.js": `test.skip("later", () => {});\nconsole.log("ok");`,
      "__snapshots__/ui.test.js.snap": "exports[`renders`] = `<div>NEW</div>`;\n",
    },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "WARN");
  assert.ok(r.warnings.some((w) => /skip\/focus marker/.test(w) && /other\.test\.js/.test(w)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /snapshot file\(s\) rewritten/.test(w)), JSON.stringify(r.warnings));
});

// ------------------------------------------------------------------------------- G12

test("G12 malicious: a fix-claim that removes a throw is asked the silencing question", () => {
  const { dir, base, head } = makeRepoOps({
    baseFiles: { ...FIX, "auth.js": `module.exports=(ok)=>{if(!ok)throw new Error("forbidden");return 1};\n` },
    headFiles: {
      "auth.js": `module.exports=(ok)=>{return 1};\n`, // the 403 "fixed" by deleting the check
      "mod.js": modReturning(2),
      "mod.test.js": testAsserting(2),
    },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "WARN");
  assert.ok(r.warnings.some((w) => /G12 fix the cause/.test(w) && /auth\.js/.test(w)), JSON.stringify(r.warnings));
});

test("G12 block mode: the silencing shape fails the gate", () => {
  const { dir, base, head } = makeRepoOps({
    baseFiles: {
      ...FIX,
      "receipts.config.json": cfg({ verify: { suite_command: "node mod.test.js" }, gates: { G12: { mode: "block" } } }),
      "save.js": `module.exports=async()=>{await db()};\n`,
    },
    headFiles: {
      "save.js": `module.exports=async()=>{try{await db()}catch(e){}};\n`, // the alarm muted
      "mod.js": modReturning(2),
      "mod.test.js": testAsserting(2),
    },
  });
  const r = runVerify({ dir, base, head, prBody: "closes #1" });
  assert.equal(r.verdict, "BLOCK");
  assert.match(r.reason, /G12 fix the cause/);
});

test("G12 scope: a non-fix-claim PR is not asked (feature work removes code legitimately)", () => {
  const { dir, base, head } = makeRepoOps({
    baseFiles: { ...FIX, "auth.js": `module.exports=(ok)=>{if(!ok)throw new Error("forbidden");return 1};\n` },
    headFiles: {
      "auth.js": `module.exports=(ok)=>{return 1};\n`,
      "mod.js": modReturning(2),
      "mod.test.js": testAsserting(2),
    },
  });
  const r = runVerify({ dir, base, head, prBody: "work-type: feature" });
  assert.ok(!r.warnings.some((w) => /G12/.test(w)),
    `G12 is a fix-claim assist only: ${JSON.stringify(r.warnings)}`);
});
