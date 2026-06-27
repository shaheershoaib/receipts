#!/usr/bin/env node
"use strict";
/*
 * receipts CLI
 *
 * `receipts init` detects a project's plumbing (how it tests, where it deploys,
 * what marks a fix-claim) AND its loop-skill harnesses (the skills that drive the
 * trajectory-kb and that the Stop hooks watch), confirms with you, writes
 * receipts.config.json, and - if the project has no fix/build loop skill - scaffolds
 * one from the bundled template so a clean install reaches parity with no hand-edits.
 *
 * `receipts doctor` re-detects and reports drift against the current config.
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
                              (+ scaffold a loop-skill harness if none exists)
  receipts doctor [options]   Re-detect and report drift against receipts.config.json

Options:
  --dir <path>   Target repo (default: current directory)
  --yes, -y      Accept detected values, skip prompts (CI / scripted)
  --print        Print the config to stdout, do not write a file (init)
  --force        Overwrite an existing receipts.config.json (init)
  --no-scaffold  Do not scaffold a loop-skill harness even if none is found (init)
  --help, -h     Show this help
`;

const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { const t = readText(p); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const dedupe = (arr) => [...new Set(arr.filter(Boolean))];

// Detect the project's plumbing + loop-skill harnesses from on-disk artifacts.
// Never throws.
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
  } else if (has("manage.py")) {
    stack = "django"; suite_command = "python manage.py test"; test_command = "python manage.py test {test}";
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

  // --- loop-skill harnesses (the skills that drive the trajectory-kb + the hooks
  //     watch). Scan .claude/skills/*/SKILL.md; a skill whose name or body reads
  //     like a fix/build loop is a candidate. ---
  let loop_skills = [];
  const skillsDir = at(".claude/skills");
  try {
    for (const name of fs.readdirSync(skillsDir)) {
      const sk = path.join(skillsDir, name, "SKILL.md");
      if (!exists(sk)) continue;
      // Scan the NAME + the frontmatter description only - the body has incidental
      // keywords ("fix"/"build") that over-match (an audit skill is not a loop).
      const txt = readText(sk) || "";
      const fm = (txt.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/) || ["", ""])[1];
      const desc = ((fm.match(/description:\s*([\s\S]*)/i) || ["", ""])[1] || "").slice(0, 400);
      const nameHay = name.toLowerCase();
      if (/loop|retest|feedback|parity|cycle/.test(nameHay + " " + desc.toLowerCase()) || /fix/.test(nameHay)) {
        loop_skills.push(name);
      }
    }
  } catch { /* no .claude/skills dir */ }

  const repo_name = (pkg && pkg.name) || path.basename(dir);
  return { stack, test_command, suite_command, platform, sha_source, deploy_host_patterns, loop_skills, repo_name };
}

function buildConfig(d, a) {
  const cfg = {
    version: 1,
    claim: {
      issue_link: "closes #(\\d+)",
      downgrade_tags: ["unverified-reasoned", "speculative", "reverted"],
    },
    build: {
      sha_source: d.sha_source,
      platform: d.platform,
      deploy_host_patterns: dedupe([...(d.deploy_host_patterns || []), ...(a.extra_hosts || [])]),
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
    agent: {
      // "seven-gates" (the shipped loop) is always watched; project loops merge in.
      loop_skills: dedupe(["seven-gates", ...(a.loop_skills || d.loop_skills || [])]),
      staging_query_patterns: a.staging_query_patterns || [],
      closeout_fixed_statuses: a.closeout_fixed_statuses || ["Pending Retest", "Verified"],
      repo_name: a.repo_name || d.repo_name,
    },
  };
  // Agent-home (skills + cwd, no tests and no deploy): keep only version/claim/agent;
  // the enforcer config (build/verify) belongs in the code repos.
  if (!(a.test_command || d.test_command) && d.platform === "none") {
    delete cfg.build; delete cfg.verify; delete cfg.degrade;
    delete cfg.agent.repo_name; // no single repo at the agent home; each append names its repo
  }
  return cfg;
}

// Fill the bundled loop-skill template and write it into the project's skills dir.
function scaffoldHarness(dir, vars) {
  const tmplPath = path.join(__dirname, "..", "plugin", "templates", "loop-skill", "SKILL.md.tmpl");
  let tmpl = readText(tmplPath);
  if (!tmpl) return null;
  for (const [k, v] of Object.entries(vars)) tmpl = tmpl.split(`{{${k}}}`).join(v);
  const outDir = path.join(dir, ".claude", "skills", vars.loop_name);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "SKILL.md");
    if (exists(outPath)) return outPath; // don't clobber an existing skill
    fs.writeFileSync(outPath, tmpl);
    return outPath;
  } catch { return null; }
}

const ask = (rl, q, def) =>
  new Promise((res) => rl.question(def ? `${q} [${def}] ` : `${q} `, (x) => res((x || "").trim() || def || "")));
const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

async function init(opts) {
  const dir = path.resolve(opts.dir || process.cwd());
  if (!exists(dir)) { console.error(`No such directory: ${dir}`); process.exit(1); }
  const outPath = path.join(dir, "receipts.config.json");
  if (exists(outPath) && !opts.force && !opts.print) {
    console.error("receipts.config.json already exists. Re-run with --force to overwrite, --print to preview, or `receipts doctor` to check drift.");
    process.exit(1);
  }

  const d = detect(dir);
  // Agent-home = skills + session cwd with no tests and no deploy (e.g. a skills
  // project separate from the code repos): write an agent-only config (no build/verify).
  const agentHome = !d.test_command && d.platform === "none";
  // Diagnostics go to stderr so --print keeps stdout pure JSON.
  console.error(`receipts init - scanning ${dir}\n`);
  console.error("  detected:");
  console.error(`    stack       ${d.stack || (agentHome ? "agent-home (skills, no code)" : "unknown")}`);
  console.error(`    tests       ${d.test_command || (agentHome ? "none here (enforcer config lives in the code repos)" : "NOT DETECTED (you'll set verify.test_command)")}`);
  console.error(`    deploy      ${d.platform === "none" ? "none" : d.platform}`);
  console.error(`    loop skills ${d.loop_skills.length ? d.loop_skills.join(", ") : "none found (seven-gates ships with the plugin)"}`);
  console.error("");

  const a = {};
  if (!opts.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      if (!d.test_command && !agentHome) a.test_command = await ask(rl, "How do you run ONE test? (use {test} for the path)", "");
      if (d.platform !== "none") {
        const env = await ask(rl, "Which environment should receipts re-verify on?", "staging");
        const url = await ask(rl, `URL of '${env}'? (blank to fill in later)`, "");
        a.verify_against = env;
        if (url) a.environments = { [env]: url };
      }
      // Loop-skill harnesses: which skills the trajectory hooks watch + that drive the kb.
      const loopDef = dedupe(["seven-gates", ...d.loop_skills]).join(", ");
      a.loop_skills = list(await ask(rl, "Which skills are your fix/build loops? (comma-separated)", loopDef));
      // Offer to scaffold one if the project has no loop skill of its own.
      const hasProjectLoop = a.loop_skills.some((s) => s !== "seven-gates");
      if (!hasProjectLoop && !opts["no-scaffold"]) {
        const yn = await ask(rl, `No project loop skill found. Scaffold one (${d.repo_name}-fix-loop) from the template?`, "Y");
        if (/^y(es)?$/i.test(yn)) a._scaffold = true;
      }
      const xh = list(await ask(rl, "Extra deploy/prod hosts beyond detected? (comma-separated, blank to skip)", ""));
      if (xh.length) a.extra_hosts = xh;
      const sq = list(await ask(rl, "By-value query hosts/tools (e.g. a DB proxy host)? (blank to skip)", ""));
      if (sq.length) a.staging_query_patterns = sq;
      const go = await ask(rl, "Write receipts.config.json with the above?", "Y");
      if (!/^y(es)?$/i.test(go)) { console.error("Aborted."); rl.close(); process.exit(1); }
    } finally { rl.close(); }
  } else {
    // --yes: register the shipped loop + any detected project loops; scaffold if none.
    a.loop_skills = dedupe(["seven-gates", ...d.loop_skills]);
    if (!d.loop_skills.length && !opts["no-scaffold"]) a._scaffold = true;
  }

  // Scaffold the harness (before building config, so we can register its name).
  if (a._scaffold && !opts.print) {
    const loop_name = `${d.repo_name}-fix-loop`;
    const written = scaffoldHarness(dir, {
      loop_name,
      repo_name: d.repo_name,
      test_command: d.test_command || a.test_command || "<your test command>",
      platform: d.platform,
      verify_against_url:
        (a.environments && a.verify_against && a.environments[a.verify_against]) ||
        "your deployed build",
    });
    if (written) {
      a.loop_skills = dedupe([...(a.loop_skills || []), loop_name]);
      console.error(`\nScaffolded loop-skill harness: ${written}`);
    }
  }

  const json = JSON.stringify(buildConfig(d, a), null, 2) + "\n";
  if (opts.print) { process.stdout.write(json); return; }
  fs.writeFileSync(outPath, json);
  JSON.parse(fs.readFileSync(outPath, "utf8")); // round-trip validate
  console.error(`\nWrote ${outPath}`);
  if (agentHome) {
    console.error("Agent-home config (skills + cwd, no build/verify). The Stop hooks read it for");
    console.error("loop skills / hosts / fixed-statuses. Put it at ~/.claude/receipts.config.json to");
    console.error("apply across every session, or in the project root. Run init in your CODE repos");
    console.error("too - there it writes the enforcer's verify/build config.");
  } else {
    console.error("Review it, then commit. The Stop hooks read it (loop skills, hosts, fixed-statuses);");
    console.error("the enforcer reads it (test command, sha source). Each fix still carries its own red->green receipt.");
  }
}

function doctor(opts) {
  const dir = path.resolve(opts.dir || process.cwd());
  const cfg = readJson(path.join(dir, "receipts.config.json"));
  if (!cfg) { console.error("No receipts.config.json here - run `receipts init`."); process.exit(1); }
  const d = detect(dir);
  const drift = [];
  if (d.test_command && cfg.verify && cfg.verify.test_command && d.test_command !== cfg.verify.test_command)
    drift.push(`test_command: config "${cfg.verify.test_command}" vs detected "${d.test_command}"`);
  if (!cfg.verify || !cfg.verify.test_command || /REPLACE_ME/.test(cfg.verify.test_command || ""))
    drift.push("verify.test_command is unset/placeholder");
  if (d.platform !== "none" && cfg.build && d.platform !== cfg.build.platform)
    drift.push(`platform: config "${cfg.build.platform}" vs detected "${d.platform}"`);
  const cfgLoops = (cfg.agent && cfg.agent.loop_skills) || [];
  const missing = (d.loop_skills || []).filter((s) => !cfgLoops.includes(s));
  if (missing.length) drift.push(`loop skills on disk but not in config.agent.loop_skills: ${missing.join(", ")}`);
  if (!cfg.agent) drift.push("config has no `agent` block - the Stop hooks will use generic defaults (re-init to bind project loops/hosts)");

  if (!drift.length) { console.error("receipts doctor: config looks current."); return; }
  console.error("receipts doctor: drift detected:\n  - " + drift.join("\n  - ") + "\n\nRe-run `receipts init --force` to refresh.");
  process.exit(2);
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dir") o.dir = argv[++i];
    else if (x === "--yes" || x === "-y") o.yes = true;
    else if (x === "--print") o.print = true;
    else if (x === "--force") o.force = true;
    else if (x === "--no-scaffold") o["no-scaffold"] = true;
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
  if (cmd === "doctor") return doctor(o);
  console.error(`Unknown command: ${cmd}\n`);
  process.stdout.write(HELP);
  process.exit(1);
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
