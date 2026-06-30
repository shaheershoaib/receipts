"use strict";
/*
 * G6 surface-coverage (the "sweep the twins" assist).
 *
 * The failure: a pattern (pagination, an Edit affordance, a mask) is applied to SOME sibling
 * surfaces but not all, and the change is claimed "app-wide". The carried receipt proves the
 * surfaces that WERE changed; it says nothing about the twins that were missed. G6 enumerates
 * the siblings and flags the ones still missing the pattern.
 *
 * Two mechanisms (I/O injected for testability, like g7.js):
 *  1. DECLARED families (any language): the project declares a surface family as a glob + a
 *     required marker substring (gates.G6.surfaces). When a PR adds the marker to a family
 *     member (or `always`), every family member lacking it is flagged. Precise, ~zero false
 *     positives - it encodes an "app-wide" claim as a checkable invariant.
 *  2. HEURISTIC auto-detect (JS/TS): when the PR adds the same import to >=2 sibling files
 *     whose names share a trailing word ("...Table"), other same-family files that lack that
 *     import are flagged. Catches a first, undeclared rollout. Warn-only (it is a heuristic).
 */
const path = require("path");
const { jsImports } = require("./g7.js");

const JS_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;
const TEST_PATH = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|\/__tests__\/|_spec\.)/i;

// Minimal glob -> RegExp: ** spans path segments, * stays within one.
function globToRe(g) {
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  let out = "^", i = 0;
  while (i < g.length) {
    if (g[i] === "*" && g[i + 1] === "*") { out += ".*"; i += 2; if (g[i] === "/") i++; }
    else if (g[i] === "*") { out += "[^/]*"; i++; }
    else { out += esc(g[i]); i++; }
  }
  return new RegExp(out + "$");
}

// Split a filename (no ext) into CamelCase / snake / kebab words: "OrdersTable" -> [Orders,Table].
function camelWords(name) {
  const base = String(name || "").replace(/\.[^.]+$/, "");
  return base
    .split(/[_\-\s]+/)
    .flatMap((s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/))
    .filter(Boolean);
}

// The trailing words common to every word-array: [[Orders,Table],[Users,Table]] -> [Table].
function commonTrailing(arrs) {
  if (!arrs.length) return [];
  let common = arrs[0].slice();
  for (const a of arrs.slice(1)) {
    let k = 0;
    while (k < common.length && k < a.length &&
           common[common.length - 1 - k].toLowerCase() === a[a.length - 1 - k].toLowerCase()) k++;
    common = common.slice(common.length - k);
  }
  return common;
}

function endsWithWords(file, trail) {
  const w = camelWords(path.posix.basename(file));
  if (w.length < trail.length || !trail.length) return false;
  for (let k = 0; k < trail.length; k++)
    if (w[w.length - 1 - k].toLowerCase() !== trail[trail.length - 1 - k].toLowerCase()) return false;
  return true;
}

const isJsSurface = (f) => JS_EXT.test(f) && !TEST_PATH.test(f) && !f.includes("node_modules/");

// Language keywords + ubiquitous framework tokens - excluded from the auto-heuristic (a
// rollout of `useState` or `return` is noise). A flat-lowercase marker like `disabled` is
// also excluded here on purpose; declare it as a `surfaces` marker if you want it checked.
const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "switch", "case",
  "break", "continue", "new", "this", "class", "extends", "super", "import", "export", "from",
  "default", "async", "await", "yield", "typeof", "instanceof", "void", "delete", "true",
  "false", "null", "undefined", "type", "interface", "enum", "namespace", "declare", "public",
  "private", "protected", "readonly", "static", "abstract", "implements", "of", "in", "as",
  "is", "keyof", "props", "state", "children", "classname", "style", "react", "fragment",
  "usestate", "useeffect", "useref", "usememo", "usecallback", "usecontext", "string", "number",
  "boolean", "object", "array", "promise", "any", "unknown", "never",
]);

// All identifier-ish tokens in a source (regex-level; '-' kept so JSX attributes like
// `aria-label` are single tokens). Not an AST - good enough to spot a rolled-out affordance.
function identifiers(src) {
  const out = new Set();
  const re = /[A-Za-z_$][\w$-]*/g;
  let m;
  while ((m = re.exec(String(src || "")))) out.add(m[0]);
  return out;
}

// A token distinctive enough to be a meaningful "affordance" the auto-heuristic tracks: a
// component / type (PascalCase), a hook / call (camelCase), or an attribute (kebab). Flat
// lowercase words and keywords are excluded (too noisy without a declaration).
function isDistinctive(tok) {
  if (!tok || tok.length < 3) return false;
  if (KEYWORDS.has(tok.toLowerCase())) return false;
  if (tok.includes("-")) return true;        // kebab: aria-label, data-testid
  if (/^[A-Z]/.test(tok)) return true;        // PascalCase / CONSTANT_CASE
  if (/[a-z][A-Z]/.test(tok)) return true;    // camelCase: useAuth, rateLimit, reportError
  return false;                                // flat lowercase -> declared territory
}

/*
 * computeG6({ base, head, changed, listAt, readAt, surfaces, auto })
 *   -> { findings: [{ kind, name, marker, adopters, uncovered }] }
 */
function computeG6(opts) {
  const { base, head, changed, listAt, readAt, surfaces, auto } = opts;
  const headFiles = listAt(head) || [];
  const changedSet = new Set(changed || []);
  const findings = [];

  // 1) DECLARED families.
  for (const fam of surfaces || []) {
    if (!fam || !fam.glob || !fam.marker) continue;
    const re = globToRe(fam.glob);
    const family = headFiles.filter((f) => re.test(f) && !TEST_PATH.test(f));
    if (!family.length) continue;
    const has = (commit, f) => { const s = readAt(commit, f); return s != null && s.includes(fam.marker); };
    const uncovered = family.filter((f) => !has(head, f));
    let touched = !!fam.always;
    if (!touched) {
      for (const f of family) {
        if (changedSet.has(f) && !has(base, f) && has(head, f)) { touched = true; break; }
      }
    }
    if (touched && uncovered.length) {
      findings.push({
        kind: "declared",
        name: fam.name || fam.glob,
        marker: fam.marker,
        adopters: family.filter((f) => changedSet.has(f) && has(head, f)),
        uncovered,
      });
    }
  }

  // 2) HEURISTIC rollout detection (JS/TS): a marker added to >=2 same-named siblings, with
  //    the twins that missed it flagged. A "marker" is whatever the rollout expresses - an
  //    added IMPORT specifier (a module-source change), OR an added DISTINCTIVE identifier: a
  //    component <Pagination/>, a hook useAuth, an attribute aria-label, a call reportError.
  //    So the check generalizes beyond imports to props / attributes / calls / tags.
  if (auto !== false) {
    const addedBy = new Map(); // marker -> { kind: "import" | "token", files: Set }
    const note = (marker, kind, f) => {
      const cur = addedBy.get(marker) || { kind, files: new Set() };
      cur.files.add(f);
      addedBy.set(marker, cur);
    };
    for (const f of changed || []) {
      if (!isJsSurface(f)) continue;
      const head_ = readAt(head, f);
      if (head_ == null) continue;
      const base_ = readAt(base, f) || "";
      const beforeImp = new Set(jsImports(base_));
      for (const spec of jsImports(head_)) if (!beforeImp.has(spec)) note(spec, "import", f);
      const beforeTok = identifiers(base_);
      for (const tok of identifiers(head_)) if (!beforeTok.has(tok) && isDistinctive(tok)) note(tok, "token", f);
    }
    const hits = [];
    for (const [marker, { kind, files }] of addedBy) {
      const adopters = [...files];
      if (adopters.length < 2) continue; // a rollout, not a one-off
      const trail = commonTrailing(adopters.map((f) => camelWords(path.posix.basename(f))));
      if (trail.join("").length < 4) continue; // need a confident family signature
      const family = headFiles.filter(isJsSurface).filter((f) => endsWithWords(f, trail));
      const adopterSet = new Set(adopters);
      const has = (f) => {
        const s = readAt(head, f) || "";
        return kind === "import" ? jsImports(s).includes(marker) : s.includes(marker);
      };
      const uncovered = family.filter((f) => !adopterSet.has(f) && !has(f));
      if (uncovered.length) hits.push({ kind: "heuristic", name: "*" + trail.join(""), marker, marker_kind: kind, adopters, uncovered });
    }
    // An import specifier and the name it binds usually fire on the same rollout; collapse to
    // one finding per (family + uncovered set), preferring the readable token marker.
    const best = new Map();
    for (const h of hits) {
      const key = h.name + "|" + [...h.uncovered].sort().join(",");
      const prev = best.get(key);
      if (!prev || (h.marker_kind === "token" && prev.marker_kind === "import")) best.set(key, h);
    }
    for (const h of best.values()) findings.push(h);
  }

  return { findings };
}

module.exports = { globToRe, camelWords, commonTrailing, endsWithWords, identifiers, isDistinctive, computeG6 };
