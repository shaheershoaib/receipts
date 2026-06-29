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
const { spawnSync } = require("child_process");

const HELP = `receipts - verification gates for AI-written code

Usage:
  receipts init [options]      Detect this project, confirm, write receipts.config.json
                               (+ scaffold a loop-skill harness if none exists)
  receipts doctor [options]    Re-detect and report drift against receipts.config.json
  receipts verify [args]       Run the enforcer locally: re-prove a fix-claim's receipt
                               (red on base, green on head). Same args as the CI action:
                               --base <sha> --head <sha> [--repo <dir>] [--config <path>]
                               [--pr-body <text> | --pr-body-file <path>] [--json]
                               [--receipt-out <path>]
  receipts replay <receipt>    Re-run the verification recorded in a receipt and check the
                               verdict reproduces (exit 1 on mismatch). [--repo <dir>]
  receipts explain <receipt>   Print a human-readable summary of a receipt artifact

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
  const hasExt = (ext) => { try { return fs.readdirSync(dir).some((f) => f.endsWith(ext)); } catch { return false; } };

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
  } else if (has("pom.xml")) {
    stack = "maven"; suite_command = "mvn test"; test_command = "mvn -Dtest={test} test";
  } else if (has("build.gradle") || has("build.gradle.kts")) {
    stack = "gradle"; suite_command = "gradle test"; test_command = "gradle test --tests {test}";
  } else if (hasExt(".csproj") || hasExt(".sln") || hasExt(".fsproj")) {
    stack = "dotnet"; suite_command = "dotnet test"; test_command = "dotnet test --filter {test}";
  } else if (has("composer.json")) {
    stack = "php"; suite_command = "vendor/bin/phpunit"; test_command = "vendor/bin/phpunit {test}";
  } else if (has("mix.exs")) {
    stack = "elixir"; suite_command = "mix test"; test_command = "mix test {test}";
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
    ["cloudflare", () => has("wrangler.toml") || has("wrangler.jsonc") || has("wrangler.json"), ["*.workers.dev", "*.pages.dev"]],
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

  // --- default/integration branch (for G8 fresh-base): current branch from .git/HEAD ---
  let default_branch = "main";
  const head = readText(at(".git/HEAD"));
  const bm = head && head.match(/ref:\s*refs\/heads\/(\S+)/);
  if (bm) default_branch = bm[1];

  // --- medium (best-effort software-type guess; the agent confirms + applies each
  //     gate in this medium's terms via references/MEDIA.md). Honest: a guess. ---
  const deps = pkg ? Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies) : {};
  const anyDep = (...ns) => ns.some((n) => Object.prototype.hasOwnProperty.call(deps, n));
  let medium = "unknown";
  if (has("main.tf") || hasExt(".tf") || has("Chart.yaml") || has("kustomization.yaml") || has("Pulumi.yaml")) medium = "infra";
  else if (has("dbt_project.yml") || has("dbt_project.yaml")) medium = "data";
  else if (has("pubspec.yaml") || anyDep("react-native", "expo") || (has("android") && has("ios"))) medium = "mobile";
  else if (anyDep("electron")) medium = "desktop";
  else if (anyDep("react", "next", "vue", "nuxt", "svelte", "@sveltejs/kit", "@angular/core", "solid-js", "astro", "gatsby") || has("index.html")) medium = "web";
  else if (anyDep("express", "fastify", "@nestjs/core", "koa", "@hapi/hapi", "fastapi", "flask", "django") || has("manage.py") || stack === "django") medium = "api";
  else if (pkg && pkg.bin) medium = "cli";
  else if (has("Cargo.toml")) medium = /\[\[bin\]\]/.test(readText(at("Cargo.toml")) || "") ? "cli" : "library";
  else if (has("go.mod")) { let cmd = false; try { cmd = has("main.go") || fs.readdirSync(dir).includes("cmd"); } catch { /* ignore */ } medium = cmd ? "cli" : "library"; }
  else if (pkg && (pkg.main || pkg.exports || pkg.module) && !pkg.private && platform === "none") medium = "library";
  else if (platform !== "none") medium = "service";

  return { stack, test_command, suite_command, platform, sha_source, deploy_host_patterns, loop_skills, repo_name, default_branch, medium };
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
      // "gates" (the shipped loop) is always watched; project loops merge in.
      loop_skills: dedupe(["gates", ...(a.loop_skills || d.loop_skills || [])]),
      staging_query_patterns: a.staging_query_patterns || [],
      closeout_fixed_statuses: a.closeout_fixed_statuses || ["Pending Retest", "Verified"],
      repo_name: a.repo_name || d.repo_name,
    },
  };
  // Which gates apply here (by ID). Safe default = all on; the project disables what
  // does not fit. The skill reads this to know what to apply; the enforcer, which checks to run.
  cfg.gates = {
    medium: a.medium || d.medium || "unknown",
    enabled: "all",
    disabled: a.gates_disabled || [],
    G8: { integration_branch: a.integration_branch || d.default_branch || "main" },
  };
  // Agent-home (skills + cwd, no tests and no deploy): keep only version/claim/agent;
  // the enforcer config (build/verify/gates) belongs in the code repos.
  if (!(a.test_command || d.test_command) && d.platform === "none") {
    delete cfg.build; delete cfg.verify; delete cfg.degrade; delete cfg.gates;
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
  if (!agentHome) console.error(`    medium      ${d.medium} (gates apply in this software type's terms - see references/MEDIA.md)`);
  console.error(`    loop skills ${d.loop_skills.length ? d.loop_skills.join(", ") : "none found (gates ships with the plugin)"}`);
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
      const loopDef = dedupe(["gates", ...d.loop_skills]).join(", ");
      a.loop_skills = list(await ask(rl, "Which skills are your fix/build loops? (comma-separated)", loopDef));
      // Offer to scaffold one if the project has no loop skill of its own.
      const hasProjectLoop = a.loop_skills.some((s) => s !== "gates");
      if (!hasProjectLoop && !opts["no-scaffold"]) {
        const yn = await ask(rl, `No project loop skill found. Scaffold one (${d.repo_name}-fix-loop) from the template?`, "Y");
        if (/^y(es)?$/i.test(yn)) a._scaffold = true;
      }
      const xh = list(await ask(rl, "Extra deploy/prod hosts beyond detected? (comma-separated, blank to skip)", ""));
      if (xh.length) a.extra_hosts = xh;
      const sq = list(await ask(rl, "By-value query hosts/tools (e.g. a DB proxy host)? (blank to skip)", ""));
      if (sq.length) a.staging_query_patterns = sq;
      // Gate applicability (G0-G10): default all-on; disable what does not fit this project.
      if (!agentHome) {
        a.medium = await ask(rl, "Project type / medium? (web/api/library/cli/data/infra/mobile/desktop/...)", d.medium);
        a.integration_branch = await ask(rl, "Integration branch for fresh-base checks (G8)?", d.default_branch || "main");
        const dis = list(await ask(rl, "Gates to disable here? (comma-sep IDs, e.g. G10 if no separate repo consumes it, G4/G5 for a pure library)", ""));
        if (dis.length) a.gates_disabled = dis;
      }
      const go = await ask(rl, "Write receipts.config.json with the above?", "Y");
      if (!/^y(es)?$/i.test(go)) { console.error("Aborted."); rl.close(); process.exit(1); }
    } finally { rl.close(); }
  } else {
    // --yes: register the shipped loop + any detected project loops; scaffold if none.
    a.loop_skills = dedupe(["gates", ...d.loop_skills]);
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

const ENFORCER = path.join(__dirname, "..", "enforcer", "verify.js");

// `receipts verify` - run the enforcer engine locally, same args as the CI action. Pass the
// args straight through so the CLI and the action share ONE engine (no drift).
function verify(rest) {
  if (!exists(ENFORCER)) { console.error(`enforcer engine not found at ${ENFORCER}`); process.exit(1); }
  const r = spawnSync(process.execPath, [ENFORCER, ...rest], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

const flagVal = (rest, name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
const firstPositional = (rest) => rest.find((a) => !a.startsWith("-"));

// `receipts replay <receipt>` - re-run the recorded verification from the same commits and
// confirm the verdict reproduces. Reconstructs the trigger (fix-claim / work-type) from the
// receipt so the same path runs; the issue link uses the default `closes #N`.
function replay(rest) {
  const receiptPath = firstPositional(rest);
  if (!receiptPath) { console.error("usage: receipts replay <receipt.json> [--repo <dir>]"); process.exit(1); }
  const rec = readJson(receiptPath);
  if (!rec || !rec.base || !rec.head) { console.error(`not a receipt (missing base/head): ${receiptPath}`); process.exit(1); }
  const repo = flagVal(rest, "--repo") || rec.repo || process.cwd();
  let body = "";
  if (rec.is_fix_claim) body += "closes #1";
  if (rec.work_type) body += (body ? "\n" : "") + "work-type: " + rec.work_type;
  const a = [ENFORCER, "--json", "--base", rec.base, "--head", rec.head, "--repo", repo];
  if (body) a.push("--pr-body", body);
  const r = spawnSync(process.execPath, a, { encoding: "utf8" });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "{}";
  let now; try { now = JSON.parse(line); } catch { now = { verdict: "PARSE_ERROR", reason: r.stderr || "" }; }
  const match = now.verdict === rec.verdict;
  console.log(`receipts replay: recorded=${rec.verdict} now=${now.verdict} -> ${match ? "REPRODUCED" : "MISMATCH"}`);
  if (!match) { console.log(`  recorded: ${rec.reason || ""}`); console.log(`  now:      ${now.reason || ""}`); }
  process.exit(match ? 0 : 1);
}

// `receipts explain <receipt>` - human-readable summary of a receipt artifact.
function explain(rest) {
  const receiptPath = firstPositional(rest);
  if (!receiptPath) { console.error("usage: receipts explain <receipt.json>"); process.exit(1); }
  const rec = readJson(receiptPath);
  if (!rec) { console.error(`cannot read receipt: ${receiptPath}`); process.exit(1); }
  const sha = (s) => String(s || "").slice(0, 12) || "?";
  const out = [];
  out.push(`receipt (${rec.schema || "?"}) - ${rec.verdict || "?"}`);
  if (rec.reason) out.push(`  ${rec.reason}`);
  out.push(`  base ${sha(rec.base)}  head ${sha(rec.head)}  config:${rec.config_source || "?"}` +
    (rec.work_type ? `  work-type:${rec.work_type}` : ""));
  if (rec.red != null || rec.green != null)
    out.push(`  red (reproduced on base): ${rec.red}   green (gone on head): ${rec.green}`);
  if (Array.isArray(rec.tests) && rec.tests.length) out.push(`  receipt tests: ${rec.tests.join(", ")}`);
  for (const c of rec.commands || [])
    out.push(`  $ ${c.command}  ->  exit ${c.exit_code} (${c.duration_ms}ms)${c.timed_out ? " [TIMED OUT]" : ""}`);
  const g7 = rec.gates && rec.gates.G7;
  if (g7 && Array.isArray(g7.new_dependents) && g7.new_dependents.length)
    out.push(`  G7 new dependents: ${g7.new_dependents.map((d) => d.file).join(", ")}`);
  for (const w of rec.warnings || []) out.push(`  ! ${w}`);
  process.stdout.write(out.join("\n") + "\n");
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
  const raw = process.argv.slice(2);
  const o = parseArgs(raw);
  const cmd = o._[0];
  if (!cmd || (o.help && cmd !== "verify")) { process.stdout.write(HELP); return; }
  // Args after the command word, raw (preserves --base etc. for the passthrough commands).
  const rest = raw.slice(raw.indexOf(cmd) + 1);
  if (cmd === "init") return init(o);
  if (cmd === "doctor") return doctor(o);
  if (cmd === "verify") return verify(rest);
  if (cmd === "replay") return replay(rest);
  if (cmd === "explain") return explain(rest);
  console.error(`Unknown command: ${cmd}\n`);
  process.stdout.write(HELP);
  process.exit(1);
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
