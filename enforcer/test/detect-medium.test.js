"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/*
 * Medium detection for the shapes the observation contract already covers but nothing
 * recognised: ML, database migration, smart contract, browser extension, embedded, game,
 * outbound messaging - plus Python tools, which landed on "unknown" (setup-audit, fanout)
 * because only package.json `bin` made a CLI. Each fixture is the smallest tell a repo of
 * that kind carries; two precedence guards keep a framework app from being reclassified by
 * an incidental file. A guess the agent confirms, so a wrong guess costs a correction, a
 * missing one costs the whole draft.
 */
const CLI = path.join(__dirname, "..", "..", "bin", "receipts.js");

function detectMedium(files) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-medium-"));
  for (const [f, body] of Object.entries(files)) {
    const fp = path.join(td, f);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, body);
  }
  const r = spawnSync("node", [CLI, "init", "--agent", "--dir", td], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).medium;
}

const CASES = [
  ["smart contract (foundry)", { "foundry.toml": "[profile.default]\nsrc = 'src'\n", "src/Vault.sol": "// SPDX\n" }, "contract"],
  ["smart contract (hardhat)", { "hardhat.config.ts": "export default {};\n", "package.json": JSON.stringify({ name: "c", devDependencies: { hardhat: "2" } }) }, "contract"],
  ["browser extension (manifest v3)", { "manifest.json": JSON.stringify({ manifest_version: 3, name: "x", background: { service_worker: "bg.js" } }), "package.json": JSON.stringify({ name: "ext" }) }, "extension"],
  ["embedded (platformio)", { "platformio.ini": "[env:uno]\nplatform = atmelavr\n", "src/main.cpp": "int main(){}" }, "embedded"],
  ["embedded (zephyr west)", { "west.yml": "manifest:\n  projects: []\n", "prj.conf": "CONFIG_GPIO=y\n" }, "embedded"],
  ["game (godot)", { "project.godot": "[application]\nconfig/name=\"g\"\n" }, "game"],
  ["game (unity)", { "Assets/.keep": "", "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 2022.3\n" }, "game"],
  ["ml (dvc + torch)", { "dvc.yaml": "stages: {}\n", "requirements.txt": "torch==2.3\nnumpy\n" }, "ml"],
  ["ml (sklearn, no framework)", { "requirements.txt": "scikit-learn\npandas\n", "train.py": "import sklearn\n" }, "ml"],
  ["outbound messaging (react-email)", { "package.json": JSON.stringify({ name: "emails", dependencies: { "react-email": "2", "@react-email/components": "0.0.1" } }), "emails/welcome.tsx": "export default () => null;" }, "message"],
  ["data pipeline (airflow dags)", { "dags/etl.py": "from airflow import DAG\n", "requirements.txt": "apache-airflow==2.9\n" }, "data"],
  ["data pipeline (dagster)", { "requirements.txt": "dagster\ndagster-webserver\n", "pipeline/assets.py": "import dagster\n" }, "data"],
  ["database migration repo (flyway)", { "flyway.conf": "flyway.url=jdbc:postgresql://x\n", "sql/V1__init.sql": "create table t(id int);" }, "migration"],
  ["database migration repo (alembic, no framework)", { "alembic.ini": "[alembic]\nscript_location = migrations\n", "migrations/env.py": "" }, "migration"],
  ["python CLI (pyproject scripts)", { "pyproject.toml": "[project]\nname = 'tool'\n\n[project.scripts]\ntool = 'tool.cli:main'\n", "tool/cli.py": "def main(): pass\n" }, "cli"],
  ["python CLI (script with __main__ + argparse)", { "audit.py": "import argparse, sys\n\nif __name__ == \"__main__\":\n    p = argparse.ArgumentParser()\n    sys.exit(0)\n" }, "cli"],
  ["python library (pyproject, no scripts)", { "pyproject.toml": "[project]\nname = 'lib'\nversion = '0.1'\n", "lib/__init__.py": "" }, "library"],
  ["python API (fastapi)", { "requirements.txt": "fastapi\nuvicorn\n", "app/main.py": "from fastapi import FastAPI\n" }, "api"],
  // precedence guards
  ["a Django app with a migrations dir is an API, not a migration repo", { "manage.py": "", "app/migrations/0001_initial.py": "" }, "api"],
  ["a React app that sends mail is a web app, not an outbound-message repo", { "package.json": JSON.stringify({ name: "app", dependencies: { react: "18", "@sendgrid/mail": "8" } }) }, "web"],
  ["a Terraform repo with a helper script is infra, not a CLI", { "main.tf": "", "scripts/tool.py": "import argparse\nif __name__ == \"__main__\":\n    pass\n" }, "infra"],
];

for (const [name, files, want] of CASES) {
  test(`detects ${name} -> ${want}`, () => { assert.equal(detectMedium(files), want); });
}
