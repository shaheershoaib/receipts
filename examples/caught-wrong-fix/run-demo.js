#!/usr/bin/env node
"use strict";
/*
 * The founding scar, replayed live: a "modal is cut off" report, mis-read as a HEIGHT
 * problem when the real bug is WIDTH. The wrong fix ships a height cap plus a test that
 * proves... the height cap. Everything is green. The bug is still there.
 *
 * This demo builds two throwaway git repos and runs the REAL enforcer on both PRs:
 *
 *   PR 1 (the wrong fix)  - caps the height, carries a height-cap test.
 *                           The test PASSES on base (the height was never the symptom),
 *                           so the enforcer rejects it: "weak receipt".
 *   PR 2 (the right fix)  - widens the modal, carries a test asserting the WIDTH the
 *                           reporter needs. Red on base, green on head -> PASS.
 *
 * Zero dependencies. Run from the repo root:  node examples/caught-wrong-fix/run-demo.js
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VERIFY = path.join(__dirname, "..", "..", "enforcer", "verify.js");

const CONFIG = JSON.stringify({
  version: 1,
  claim: { issue_link: "closes #(\\d+)", downgrade_tags: ["unverified-reasoned", "speculative", "reverted"] },
  build: { sha_source: "none", platform: "none" },
  verify: { test_command: "node {test}", suite_command: "node modal.test.js" },
  degrade: { on_no_receipt: "require-downgrade-tag" },
  gates: { medium: "web", enabled: "all", disabled: ["G4", "G5"], G14: { max_mutants: 2 } },
}, null, 2);

// The buggy modal: 300px wide - the reporter's content needs 500. Height is fine.
const MODAL_BUGGY = `module.exports = { width: 300, maxHeight: 800 };\n`;

function sh(dir, cmd, args) {
  return execFileSync(cmd, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-demo-"));
  sh(dir, "git", ["init", "-q"]);
  sh(dir, "git", ["config", "user.email", "demo@receipts.local"]);
  sh(dir, "git", ["config", "user.name", "receipts-demo"]);
  sh(dir, "git", ["config", "commit.gpgsign", "false"]);
  const write = (fset) => { for (const [rel, c] of Object.entries(fset)) fs.writeFileSync(path.join(dir, rel), c); };
  write(files.base);
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "base (the reported bug is live)"]);
  const base = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
  write(files.head);
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "the fix PR"]);
  const head = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
  return { dir, base, head };
}
function enforce({ dir, base, head }) {
  try {
    return sh(process.cwd(), "node", [VERIFY, "--base", base, "--head", head, "--repo", dir, "--pr-body", "closes #7"]);
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}
const rule = (t) => console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);

rule("The report: \"the modal is cut off\" (issue #7). Real cause: too NARROW.");

// ---- PR 1: the wrong fix ---------------------------------------------------------
rule("PR 1 - the WRONG fix: reads the report as a height clip, caps the height,\nand carries a test that proves the height cap. Everything looks green.");
const wrong = repo({
  base: {
    "receipts.config.json": CONFIG,
    "modal.js": MODAL_BUGGY,
    "modal.test.js": `const m = require("./modal"); if (m.maxHeight > 900) process.exit(1); console.log("suite ok");\n`,
  },
  head: {
    // "fixed": height capped harder. Width untouched - the symptom is still there.
    "modal.js": `module.exports = { width: 300, maxHeight: 700 };\n`,
    "height-cap.test.js": `const m = require("./modal"); if (m.maxHeight > 800) { console.error("height uncapped"); process.exit(1); } console.log("height capped");\n`,
  },
});
console.log(enforce(wrong));
console.log(">>> The height-cap test PASSES on the buggy base - it never reproduced the");
console.log(">>> reported symptom, so it proves nothing about it. The enforcer refuses the");
console.log(">>> claim. This exact wrong-axis fix shipped once with every check green;");
console.log(">>> only the reporter caught it. Now the PR gate does.");

// ---- PR 2: the right fix ---------------------------------------------------------
rule("PR 2 - the RIGHT fix: reproduces the reporter's symptom first (G0). The test\npins the EXACT width (not 'wider than before') - red on the bug, green on the\nfix, and it survives G14 deliberately breaking the fixed line.");
const right = repo({
  base: {
    "receipts.config.json": CONFIG,
    "modal.js": MODAL_BUGGY,
    "modal.test.js": `const m = require("./modal"); if (m.maxHeight > 900) process.exit(1); console.log("suite ok");\n`,
  },
  head: {
    "modal.js": `module.exports = { width: 520, maxHeight: 800 };\n`,
    "modal-width.test.js": `const m = require("./modal"); if (m.width !== 520) { console.error("expected width 520, got " + m.width); process.exit(1); } console.log("width ok: " + m.width);\n`,
  },
});
console.log(enforce(right));
console.log(">>> Red on base (the symptom reproduced), green on head (the symptom gone),");
console.log(">>> full suite green (G9). That is a receipt. That is the whole product.\n");
