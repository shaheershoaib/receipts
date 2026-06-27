#!/usr/bin/env node
"use strict";
/*
 * receipts CLI
 *
 * `receipts init` detects a project's plumbing (how it tests, where it deploys,
 * what marks a fix-claim), confirms with you, and writes receipts.config.json.
 *
 * Zero dependencies - Node built-ins only - so it runs with `npx receipts` or a
 * bare `node bin/receipts.js` and never needs an install step.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const HELP = `receipts - verification gates for AI-written code

Usage:
  receipts init [options]     Detect this project, confirm, write receipts.config.json

Options:
  --dir <path>   Target repo (default: current directory)
  --yes, -y      Accept detected values, skip prompts (CI / scripted)
  --print        Print the config to stdout, do not write a file
  --force        Overwrite an existing receipts.config.json
  --help, -h     Show this help
`;

const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { const t = readText(p); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// Detect the project's plumbing from on-disk artifacts. Never throws.
function detect(dir) {
  const at = (f) => path.join(dir, f);
  const has = (f) => exists(at(f));

  // --- test runner ---
  let stack = null, test_command = null, suite_command = null;
  const pkg = readJson(at("package.json"));
  if (pkg && pkg.scripts && pkg.scripts.test) {
    const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    stack = "node";
    suite_command = `${runner} test`;
    test_command = runner === "npm" ? "npm test -- {test}" : `${runner} test {test}`;
  } else if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg") || has("tox.ini")) {
    stack = "python"; suite_command = "pytest"; test_command = "pytest {test}";
  } else if (has("go.mod")) {
    stack = "go"; suite_command = "go test ./..."; test_command = "go test -run {test} ./...";
  } else if (has("Gemfile")) {
    stack = "ruby"; suite_command = "bundle exec rspec"; test_command = "bundle exec rspec {test}";
  } else if (has("Cargo.toml")) {
    stack = "rust"; suite_command = "cargo test"; test_command = "cargo test {test}";
  } else if (has("Makefile") && /(^|\n)test:/.test(readText(at("Makefile")) || "")) {
    stack = "make"; suite_command = "make test"; test_command = "make test";
  }

  // --- deploy platform ---
  let platform = "none", sha_source = "none", deploy_host_patterns = [];
  const platforms = [
    ["vercel",  () => has("vercel.json") || has(".vercel"),            ["*.vercel.app"]],
    ["railway", () => has("railway.json") || has("railway.toml"),      ["*.up.railway.app", "*.railway.app"]],
    ["netlify", () => has("netlify.toml"),                            ["*.netlify.app"]],
    ["fly",     () => has("fly.toml"),                                ["*.fly.dev"]],
    ["render",  () => has("render.yaml"),                             ["*.onrender.com"]],
  ];
  for (const [name, test, hosts] of platforms) {
    if (test()) { platform = name; deploy_host_patterns = hosts; break; }
  }
  if (platform !== "none") sha_source = "github-deployments";

  return { stack, test_command, suite_command, platform, sha_source, deploy_host_patterns };
}

function buildConfig(d, a) {
  return {
    version: 1,
    claim: {
      issue_link: "closes #(\\d+)",
      downgrade_tags: ["unverified-reasoned", "speculative", "reverted"],
    },
    build: {
      sha_source: d.sha_source,
      platform: d.platform,
      deploy_host_patterns: d.deploy_host_patterns,
      environments: a.environments || {},
      verify_against: a.verify_against || (d.platform !== "none" ? "staging" : "none"),
    },
    verify: {
      test_command: a.test_command || d.test_command || "REPLACE_ME: how to run ONE acceptance test (use {test} for the path)",
      suite_command: d.suite_command || null,
      live_drive: null,
    },
    degrade: {
      on_no_receipt: "require-downgrade-tag",
      on_unreachable_build: "sha-bind-only",
    },
  };
}

const ask = (rl, q, def) =>
  new Promise((res) => rl.question(def ? `${q} [${def}] ` : `${q} `, (x) => res((x || "").trim() || def || "")));

async function init(opts) {
  const dir = path.resolve(opts.dir || process.cwd());
  if (!exists(dir)) { console.error(`No such directory: ${dir}`); process.exit(1); }
  const outPath = path.join(dir, "receipts.config.json");
  if (exists(outPath) && !opts.force && !opts.print) {
    console.error("receipts.config.json already exists. Re-run with --force to overwrite, or --print to preview.");
    process.exit(1);
  }

  const d = detect(dir);
  // Diagnostics go to stderr so --print keeps stdout pure JSON.
  console.error(`receipts init - scanning ${dir}\n`);
  console.error("  detected:");
  console.error(`    stack    ${d.stack || "unknown"}`);
  console.error(`    tests    ${d.test_command || "NOT DETECTED (you'll set verify.test_command)"}`);
  console.error(`    deploy   ${d.platform === "none" ? "none (library/CLI: verify against build + tests)" : d.platform}`);
  console.error("");

  const a = {};
  if (!opts.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      if (!d.test_command) a.test_command = await ask(rl, "How do you run ONE test? (use {test} for the path)", "");
      if (d.platform !== "none") {
        const env = await ask(rl, "Which environment should receipts re-verify on?", "staging");
        const url = await ask(rl, `URL of '${env}'? (blank to fill in later)`, "");
        a.verify_against = env;
        if (url) a.environments = { [env]: url };
      }
      const go = await ask(rl, "Write receipts.config.json with the above?", "Y");
      if (!/^y(es)?$/i.test(go)) { console.error("Aborted."); rl.close(); process.exit(1); }
    } finally { rl.close(); }
  }

  const json = JSON.stringify(buildConfig(d, a), null, 2) + "\n";
  if (opts.print) { process.stdout.write(json); return; }
  fs.writeFileSync(outPath, json);
  JSON.parse(fs.readFileSync(outPath, "utf8")); // round-trip validate
  console.error(`\nWrote ${outPath}`);
  console.error("Review it, then commit. Each fix still carries its own red->green receipt.");
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dir") o.dir = argv[++i];
    else if (x === "--yes" || x === "-y") o.yes = true;
    else if (x === "--print") o.print = true;
    else if (x === "--force") o.force = true;
    else if (x === "--help" || x === "-h") o.help = true;
    else o._.push(x);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0];
  if (o.help || !cmd) { process.stdout.write(HELP); return; }
  if (cmd === "init") return init(o);
  console.error(`Unknown command: ${cmd}\n`);
  process.stdout.write(HELP);
  process.exit(1);
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
