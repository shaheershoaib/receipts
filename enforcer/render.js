"use strict";
/*
 * Receipt -> Markdown renderer (pure; no I/O).
 *
 * A failing gate that reads as a bare red X gets ignored or resented; one that explains
 * itself - what was re-run, what it saw, which gate objected and why - gets acted on.
 * One renderer feeds every surface: the GitHub Action's step summary, the optional PR
 * comment, and `receipts explain --md`.
 */

const VERDICT_ICON = { PASS: "✅", WARN: "⚠️", BLOCK: "❌" };

// The PR-comment marker: the reporter upserts (finds + updates) the comment carrying
// this, so re-runs refresh one report instead of stacking new comments.
const COMMENT_MARKER = "<!-- receipts-enforcer-report -->";

const sha = (s) => String(s || "").slice(0, 10) || "?";
const ms = (n) => (n == null ? "-" : n >= 1000 ? (n / 1000).toFixed(1) + "s" : n + "ms");
const flag = (b) => (b ? "✅" : "❌");
// Markdown-table-safe cell: pipes and newlines break the row.
const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function renderMarkdown(rec) {
  const r = rec || {};
  const out = [];
  const icon = VERDICT_ICON[r.verdict] || "🧾";
  out.push(`## ${icon} receipts: ${r.verdict || "?"}`);
  out.push("");
  if (r.reason) out.push(`**${cell(r.reason)}**`);
  if (r.detail) out.push("", "```", String(r.detail).trim(), "```");
  out.push("");

  // The claim + the proof, at a glance.
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| commits | \`${sha(r.base)}\` (base) → \`${sha(r.head)}\` (head) |`);
  if (r.red != null || r.green != null) {
    const tests = Array.isArray(r.tests) && r.tests.length ? ` — ${r.tests.map((t) => `\`${cell(t)}\``).join(", ")}` : "";
    out.push(`| receipt | red on base: ${flag(r.red)} · green on head: ${flag(r.green)}${r.pinned ? " · pinned" : ""}${tests} |`);
  }
  const trigger = r.is_fix_claim ? "fix-claim" : (r.work_type ? `work-type: ${r.work_type}` : "unclaimed");
  out.push(`| trigger | ${trigger}${r.strict ? " (strict: any-source-change)" : ""} |`);
  out.push(`| config | read from ${r.config_source || "?"}${r.config_source === "head" ? " ⚠️ (first-setup: the PR controlled its own gate config)" : ""} |`);
  out.push("");

  // What actually ran - the replay core.
  const cmds = Array.isArray(r.commands) ? r.commands : [];
  if (cmds.length) {
    out.push("<details><summary><b>Commands re-run by the enforcer</b> (" + cmds.length + ")</summary>", "");
    out.push("| step | command | exit | time |");
    out.push("|---|---|---|---|");
    for (const c of cmds) {
      const exit = c.timed_out ? "⏱ timed out" : (c.ok ? "0" : String(c.exit_code == null ? "?" : c.exit_code));
      out.push(`| ${cell(c.label)} | \`${cell(c.command)}\` | ${exit} | ${ms(c.duration_ms)} |`);
    }
    out.push("", "</details>", "");
  }

  // Per-gate findings recorded in the receipt.
  const g = r.gates || {};
  const findings = [];
  if (g.G6 && Array.isArray(g.G6.findings) && g.G6.findings.length)
    findings.push(`**G6 incomplete rollout:** ${g.G6.findings.map((f) => `\`${cell(f.marker)}\` missing on ${f.uncovered.length} sibling(s)`).join("; ")}`);
  if (g.G7 && Array.isArray(g.G7.new_dependents) && g.G7.new_dependents.length)
    findings.push(`**G7 new dependents:** ${g.G7.new_dependents.map((d) => `\`${cell(d.file)}\``).join(", ")}${g.G7.ok === false ? " — **tests FAIL on head**" : ""}`);
  if (g.G11) {
    const parts = [];
    if ((g.G11.deletions || []).length) parts.push(`deleted test(s): ${g.G11.deletions.map((d) => `\`${cell(d)}\``).join(", ")}`);
    if ((g.G11.skips || []).length) parts.push(`skip/focus added: ${g.G11.skips.map((s) => `\`${cell(s.file)}\` (${cell(s.marker)})`).join(", ")}`);
    if ((g.G11.snapshots || []).length) parts.push(`${g.G11.snapshots.length} snapshot(s) rewritten`);
    if (parts.length) findings.push(`**G11 referee integrity:** ${parts.join("; ")}${g.G11.acknowledged ? " — acknowledged via `test-removal:`" : ""}`);
  }
  if (g.G12 && Array.isArray(g.G12.findings) && g.G12.findings.length)
    findings.push(`**G12 silencing shapes:** ${g.G12.findings.map((f) => `\`${cell(f.file)}\` (${cell(f.name)})`).join(", ")}`);
  if (findings.length) {
    out.push("### Gate findings");
    for (const f of findings) out.push(`- ${f}`);
    out.push("");
  }

  const warns = Array.isArray(r.warnings) ? r.warnings : [];
  if (warns.length) {
    out.push("### Warnings");
    for (const w of warns) out.push(`- ${cell(w)}`);
    out.push("");
  }

  out.push(`<sub>\`${r.schema || "receipts/receipt@1"}\` · generated ${r.generated_at || "?"} · replay locally: \`npx receipts-cli replay <receipt.json>\`</sub>`);
  return out.join("\n") + "\n";
}

// The PR-comment body: the marker (for upsert) + the same report.
function renderComment(rec) {
  return COMMENT_MARKER + "\n" + renderMarkdown(rec);
}

module.exports = { renderMarkdown, renderComment, COMMENT_MARKER };
