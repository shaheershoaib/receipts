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
// Mention-safe text for the NON-code-span contexts (reason, warnings): `reason`/warning
// strings carry file names and config values from the PR under review, so a crafted
// `@user`/`@team` there would fire a live GitHub notification from the bot's comment.
// A zero-width space after `@` breaks the mention match without visibly altering the
// text. Code-span contexts (backticked commands/files) are already inert - leave them.
const noMention = (s) => String(s == null ? "" : s).replace(/@(?=\w)/g, "@\u200b");

function renderMarkdown(rec) {
  const r = rec || {};
  const out = [];
  const icon = VERDICT_ICON[r.verdict] || "🧾";
  out.push(`## ${icon} receipts: ${r.verdict || "?"}`);
  out.push("");
  if (r.reason) out.push(`**${noMention(cell(r.reason))}**`);
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
  if (Array.isArray(r.command_receipts) && r.command_receipts.length) {
    const cr = r.command_receipts.map((c) => `\`${cell(c.command)}\`${c.expect != null ? ` expect:\`/${cell(c.expect)}/\`` : ""}`).join(", ");
    out.push(`| receipt-cmd | ${cr} |`);
  }
  // Browser receipt (head-only preview acceptance): NOT a red->green receipt (a preview has no
  // base build), so it reads as its own row with the honest "(head-only)" label. `ran: false`
  // (a masked command / adapter error) and a could-not-resolve degrade both surface as text, so
  // a skipped or unresolved check is never silently absent.
  const br = r.browser_receipt;
  if (br && br.configured) {
    let cellText;
    if (br.ran === false) cellText = `skipped — ${cell(br.reason || "not run")}`;
    else if (br.ok == null) cellText = `not run — ${cell(br.reason || "could not resolve preview URL")}`;
    else {
      const shaBit = br.sha_match === false ? " · ⚠️ preview ≠ head build" : (br.sha_match === true ? " · sha✓" : "");
      cellText = `${flag(br.ok)} on preview${br.url ? ` \`${cell(br.url)}\`` : ""} (via ${cell(br.source || "?")})${shaBit}`;
    }
    out.push(`| browser-receipt@preview (head-only) | ${cellText} |`);
  }
  const trigger = r.is_fix_claim ? "fix-claim" : (r.work_type ? `work-type: ${r.work_type}` : "unclaimed");
  out.push(`| trigger | ${trigger}${r.strict ? " (strict: any-source-change)" : ""} |`);
  if (r.lock)
    out.push(`| receipt-lock | ${r.lock.matched ? "✅ matched" : "❌ MISMATCH"} \`${String(r.lock.hash || "").slice(0, 12)}…\` (the approved rubric${r.lock.matched ? " was carried intact" : " was NOT what the PR carries"}) |`);
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
  if (g.G14 && Array.isArray(g.G14.survived) && g.G14.survived.length)
    findings.push(`**G14 surviving mutants (${g.G14.survived.length}/${g.G14.tried}):** ${g.G14.survived.map((s) => `\`${cell(s.file)}:${s.line}\` (${cell(s.op)})`).join(", ")} — the receipt cannot tell these broken variants from the fix`);
  if (findings.length) {
    out.push("### Gate findings");
    for (const f of findings) out.push(`- ${f}`);
    out.push("");
  }

  const warns = Array.isArray(r.warnings) ? r.warnings : [];
  if (warns.length) {
    out.push("### Warnings");
    for (const w of warns) out.push(`- ${noMention(cell(w))}`);
    out.push("");
  }

  out.push(`<sub>\`${r.schema || "receipts/receipt@1"}\` · generated ${r.generated_at || "?"} · replay locally: \`npx receipts-cli replay <receipt.json>\`</sub>`);
  return out.join("\n") + "\n";
}

// The PR-comment body: the marker (for upsert) + the same report.
function renderComment(rec) {
  return COMMENT_MARKER + "\n" + renderMarkdown(rec);
}

/*
 * Aggregate a set of receipt artifacts into team-level signals. Every gated PR emits a
 * receipt (uploaded as a CI artifact) - collected over time they answer the questions an
 * eng lead actually has: how many claims carry real proof, how often the honesty ladder
 * is used (a rising `speculative` rate is a team drowning), which gates catch things,
 * how often a receipt was weak or flaky. Pure; the CLI feeds it files.
 */
function aggregateReceipts(records) {
  const agg = {
    total: 0,
    verdicts: { PASS: 0, WARN: 0, BLOCK: 0, other: 0 },
    real_receipts: 0,        // red on base AND green on head
    pinned: 0,
    fix_claims: 0,
    work_types: {},          // refactor / feature / ...
    honest_downgrades: 0,    // the pressure valve being used (tracked, not clean-claimed)
    weak_receipts: 0,        // passed on base - proved nothing
    flaky_receipts: 0,
    head_configs: 0,         // config came from the PR head (weaker provenance)
    gate_warnings: {},       // Gn -> count, from warning texts
  };
  for (const r of records || []) {
    if (!r || typeof r !== "object") continue;
    agg.total++;
    if (agg.verdicts[r.verdict] != null) agg.verdicts[r.verdict]++; else agg.verdicts.other++;
    if (r.red === true && r.green === true) agg.real_receipts++;
    if (r.pinned) agg.pinned++;
    if (r.is_fix_claim) agg.fix_claims++;
    if (r.work_type) agg.work_types[r.work_type] = (agg.work_types[r.work_type] || 0) + 1;
    if (/honest downgrade/i.test(r.reason || "")) agg.honest_downgrades++;
    if (/weak receipt/i.test(r.reason || "")) agg.weak_receipts++;
    if (/flaky (receipt|green)/i.test(r.reason || "")) agg.flaky_receipts++;
    if (r.config_source === "head") agg.head_configs++;
    for (const w of r.warnings || []) {
      const m = String(w).match(/^(G1[0-4]|G[0-9])\b/);
      if (m) agg.gate_warnings[m[1]] = (agg.gate_warnings[m[1]] || 0) + 1;
    }
  }
  return agg;
}

function renderReportText(agg) {
  const pct = (n) => (agg.total ? Math.round((n / agg.total) * 100) + "%" : "-");
  const out = [];
  out.push(`receipts report - ${agg.total} receipt(s)`);
  out.push(`  verdicts       PASS ${agg.verdicts.PASS} · WARN ${agg.verdicts.WARN} · BLOCK ${agg.verdicts.BLOCK}${agg.verdicts.other ? ` · other ${agg.verdicts.other}` : ""}`);
  out.push(`  real receipts  ${agg.real_receipts} (${pct(agg.real_receipts)}) red-on-base -> green-on-head${agg.pinned ? ` · ${agg.pinned} pinned` : ""}`);
  out.push(`  triggers       ${agg.fix_claims} fix-claim(s)${Object.keys(agg.work_types).length ? " · " + Object.entries(agg.work_types).map(([k, v]) => `${k} ${v}`).join(" · ") : ""}`);
  out.push(`  honesty ladder ${agg.honest_downgrades} downgrade(s) - the pressure valve; a RISING rate is a team drowning`);
  if (agg.weak_receipts || agg.flaky_receipts)
    out.push(`  rejected proof ${agg.weak_receipts} weak · ${agg.flaky_receipts} flaky`);
  if (agg.head_configs)
    out.push(`  provenance     ${agg.head_configs} receipt(s) ran on a HEAD-sourced config (weaker - first-setup only)`);
  const gates = Object.entries(agg.gate_warnings).sort();
  if (gates.length)
    out.push(`  gate findings  ${gates.map(([g, n]) => `${g} x${n}`).join(" · ")}`);
  return out.join("\n") + "\n";
}

module.exports = { renderMarkdown, renderComment, COMMENT_MARKER, aggregateReceipts, renderReportText };
