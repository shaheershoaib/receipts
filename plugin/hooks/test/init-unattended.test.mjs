import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The init_unattended tripwire. `receipts init --yes` skips the reachability interview -
 * the ONLY source of agent.drive, which detection cannot find. An agent reaching for --yes
 * answers those questions "unknown" on the human's behalf. CI is the one legitimate caller.
 *
 * Own driver (not pre-gates.test.mjs's) because these cases turn on the CI env var, which
 * the shared harness inherits from the host.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "pre-gates.mjs");

function runPre(command, { ci, projectConfig } = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-init-"));
  const tp = path.join(td, "transcript.jsonl");
  fs.writeFileSync(tp, "");
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true });
  if (projectConfig) fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify(projectConfig));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CI;
  if (ci) env.CI = ci;
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, transcript_path: tp, cwd: td }),
    encoding: "utf8", env,
  }).trim();
  return out ? JSON.parse(out) : null;
}
const denies = (cmd, opts) => {
  const d = runPre(cmd, opts);
  assert.ok(d, `expected deny, hook was silent for: ${cmd}`);
  assert.equal(d.hookSpecificOutput.permissionDecision, "deny");
  return d.hookSpecificOutput.permissionDecisionReason;
};
const allows = (cmd, opts) => assert.equal(runPre(cmd, opts), null, `expected allow for: ${cmd}`);

test("receipts init --yes is DENIED and the reason carries the four questions", () => {
  const r = denies("receipts init --yes");
  assert.match(r, /REACH a signed-in state/);
  assert.match(r, /dev-mode shortcut/);
  assert.match(r, /realistic data/);
  assert.match(r, /BROWSER rather than by API/);
  assert.match(r, /ASK THE HUMAN/);
});

test("every invocation form an agent would reach for is caught", () => {
  denies("npx receipts-cli init --yes");
  denies("receipts init -y");
  denies("receipts init --dir /some/app --yes");
  // the exact command this bug was found through
  denies("node bin/receipts.js init --print --yes --dir /Users/x/app");
});

test("CI is the one legitimate caller of --yes", () => {
  allows("receipts init --yes", { ci: "1" });
  allows("receipts init --yes", { ci: "true" });
});

test("an explicit human-unavailable ack is an escape", () => {
  allows("RECEIPTS_ACK=provisioning a throwaway sandbox receipts init --yes");
});

test("an interactive init is untouched", () => {
  allows("receipts init");
  allows("receipts init --force --dir /some/app");
});

test("the string as DATA is not a run", () => {
  allows('echo "run receipts init --yes to bootstrap"');
  allows("grep -rn 'receipts init --yes' docs/");
});

test("a project can turn the tripwire off", () => {
  allows("receipts init --yes", { projectConfig: { version: 1, agent: { tripwires: { init_unattended: "off" } } } });
});

test("unrelated Bash is untouched (the commit early-return still governs)", () => {
  allows("ls -la");
  allows("npm test");
});
