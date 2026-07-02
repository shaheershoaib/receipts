#!/usr/bin/env node
"use strict";
/*
 * Generate the agent-agnostic adapters from the ONE source of truth (the gates skill).
 *
 * The enforcer is already agent-agnostic - it gates the PR no matter who wrote the
 * code. The teaching layer should be too: the same discipline, pasted into whatever
 * rules file an agent reads (AGENTS.md / CLAUDE.md, Cursor rules). Generated, never
 * hand-edited, so it cannot drift from the skill.
 *
 *   npm run build:adapters
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const skillRaw = fs.readFileSync(path.join(ROOT, "plugin/skills/gates/SKILL.md"), "utf8");

// Strip the Claude-Code skill frontmatter; the body is the portable discipline.
const body = skillRaw.replace(/^---\s*[\r\n][\s\S]*?[\r\n]---\s*[\r\n]/, "");

const banner = (target) =>
  `<!-- GENERATED from plugin/skills/gates/SKILL.md by scripts/build-adapters.js - do not hand-edit.\n     Target: ${target}. Regenerate with: npm run build:adapters -->\n\n`;

const trigger =
  "When fixing a bug, addressing tester or issue feedback, or about to claim a change " +
  "is \"done\" / \"fixed\" / \"working\", follow the Gates below and produce a RECEIPT - " +
  "a re-runnable acceptance test that is red before the fix and green after, asserting " +
  "the reported symptom. A fix is not done because you say so; it is done when the " +
  "symptom is observably gone.\n\n";

fs.mkdirSync(path.join(ROOT, "adapters/cursor"), { recursive: true });

// AGENTS.md / CLAUDE.md snippet - paste (or @-include) into any agent's rules file.
fs.writeFileSync(
  path.join(ROOT, "adapters/AGENTS.md"),
  banner("AGENTS.md / CLAUDE.md - any agent that reads a rules file") + trigger + body
);

// Cursor project rule (.cursor/rules/receipts.mdc).
fs.writeFileSync(
  path.join(ROOT, "adapters/cursor/receipts.mdc"),
  `---
description: The receipts Gates - produce a red->green receipt before claiming any fix/change is done; never game the referee.
alwaysApply: true
---

` + banner("Cursor - copy to .cursor/rules/receipts.mdc") + trigger + body
);

console.log("adapters generated: adapters/AGENTS.md, adapters/cursor/receipts.mdc");
