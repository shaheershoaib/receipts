"use strict";
/*
 * G14 receipt strength (the mutation referee).
 *
 * Red->green proves the receipt notices THE fix. It does not prove the receipt would
 * notice a WRONG fix - a receipt asserting "not the old value" goes green for any
 * change at all (the bench's measured `weak-receipt` escape: for a subtotal that should
 * become 6, `!== 3` passes when the code returns 7). G14 answers it directly: break
 * each changed line on purpose (a mutant); the receipt must go red. A mutant that
 * SURVIVES is a changed line whose behavior the receipt cannot distinguish from broken.
 *
 * Zero-dep and line-level, like the rest of the enforcer: a small operator set applied
 * to the diff's ADDED lines only (same -U0 parse as G13), capped and round-robin across
 * files so one file cannot hog the budget. String literals are masked before matching
 * (mutating a message is not mutating behavior); comment lines are skipped. A survivor
 * may be an EQUIVALENT mutant (the line is dead or the operator is a no-op there) -
 * that is why the default is warn, and why the message states the either/or honestly.
 */

// Length-preserving string mask: operator positions found on the masked line apply to
// the original text unchanged. Quote chars stay so the tokenizer's shape holds.
function maskStrings(line) {
  return String(line || "").replace(/(["'`])((?:\\.|(?!\1).)*)\1/g, (m, q, body) => q + body.replace(/[^\s]/g, " ") + q);
}

// The operator set. Ordered and named so mutant generation is deterministic and the
// finding is legible ("flip === at auth.js:41"). `sub` may be a function of the full
// match (+ capture groups); `exts` restricts an operator to file extensions where its
// replacement is meaningful (a `return None` knockout is python's, not bash's).
const OPERATORS = [
  { name: "=== -> !==", re: /===/g, sub: "!==" },
  { name: "!== -> ===", re: /!==/g, sub: "===" },
  { name: "== -> !=", re: /(?<![=!<>])==(?!=)/g, sub: "!=" },
  { name: "!= -> ==", re: /(?<![!<>=])!=(?!=)/g, sub: "==" },
  { name: "<= -> <", re: /<=/g, sub: "<" },
  { name: "< -> <=", re: /(?<![<=!-])<(?![=<])/g, sub: "<=" },
  { name: ">= -> >", re: />=/g, sub: ">" },
  { name: "> -> >=", re: /(?<![>=-])>(?![=>])/g, sub: ">=" },
  { name: "&& -> ||", re: /&&/g, sub: "||" },
  { name: "|| -> &&", re: /\|\|/g, sub: "&&" },
  { name: "and -> or", re: /\band\b/g, sub: "or" },     // python / bash [[ ]]
  { name: "or -> and", re: /\bor\b/g, sub: "and" },
  // Binary arithmetic. Lookarounds exclude ++/--/+=/-=/->/**, unary signs on literals,
  // and comment/regex delimiters; an equivalent-looking survivor on a string concat is
  // real signal too (a test that cannot tell `a + b` from `a - b` asserted neither).
  { name: "+ -> -", re: /(?<![+\w"'`])\s\+\s(?![+=])/g, sub: " - " },
  { name: "- -> +", re: /(?<![-\w"'`])\s-\s(?![-=>])/g, sub: " + " },
  { name: "/ -> *", re: /(?<![/*])\s\/\s(?![/*=])/g, sub: " * " },
  { name: "* -> /", re: /(?<![/*])\s\*\s(?![/*=])/g, sub: " / " },
  { name: "true -> false", re: /\btrue\b/g, sub: "false" },
  { name: "false -> true", re: /\bfalse\b/g, sub: "true" },
  { name: "True -> False", re: /\bTrue\b/g, sub: "False" },
  { name: "False -> True", re: /\bFalse\b/g, sub: "True" },
  // Both directions: an off-by-one bug's weak receipt often pins exactly ONE wrong value
  // (the old one) - nudging the other way slips past it, which is the point.
  { name: "number +1", re: /(?<![\w.])\d+(?![\w.])/g, sub: (m) => String(Number(m) + 1) },
  { name: "number -1", re: /(?<![\w.])\d+(?![\w.])/g, sub: (m) => String(Number(m) - 1) },
  // Return-value knockout: the strongest generic mutant for lines with no operator at
  // all (`return s[:n]`). Language-keyed - the knocked-out value must parse.
  { name: "return -> None", re: /(?<=\breturn)[ \t]+(?!None\b)[^#\n]+$/gm, sub: " None", exts: ["py"] },
  { name: "return -> undefined", re: /(?<=\breturn)[ \t]+(?!undefined\b)[^;\n]+;?$/gm, sub: " undefined;", exts: ["js", "jsx", "ts", "tsx", "mjs", "cjs"] },
  // Bash arithmetic expansion: $((n)) has no bare operator token to flip - nudge inside.
  { name: "$((x)) -> $((x+1))", re: /\$\(\(([^)]*)\)\)/g, sub: (m, inner) => `$((${inner}+1))`, exts: ["sh", "bash"] },
  { name: "$((x)) -> $((x-1))", re: /\$\(\(([^)]*)\)\)/g, sub: (m, inner) => `$((${inner}-1))`, exts: ["sh", "bash"] },
];

const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*)/;

// All mutants for one line of source: at most ONE per operator (the first match), so a
// dense line cannot flood the budget. Returns [{ op, before, after, col }].
function mutantsForLine(line, ext) {
  if (!line || COMMENT_LINE.test(line)) return [];
  const masked = maskStrings(line);
  const out = [];
  for (const { name, re, sub, exts } of OPERATORS) {
    if (exts && !exts.includes(String(ext || "").toLowerCase())) continue;
    re.lastIndex = 0;
    const m = re.exec(masked);
    if (!m) continue;
    const replacement = typeof sub === "function" ? sub(...m) : sub;
    const after = line.slice(0, m.index) + replacement + line.slice(m.index + m[0].length);
    if (after !== line) out.push({ op: name, before: line, after, col: m.index });
  }
  return out;
}

/*
 * computeMutants({ addedLines, read }) -> [{ file, line, op, before, after }]
 *   addedLines: Map<file, Set<lineNo>> (g13.parseAddedLines output)
 *   read(file): the file's HEAD content
 * Deterministic: files sorted, lines ascending, operators in table order.
 */
function computeMutants({ addedLines, read }) {
  const out = [];
  for (const file of [...(addedLines || new Map()).keys()].sort()) {
    let src;
    try { src = String(read(file)); } catch { continue; }
    const ext = (file.match(/\.([^./]+)$/) || [])[1];
    const lines = src.split("\n");
    for (const ln of [...addedLines.get(file)].sort((a, b) => a - b)) {
      const text = lines[ln - 1];
      if (text == null) continue;
      for (const m of mutantsForLine(text, ext)) out.push({ file, line: ln, ...m });
    }
  }
  return out;
}

// Budgeted selection: round-robin one mutant per file per pass, so a many-file diff gets
// breadth before any file gets depth. Deterministic given the deterministic input order.
function selectMutants(mutants, cap) {
  const byFile = new Map();
  for (const m of mutants) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }
  const files = [...byFile.keys()].sort();
  const picked = [];
  for (let round = 0; picked.length < cap; round++) {
    let took = false;
    for (const f of files) {
      const list = byFile.get(f);
      if (round < list.length && picked.length < cap) { picked.push(list[round]); took = true; }
    }
    if (!took) break;
  }
  return picked;
}

// Apply / undo one mutant against a file's full content.
function applyMutant(src, mutant) {
  const lines = String(src).split("\n");
  if (lines[mutant.line - 1] !== mutant.before) return null; // drifted - do not touch
  lines[mutant.line - 1] = mutant.after;
  return lines.join("\n");
}

module.exports = { maskStrings, mutantsForLine, computeMutants, selectMutants, applyMutant, OPERATORS };
