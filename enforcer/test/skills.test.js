"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/*
 * Every shipped skill must have parseable frontmatter with a name + description. A skill
 * whose frontmatter does not parse is not loaded by the agent AND raises no error - it just
 * silently is not there, which is the worst failure mode for a guardrail tool.
 */

const SKILLS_DIR = path.join(__dirname, "..", "..", "plugin", "skills");

const skills = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

test("the plugin ships both the gates discipline and the setup flow", () => {
  assert.ok(skills.includes("gates"), "gates skill missing");
  assert.ok(skills.includes("setup"), "setup skill missing - install/update/init has no entry point");
});

for (const name of skills) {
  test(`skill "${name}" has valid frontmatter`, () => {
    const p = path.join(SKILLS_DIR, name, "SKILL.md");
    assert.ok(fs.existsSync(p), `${name}/SKILL.md missing`);
    const raw = fs.readFileSync(p, "utf8");
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(m, `${name}: frontmatter block does not parse - the skill would silently never load`);
    const fm = m[1];
    const declared = /^name:\s*(\S+)\s*$/m.exec(fm);
    assert.ok(declared, `${name}: no name: field`);
    assert.equal(declared[1], name, `${name}: frontmatter name must match the directory`);
    const desc = /^description:\s*([\s\S]*)$/m.exec(fm);
    assert.ok(desc && desc[1].replace(/\s+/g, " ").trim().length > 40,
      `${name}: description missing or too short to trigger reliably`);
  });
}

test("the setup skill's description covers the phrases a user actually says", () => {
  const raw = fs.readFileSync(path.join(SKILLS_DIR, "setup", "SKILL.md"), "utf8");
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)[1].toLowerCase();
  for (const phrase of ["install receipts", "update receipts", "set up receipts", "doctor", "receipts init"])
    assert.ok(fm.includes(phrase), `setup description should mention "${phrase}"`);
});

test("the setup skill documents the relayed-answer flags, not a readline it cannot drive", () => {
  const body = fs.readFileSync(path.join(SKILLS_DIR, "setup", "SKILL.md"), "utf8");
  for (const flag of ["--drive-auth", "--drive-bypass", "--drive-data", "--drive-browser-surfaces"])
    assert.ok(body.includes(flag), `setup skill must document ${flag}`);
  // and the flags it names must actually exist in the CLI
  const cli = fs.readFileSync(path.join(__dirname, "..", "..", "bin", "receipts.js"), "utf8");
  for (const flag of ["--drive-auth", "--drive-bypass", "--drive-data", "--drive-browser-surfaces", "--env", "--env-url"])
    assert.ok(cli.includes(`"${flag}"`), `bin/receipts.js must parse ${flag} - the skill tells agents to use it`);
});

test("the setup skill tells you how to GET the CLI it invokes", () => {
  // The plugin ships skills/hooks/mcp - NOT bin/receipts.js. On a machine that installed
  // only the plugin, `receipts` is not on PATH, so a skill that says "run receipts init"
  // without saying where the command comes from fails at the first step of the flow it owns.
  const body = fs.readFileSync(path.join(SKILLS_DIR, "setup", "SKILL.md"), "utf8");
  assert.match(body, /receipts-cli/,
    "setup must name the npm package that provides the CLI");
  assert.match(body, /npx\s+-y\s+receipts-cli/,
    "setup must give a no-install invocation (npx), since the plugin does not ship the CLI");
  assert.match(body, /command -v receipts/,
    "setup should check whether the CLI is already on PATH before assuming either form");
});

test("the plugin genuinely does not ship the CLI (the reason the above matters)", () => {
  const pluginRoot = path.join(__dirname, "..", "..", "plugin");
  assert.ok(!fs.existsSync(path.join(pluginRoot, "bin")),
    "if the plugin ever DOES ship bin/, revisit the setup skill's CLI-availability section");
});
