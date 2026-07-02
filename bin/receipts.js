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
const os = require("os");
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
                               (--md: the same markdown report the GitHub Action posts)
  receipts observe [args]      Probe the LIVE build and emit a live receipt - machine-validated
                               deployed-build evidence for the Stop hook. Runs ONE probe now,
                               captures the output, evaluates met, binds it to the build, and
                               prints a single LIVE-RECEIPT: <json> line (exit 0 iff met):
                                 --cmd '<command>'  |  --url '<https url>'
                                 [--expect '/<regex>/']   assert stdout/body (else exit-0/2xx only)
                                 [--sha-cmd '<command>' | --sha <id>]   bind to the build (G3)
                                 [--out <file>]   also write the full receipt JSON there
  receipts kb <sub>            Read the trajectory memory (the append-only JSONL the trajectory-kb
                               MCP writes). Analytics over what was tried and what happened:
                                 recur   [--repo <name>] [--json]   recurrence report: group by
                                         surface_key, count + outcomes histogram + last ts + top
                                         what_failed line, most-recurring first.
                                 distill [--repo <name>] [--json]   conservative, rule-based
                                         suggestions from the data (recurring trouble spots,
                                         revert-prone repos, flaky signals). Printed, never applied.

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
    // {test} is a FILE path, but `go test -run` selects by test NAME - a path matches
    // nothing and exits 0 (a "red" that ran no test). Go selects by package: {test_dirs}.
    stack = "go"; suite_command = "go test ./..."; test_command = "go test {test_dirs}";
  } else if (has("Gemfile")) {
    stack = "ruby"; suite_command = "bundle exec rspec"; test_command = "bundle exec rspec {test}";
  } else if (has("Cargo.toml")) {
    stack = "rust"; suite_command = "cargo test"; test_command = "cargo test {test}";
  } else if (has("pom.xml")) {
    // Surefire's -Dtest= takes class names, never paths: {test_classes} (comma-joined).
    stack = "maven"; suite_command = "mvn test"; test_command = "mvn -Dtest={test_classes} test";
  } else if (has("build.gradle") || has("build.gradle.kts")) {
    // Gradle's --tests takes ONE pattern per flag (no comma list), so a multi-file receipt
    // cannot be expressed in a single template - default to the coarse full run (correct,
    // just broader); sharpen per project with --tests {test_classes} if receipts stay 1-file.
    stack = "gradle"; suite_command = "gradle test"; test_command = "gradle test";
  } else if (hasExt(".csproj") || hasExt(".sln") || hasExt(".fsproj")) {
    // dotnet --filter needs FullyQualifiedName expressions ('|'-joined), not paths - same
    // coarse-but-correct default as Gradle; see INIT.md for sharpening.
    stack = "dotnet"; suite_command = "dotnet test"; test_command = "dotnet test";
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
      // No test runner detected: don't invent a fake test_command - point at the command-receipt
      // grammar instead (a `receipt-cmd:` line IS the receipt for a runner-less API / pipeline /
      // CLI / infra repo). If you DO have a runner, replace this with how to run one test.
      test_command: a.test_command || d.test_command ||
        "REPLACE_ME: no test runner detected. If you have one, put how to run ONE test here (use {test} for the path). If you don't, delete this and use `receipt-cmd: <command>` lines in each PR body instead (see spec/RECEIPT.md - a curl/query/plan-diff, red on base + green on head).",
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
  // Team memory: only written when the project opts into the repo-local store ("home"
  // is the default and needs no config).
  if (a.trajectory_store && a.trajectory_store !== "home") {
    cfg.agent.trajectory_store = a.trajectory_store;
  }
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
  // Monorepo hint: workspaces mean per-package runners - init each package; the
  // enforcer discovers nested receipts.config.json files automatically.
  const ws = readJson(path.join(dir, "package.json"));
  if (exists(path.join(dir, "pnpm-workspace.yaml")) || (ws && ws.workspaces))
    console.error("  note: workspaces detected - run `receipts init` in each package too; the\n        enforcer picks up nested receipts.config.json files (root keeps the policy).\n");
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
      // Team memory: repo-local store = the whole team inherits every recorded trap.
      const ts = await ask(rl, "Trajectory memory store? (home = private per-machine, repo = .receipts/ committed for team sharing)", "home");
      if (ts && ts !== "home") a.trajectory_store = ts;
      const xh = list(await ask(rl, "Extra deploy/prod hosts beyond detected? (comma-separated, blank to skip)", ""));
      if (xh.length) a.extra_hosts = xh;
      const sq = list(await ask(rl, "By-value query hosts/tools (e.g. a DB proxy host)? (blank to skip)", ""));
      if (sq.length) a.staging_query_patterns = sq;
      // Gate applicability (G0-G13): default all-on; disable what does not fit this project.
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
  // Reconstruct the command receipts so replay re-runs the same `receipt-cmd:` lines (a file
  // receipt is rediscovered from the diff; a command receipt lived only in the PR body).
  for (const c of rec.command_receipts || [])
    body += (body ? "\n" : "") + "receipt-cmd: " + c.command + (c.expect != null ? ` expect:/${c.expect}/` : "");
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
// `--md` renders the same markdown report the GitHub Action posts (one renderer, no drift).
function explain(rest) {
  const receiptPath = firstPositional(rest);
  if (!receiptPath) { console.error("usage: receipts explain <receipt.json> [--md]"); process.exit(1); }
  const rec = readJson(receiptPath);
  if (!rec) { console.error(`cannot read receipt: ${receiptPath}`); process.exit(1); }
  if (rest.includes("--md")) {
    const { renderMarkdown } = require("../enforcer/render.js");
    process.stdout.write(renderMarkdown(rec));
    return;
  }
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

// `receipts observe` - probe the LIVE build NOW and emit a `receipts/live-receipt@1` artifact:
// structured, machine-validated deployed-build evidence for the Stop hook. One command so a
// weak agent can be RIGHT by running one line - it runs the probe, captures the output, computes
// `met` with the SAME red/green law a command receipt uses (exit-0/2xx floor + optional regex),
// binds the observation to the build (G3), and prints EXACTLY ONE marker line:
//   LIVE-RECEIPT: {compact single-line JSON}
// That line landing in the transcript is the hand-off to the Stop hook. Exit 0 iff met (scripts
// can branch), but the marker ALWAYS prints - a failed observation is evidence too.
const OBSERVED_MAX = 2048; // ~2KB bound on the stored output tail (evidence, not a full log)
const tailBytes = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(-n) : s; };
// Strip a leading/trailing `/` from an `--expect` value (the `/re/` grammar, like receipt-cmd's
// expect:/…/); a bare `re` with no slashes is also accepted. Returns the regex SOURCE string.
function expectSource(raw) {
  if (raw == null) return null;
  const s = String(raw);
  const m = s.match(/^\/(.*)\/$/s);
  return m ? m[1] : s;
}

async function observe(rest) {
  // meetsExpectation + masksExit come from the enforcer engine (require-safe: exports without
  // running main), so the CLI and CI share ONE definition of "met" and ONE exit-masking guard.
  const { meetsExpectation, masksExit } = require("../enforcer/verify.js");
  const cmd = flagVal(rest, "--cmd");
  const url = flagVal(rest, "--url");
  const expectRaw = flagVal(rest, "--expect");
  const shaCmd = flagVal(rest, "--sha-cmd");
  const shaLit = flagVal(rest, "--sha");
  const outFile = flagVal(rest, "--out");

  if ((cmd && url) || (!cmd && !url)) {
    console.error("usage: receipts observe (--cmd '<command>' | --url '<https url>') [--expect '/re/'] [--sha-cmd '<cmd>' | --sha <id>] [--out <file>]");
    process.exit(2);
  }
  if (shaCmd && shaLit) { console.error("receipts observe: pass --sha-cmd OR --sha, not both."); process.exit(2); }
  // A masked exit could fake met:true - reject --cmd / --sha-cmd that can hide their exit (G9),
  // the SAME guard the enforcer applies to test/receipt commands.
  if (cmd && masksExit(cmd)) {
    console.error(`receipts observe: --cmd '${cmd}' can mask its own exit code (; , || , pipe, background &, newline, or command substitution), so a met from it cannot be trusted (G9). Use a single command whose own exit is the result, or wrap it in a script.`);
    process.exit(2);
  }
  if (shaCmd && masksExit(shaCmd)) {
    console.error(`receipts observe: --sha-cmd '${shaCmd}' can mask its own exit code - the resolved artifact id cannot be trusted (G9). Use a single command, or wrap it in a script.`);
    process.exit(2);
  }
  // Compile --expect up front so a bad regex fails clearly (never mis-reads as not-met).
  const expectSrc = expectSource(expectRaw);
  let re = null;
  if (expectSrc != null) {
    try { re = new RegExp(expectSrc, "m"); }
    catch (e) { console.error(`receipts observe: --expect ${expectRaw} is not a valid regex (${e && e.message}) - fix the pattern or drop --expect (exit 0 / 2xx is the default expectation).`); process.exit(2); }
  }

  // Resolve the artifact binding (G3): run --sha-cmd (single-line id), take --sha verbatim, else
  // kind "none" (allowed but weaker - documented in spec/LIVE-RECEIPT.md).
  let artifact = { kind: "none", id: null, source: null };
  if (shaCmd) {
    const r = spawnSync(shaCmd, { shell: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const id = ((r.stdout || "").split("\n").map((l) => l.trim()).find(Boolean)) || null;
    if (r.status !== 0 || !id) {
      console.error(`receipts observe: --sha-cmd exited ${r.status == null ? "abnormally" : r.status}${id ? "" : " with no id"} - the build binding could not be resolved. Fix the command or pass --sha <id>.`);
      process.exit(2);
    }
    artifact = { kind: "deploy-sha", id, source: shaCmd };
  } else if (shaLit) {
    artifact = { kind: "deploy-sha", id: String(shaLit).trim(), source: "--sha (verbatim)" };
  }

  // Run the probe NOW.
  let probe, met, observed;
  if (cmd) {
    probe = { kind: "cmd", spec: cmd };
    const r = spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || "") + (r.stderr || "");
    // meetsExpectation's contract: { ok } = exit 0, `re` = compiled regex or null.
    met = meetsExpectation({ ok: r.status === 0, out }, re);
    observed = tailBytes(out, OBSERVED_MAX);
  } else {
    // --url: node >=18 global fetch. met = 2xx AND (regex over body if given). https only
    // (localhost http allowed for a port-forwarded staging box).
    if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) {
      console.error(`receipts observe: --url must be https:// (or http://localhost) - refusing '${url}'. A live probe reads the deployed build over TLS.`);
      process.exit(2);
    }
    probe = { kind: "url", spec: url };
    let status = 0, body = "";
    try {
      const resp = await fetch(url, { redirect: "follow" });
      status = resp.status;
      body = await resp.text();
    } catch (e) {
      status = 0;
      body = `fetch error: ${e && e.message ? e.message : e}`;
    }
    met = meetsExpectation({ ok: status >= 200 && status < 300, out: body }, re);
    observed = tailBytes(body, OBSERVED_MAX);
  }

  const receipt = {
    schema: "receipts/live-receipt@1",
    probe,
    expect: expectSrc,
    observed,
    met: !!met,
    artifact,
    generated_at: new Date().toISOString(),
  };

  if (outFile) {
    try { fs.writeFileSync(outFile, JSON.stringify(receipt, null, 2) + "\n"); }
    catch (e) { console.error(`receipts observe: could not write --out ${outFile} - ${e && e.message ? e.message : e}`); }
  }
  // The ONE marker line - the hand-off to the Stop hook. Compact single-line JSON.
  process.stdout.write("LIVE-RECEIPT: " + JSON.stringify(receipt) + "\n");
  process.exit(met ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// `receipts kb` - analytics over the trajectory memory (the append-only JSONL the
// trajectory-kb MCP writes). Read-only: recurrence reporting + conservative, rule-based
// distillation. Zero deps (Node built-ins only); store resolution is INLINED here (mirrors
// plugin/mcp/trajectory-kb/store.mjs) so the shipped CLI stays self-contained - it must not
// require a module outside the npm `files` allowlist.
// ─────────────────────────────────────────────────────────────────────────────

const KB_HOME_STORE = path.join(os.homedir(), ".claude/mcp-servers/trajectory-kb/data/trajectories.jsonl");

// Where the memory lives: home by default; agent.trajectory_store ("home" | "repo" | explicit
// path) redirects (resolved against the config's dir on the walk-up from cwd); the
// RECEIPTS_TRAJECTORY_STORE env var overrides everything - identical rules to the MCP server.
function kbResolveStore(startDir, env) {
  env = env || process.env;
  if (env.RECEIPTS_TRAJECTORY_STORE) return path.resolve(env.RECEIPTS_TRAJECTORY_STORE);
  let d = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 40; i++) {
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(path.join(d, "receipts.config.json"), "utf8")); }
    catch (e) { if (e && e.code !== "ENOENT") return KB_HOME_STORE; }
    if (cfg) {
      const want = cfg.agent && cfg.agent.trajectory_store;
      if (!want || want === "home") return KB_HOME_STORE;
      if (want === "repo") return path.join(d, ".receipts", "trajectories.jsonl");
      return path.resolve(d, String(want));
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return KB_HOME_STORE;
}

function kbReadEntries(storePath) {
  let raw;
  try { raw = fs.readFileSync(storePath, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* tolerate a corrupt line */ }
  }
  return out;
}

const kbFirst = (v) => {
  if (Array.isArray(v)) { for (const x of v) { const s = String(x || "").trim(); if (s) return s; } return ""; }
  return String(v || "").trim();
};
// Recurrence groups on the canonical surface_key; entries written before it existed fall
// back to a normalized surface / first file (the same derivation the server uses).
function kbSurfaceKey(e) {
  const explicit = String(e.surface_key || "").trim();
  if (explicit) return explicit.toLowerCase().replace(/\s+/g, " ");
  const s = String(e.surface || "").trim();
  if (s) {
    const cut = s.search(/\s\(|\s\|\s|\s\+\s|\s->\s/);
    return (cut >= 0 ? s.slice(0, cut) : s).toLowerCase().replace(/\s+/g, " ");
  }
  const f = kbFirst(e.files);
  return f ? f.toLowerCase().replace(/\s+/g, " ") : "(unknown)";
}
function kbSupersededIds(all) {
  const s = new Set();
  for (const e of all) if (e && e.supersedes) s.add(e.supersedes);
  return s;
}

// Load the live entries for a scope: drop superseded, optionally filter to one repo (case-insensitive).
function kbLoad(dir, repo) {
  const all = kbReadEntries(kbResolveStore(dir));
  const superseded = kbSupersededIds(all);
  const want = repo ? String(repo).toLowerCase() : null;
  return all.filter((e) => {
    if (!e || typeof e !== "object") return false;
    if (e.id && superseded.has(e.id)) return false;
    if (want && String(e.repo || "").toLowerCase() !== want) return false;
    return true;
  });
}

// Group live entries by surface_key -> { key, count, outcomes:{...}, last_ts, repos:Set, top_failed }.
function kbGroupBySurface(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = kbSurfaceKey(e);
    let g = groups.get(key);
    if (!g) { g = { key, count: 0, outcomes: {}, last_ts: "", repos: new Set(), failed: [] }; groups.set(key, g); }
    g.count++;
    const oc = String(e.outcome || "?").trim() || "?";
    g.outcomes[oc] = (g.outcomes[oc] || 0) + 1;
    const ts = String(e.ts || "");
    if (ts > g.last_ts) g.last_ts = ts;
    if (e.repo) g.repos.add(String(e.repo));
    const f = kbFirst(e.what_failed);
    if (f) g.failed.push(f);
  }
  const rows = [...groups.values()].map((g) => ({
    surface_key: g.key,
    count: g.count,
    outcomes: g.outcomes,
    last_ts: g.last_ts || null,
    repos: [...g.repos],
    top_failed: g.failed[0] || null, // most-recent-first would need a sort; first seen is enough for a hint
  }));
  rows.sort((a, b) => b.count - a.count || String(b.last_ts).localeCompare(String(a.last_ts)));
  return rows;
}

const kbTrunc = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const kbHist = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");

function kbRecur(dir, repo, asJson) {
  const rows = kbGroupBySurface(kbLoad(dir, repo));
  if (asJson) { process.stdout.write(JSON.stringify({ repo: repo || null, groups: rows }, null, 2) + "\n"); return; }
  if (!rows.length) {
    console.log(`receipts kb recur${repo ? ` (repo ${repo})` : ""}: no trajectory entries found (store: ${kbResolveStore(dir)}).`);
    return;
  }
  const out = [`receipts kb recur${repo ? ` - repo ${repo}` : ""} - ${rows.length} surface${rows.length === 1 ? "" : "s"}, most-recurring first:\n`];
  for (const r of rows) {
    out.push(`  ${r.count}x  ${kbTrunc(r.surface_key, 52).padEnd(52)}  [${kbHist(r.outcomes)}]  last ${String(r.last_ts || "?").slice(0, 10)}`);
    if (r.top_failed) out.push(`        └ ${kbTrunc(r.top_failed, 90)}`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

// Conservative, rule-based suggestions from the data. NEVER auto-applied - printed to stdout with
// the evidence lines so a human decides. Rules (each fires only with real evidence):
//   R1 surface_key with >= 2 NON-fixed outcomes -> recurring trouble spot: declare a G6 family /
//      a receipt-cmd probe / a config note.
//   R2 repo with >= 2 'reverted' -> suggest gates.G12.mode = "block" (fixes keep getting backed out;
//      the silencing assist should hard-stop, not warn).
//   R3 >= 2 entries whose what_failed mentions "flaky" -> suggest verify.receipt_runs = 2 (reject
//      nondeterministic receipts).
function kbDistill(dir, repo, asJson) {
  const entries = kbLoad(dir, repo);
  const suggestions = [];

  // R1 - recurring trouble spots (>=2 non-fixed outcomes on one surface_key).
  const groups = kbGroupBySurface(entries);
  for (const g of groups) {
    const nonFixed = Object.entries(g.outcomes).reduce((n, [oc, c]) => (oc !== "fixed" ? n + c : n), 0);
    if (nonFixed >= 2) {
      suggestions.push({
        rule: "recurring-trouble-spot",
        subject: g.surface_key,
        suggestion: `recurring trouble spot: ${g.surface_key} - consider a declared G6 family (a glob + required marker), a receipt-cmd probe that reproduces it, or a config note so the next loop starts warned`,
        evidence: [
          `${nonFixed} non-fixed outcome(s) across ${g.count} attempt(s) [${kbHist(g.outcomes)}]`,
          ...(g.top_failed ? [`e.g. ${kbTrunc(g.top_failed, 140)}`] : []),
        ],
      });
    }
  }

  // R2 - revert-prone repos (>=2 'reverted').
  const revByRepo = {};
  for (const e of entries) if (String(e.outcome || "") === "reverted") revByRepo[e.repo || "(unknown)"] = (revByRepo[e.repo || "(unknown)"] || 0) + 1;
  for (const [rp, n] of Object.entries(revByRepo)) {
    if (n >= 2) {
      suggestions.push({
        rule: "revert-prone-repo",
        subject: rp,
        suggestion: `repo ${rp} has ${n} reverted fixes - consider gates.G12.mode: "block" (fix the cause, not the alarm: hard-stop silencing-shaped diffs instead of only warning)`,
        evidence: [`${n} entries with outcome "reverted" in ${rp}`],
      });
    }
  }

  // R3 - flaky signal (>=2 entries whose what_failed mentions "flaky").
  const flaky = entries.filter((e) => (Array.isArray(e.what_failed) ? e.what_failed.join(" ") : String(e.what_failed || "")).toLowerCase().includes("flaky"));
  if (flaky.length >= 2) {
    suggestions.push({
      rule: "flaky-receipts",
      subject: repo || "(all repos)",
      suggestion: `${flaky.length} entries mention "flaky" - consider verify.receipt_runs: 2 (a flaky receipt can fake a red or pass a broken fix; N>1 rejects nondeterministic receipts)`,
      evidence: flaky.slice(0, 3).map((e) => `${e.repo || "?"} / ${kbSurfaceKey(e)}: ${kbTrunc(kbFirst(e.what_failed), 120)}`),
    });
  }

  if (asJson) { process.stdout.write(JSON.stringify({ repo: repo || null, suggestions }, null, 2) + "\n"); return; }
  if (!suggestions.length) {
    console.log(`receipts kb distill${repo ? ` (repo ${repo})` : ""}: no actionable pattern yet (rules need >=2 corroborating entries). Store: ${kbResolveStore(dir)}.`);
    return;
  }
  const out = [`receipts kb distill${repo ? ` - repo ${repo}` : ""} - ${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} (rule-based; NOT auto-applied):\n`];
  for (const s of suggestions) {
    out.push(`  [${s.rule}] ${s.suggestion}`);
    for (const ev of s.evidence) out.push(`      - ${ev}`);
    out.push("");
  }
  process.stdout.write(out.join("\n").replace(/\n+$/, "\n"));
}

function kb(o, rest) {
  const dir = path.resolve(o.dir || process.cwd());
  const sub = firstPositional(rest);
  const repo = flagVal(rest, "--repo");
  const asJson = rest.includes("--json");
  if (sub === "recur") return kbRecur(dir, repo, asJson);
  if (sub === "distill") return kbDistill(dir, repo, asJson);
  console.error("usage: receipts kb <recur|distill> [--repo <name>] [--json]");
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
  if (cmd === "observe") return observe(rest);
  if (cmd === "kb") return kb(o, rest);
  console.error(`Unknown command: ${cmd}\n`);
  process.stdout.write(HELP);
  process.exit(1);
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
