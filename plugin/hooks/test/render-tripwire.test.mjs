import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Tests for the OPT-IN producer-without-render-receipt tripwire in pre-gates.mjs: after editing a
 * render-feeding source, a commit whose only verification was a DATA read (a data-form
 * `receipts observe`) - never the RENDERED surface - is denied. Fires only when the project
 * declares render surfaces AND sets render_unverified:deny; inert otherwise.
 *
 * Hermetic: isolated HOME, a transcript file, the real script driven over stdin.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRE_HOOK = path.join(HERE, "..", "pre-gates.mjs");

const useEntry = (name, input = {}) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
});

function runPre(toolName, toolInput, entries, projectConfig) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-rt-"));
  const tp = path.join(td, "transcript.jsonl");
  fs.writeFileSync(tp, (entries || []).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const home = path.join(td, "home");
  fs.mkdirSync(home, { recursive: true });
  if (projectConfig) fs.writeFileSync(path.join(td, "receipts.config.json"), JSON.stringify(projectConfig));
  const stdin = JSON.stringify({ tool_name: toolName, tool_input: toolInput, transcript_path: tp, cwd: td });
  const out = execFileSync("node", [PRE_HOOK], {
    input: stdin, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
  }).trim();
  return out ? JSON.parse(out) : null;
}

const CFG_ON = {
  agent: { tripwires: { render_unverified: "deny" } },
  gates: { G6: { render_twins: [{ name: "invoice", surfaces: ["**/invoice_view.tsx", "**/invoice_pdf.html"] }] } },
};
// A render-feeding edit, then a DATA-form observe (satisfies commit-tripwire, but reads data not render).
const DATA_ONLY_RUN = [
  useEntry("Edit", { file_path: "app/ui/invoice_view.tsx", new_string: "render the fee lines" }),
  useEntry("Bash", { command: "receipts observe --cmd \"select count(*) from invoice_lines\" --expect \"/5/\"" }),
];

test("render tripwire: render edit verified only by a data-form observe is DENIED", () => {
  const d = runPre("Bash", { command: "git commit -m 'render fee lines'" }, DATA_ONLY_RUN, CFG_ON);
  assert.ok(d, "should emit a decision");
  assert.equal(d.hookSpecificOutput.permissionDecision, "deny");
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /producer-without-render-receipt/);
});

test("render tripwire: a real render observe (playwright) after the edit ALLOWS the commit", () => {
  const entries = [
    useEntry("Edit", { file_path: "app/ui/invoice_view.tsx", new_string: "render the fee lines" }),
    useEntry("Bash", { command: "npx playwright test invoice.spec.ts" }),
  ];
  assert.equal(runPre("Bash", { command: "git commit -m x" }, entries, CFG_ON), null);
});

test("render tripwire: INERT when no render surfaces are declared (opt-in), even if deny is set", () => {
  const cfg = { agent: { tripwires: { render_unverified: "deny" } } }; // no render_twins / globs
  assert.equal(runPre("Bash", { command: "git commit -m x" }, DATA_ONLY_RUN, cfg), null);
});

test("render tripwire: default OFF (render_unverified unset) allows the commit", () => {
  const cfg = { gates: { G6: { render_twins: CFG_ON.gates.G6.render_twins } } }; // render_unverified defaults off
  assert.equal(runPre("Bash", { command: "git commit -m x" }, DATA_ONLY_RUN, cfg), null);
});

test("render tripwire: an explicit RECEIPTS_ACK on the commit allows it", () => {
  const d = runPre("Bash", { command: "RECEIPTS_ACK='config file, no rendered surface' git commit -m x" }, DATA_ONLY_RUN, CFG_ON);
  assert.equal(d, null);
});

test("render tripwire: an edit to a NON-render source does not fire it", () => {
  const entries = [
    useEntry("Edit", { file_path: "app/services/pricing.py", new_string: "x" }),
    useEntry("Bash", { command: "receipts observe --cmd \"select 1\" --expect \"/1/\"" }),
  ];
  assert.equal(runPre("Bash", { command: "git commit -m x" }, entries, CFG_ON), null);
});
