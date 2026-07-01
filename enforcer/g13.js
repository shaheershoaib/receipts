"use strict";
/*
 * G13 claim-scope congruence (the coverage-of-diff assist).
 *
 * Red->green proves the receipt RELATES to the change - it can flip on 3 of the 500
 * changed lines while the other 497 ride along unverified, shielded by one narrow
 * receipt. G13 answers the second question: did any test actually EXECUTE the changed
 * lines? Changed production lines no test ran are unverified changes, named as such.
 *
 * Opt-in (gates.G13.coverage_command): coverage tooling is stack-specific and slower.
 * The enforcer runs the command on head, reads the lcov it writes, intersects executed
 * lines with the diff's ADDED lines (git diff -U0), and reports the gap. lcov because
 * it is the lingua franca every ecosystem can emit (c8/nyc, coverage.py lcov, gcov,
 * SimpleCov, JaCoCo converters). Pure parsing here; I/O stays in verify.js.
 */

// lcov: SF:<path> opens a file record; DA:<line>,<hits> marks an instrumented line.
// -> Map<sfPath, Set<coveredLineNumber>> (hits > 0 only).
function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = line.slice(3).trim();
      if (!files.has(current)) files.set(current, new Set());
    } else if (line.startsWith("DA:") && current) {
      const [ln, hits] = line.slice(3).split(",");
      if (Number(hits) > 0) files.get(current).add(Number(ln));
    } else if (line === "end_of_record") {
      current = null;
    }
  }
  return files;
}

// git diff -U0 output -> Map<file, Set<addedLineNumber>>. `+++ b/<file>` names the
// head-side file; each `@@ -a[,b] +s[,c] @@` hunk adds lines s..s+c-1 (c omitted = 1,
// c = 0 = pure deletion, nothing added).
function parseAddedLines(diffText) {
  const out = new Map();
  let file = null;
  for (const line of String(diffText || "").split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p.startsWith("b/") ? p.slice(2) : p === "/dev/null" ? null : p;
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < count; i++) out.get(file).add(start + i);
    }
  }
  return out;
}

// lcov SF paths vary (relative, absolute, prefixed); match a repo-relative file to its
// record by exact key or path suffix.
function lcovRecordFor(lcov, file) {
  if (lcov.has(file)) return lcov.get(file);
  for (const [sf, lines] of lcov) {
    if (sf === file || sf.endsWith("/" + file) || sf.endsWith("\\" + file.replace(/\//g, "\\"))) return lines;
  }
  return null;
}

/*
 * computeG13({ addedLines, lcov }) -> { findings: [{ file, uncovered, added, no_data }] }
 * A file with NO lcov record was never loaded by any test - every added line is
 * unverified (no_data marks it, so the message can say why).
 */
function computeG13(opts) {
  const { addedLines, lcov } = opts;
  const findings = [];
  for (const [file, added] of addedLines || []) {
    if (!added.size) continue;
    const record = lcovRecordFor(lcov || new Map(), file);
    const uncovered = record === null
      ? [...added]
      : [...added].filter((ln) => !record.has(ln));
    if (uncovered.length)
      findings.push({ file, uncovered: uncovered.sort((a, b) => a - b), added: added.size, no_data: record === null });
  }
  findings.sort((a, b) => a.file.localeCompare(b.file));
  return { findings };
}

module.exports = { parseLcov, parseAddedLines, lcovRecordFor, computeG13 };
