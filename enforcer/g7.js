"use strict";
/*
 * G7 dependent-test-selection (the enforcer assist).
 *
 * The carried receipt proves the CHANGED surface is fixed. G7 asks the second question the
 * receipt cannot: did the change break a downstream CONSUMER - especially one that newly
 * routes through what you changed? This module computes the NEW dependents of the changed
 * files and maps each to its co-located tests, so the enforcer can re-run those at the PR.
 *
 * I/O is INJECTED (listAt / readAt over a commit) so the graph logic is unit-testable
 * without git. Scope (honest): a built-in JS/TS import scanner, plus an explicit consumer
 * graph (gates.G7.graph) for any stack. Other languages degrade to "not computed" rather
 * than a false all-clear.
 */
const path = require("path");

const JS_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;
const JS_TEST_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_SUFFIX = [".test", ".spec"];
// A file that is itself a test (mirrors verify.js TEST_PATH). A test importing the changed
// file is the VERIFICATION, not a production consumer to re-verify - so it is not a dependent.
const TEST_PATH = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|\/__tests__\/|_spec\.)/i;

// Module key = repo-relative path with the JS/TS extension and a trailing /index stripped, so
// "src/field.ts", "src/field/index.ts" and an import of "./field" all reduce to "src/field".
function jsKey(p) { return String(p || "").replace(JS_EXT, "").replace(/\/index$/, ""); }

// Pull import/require/export-from/dynamic-import specifiers out of JS/TS source (regex-level,
// like the rest of the enforcer - good enough to find edges, not a full parser).
function jsImports(src) {
  const specs = [];
  const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(String(src || "")))) specs.push(m[1]);
  return specs;
}

// Resolve a relative specifier from an importer to a module key; null for bare/external specs.
function resolveJsKey(importerPath, spec) {
  if (!spec || !spec.startsWith(".")) return null;
  const dir = path.posix.dirname(importerPath);
  return jsKey(path.posix.normalize(path.posix.join(dir, spec)));
}

// Co-located tests for a source file that exist at head: x.ts -> x.test.ts / x.spec.tsx, and
// __tests__/x.test.ts. Returns the ones present in headSet.
function coLocatedTests(file, headSet) {
  const key = jsKey(file);
  const dir = path.posix.dirname(file);
  const baseName = key.slice(dir === "." ? 0 : dir.length + 1);
  const out = [];
  for (const suf of TEST_SUFFIX) {
    for (const ext of JS_TEST_EXT) {
      const direct = key + suf + ext;
      if (headSet.has(direct)) out.push(direct);
      const inTests = path.posix.join(dir, "__tests__", baseName + suf + ext);
      if (headSet.has(inTests)) out.push(inTests);
    }
  }
  return [...new Set(out)];
}

function addDep(map, importer, changedFile) {
  if (!map.has(importer)) map.set(importer, new Set());
  if (changedFile) map.get(importer).add(changedFile);
}

/*
 * computeNewDependents({ base, head, changedSource, listAt, readAt, graph, allDependents })
 *   -> { computed, supported, newDependents: [{ file, imports, tests, reason }], note }
 *
 * - graph (optional): a consumer graph object { importerPath: [importedPath, ...] }. Used for
 *   any stack; new-edge detection needs the graph at base too (not read here), so in graph
 *   mode a dependent is "new" only if its file is new (or allDependents is set).
 * - built-in JS/TS scan otherwise: detects both a NEW file and a NEW edge (an importer that
 *   did not import the changed file at base but does at head) - the freshly-routed consumer.
 */
function computeNewDependents(opts) {
  const { base, head, changedSource, listAt, readAt, graph, allDependents } = opts;
  const haveGraph = graph && typeof graph === "object";
  const jsChanged = (changedSource || []).filter((f) => JS_EXT.test(f));
  if (!haveGraph && !jsChanged.length) {
    return { computed: false, supported: false, newDependents: [], note: "no JS/TS changes and no gates.G7.graph - dependents not computed for this stack" };
  }

  const changedKeys = new Set(jsChanged.map(jsKey));
  const headFiles = listAt(head) || [];
  const headSet = new Set(headFiles);
  const deps = new Map(); // importer -> Set(changed file it imports)

  if (haveGraph) {
    for (const [importer, imported] of Object.entries(graph)) {
      if (TEST_PATH.test(importer)) continue; // a test is not a production consumer
      for (const imp of imported || []) {
        const k = jsKey(imp);
        const hit = (changedSource || []).find((c) => c === imp || jsKey(c) === k);
        if (hit) addDep(deps, importer, hit);
      }
    }
  } else {
    for (const f of headFiles) {
      if (!JS_EXT.test(f) || f.includes("node_modules/") || TEST_PATH.test(f)) continue;
      const src = readAt(head, f);
      if (!src) continue;
      for (const spec of jsImports(src)) {
        const key = resolveJsKey(f, spec);
        if (key && changedKeys.has(key)) addDep(deps, f, jsChanged.find((c) => jsKey(c) === key));
      }
    }
  }

  const baseSet = new Set(listAt(base) || []);
  const newDependents = [];
  for (const [importer, changedImports] of deps) {
    let isNew = !!allDependents;
    let reason = allDependents ? "all-dependents" : null;
    if (!isNew) {
      if (!baseSet.has(importer)) { isNew = true; reason = "new-file"; }
      else if (!haveGraph) {
        // new-edge: did this importer import the changed file at base? (JS scan only)
        const baseSrc = readAt(base, importer) || "";
        const baseKeys = new Set(jsImports(baseSrc).map((s) => resolveJsKey(importer, s)).filter(Boolean));
        for (const c of changedImports) {
          if (!baseKeys.has(jsKey(c))) { isNew = true; reason = "new-edge"; break; }
        }
      }
    }
    if (!isNew) continue;
    newDependents.push({
      file: importer,
      imports: [...changedImports],
      tests: coLocatedTests(importer, headSet),
      reason,
    });
  }
  newDependents.sort((a, b) => a.file.localeCompare(b.file));
  return { computed: true, supported: true, newDependents, note: null };
}

module.exports = { jsKey, jsImports, resolveJsKey, coLocatedTests, computeNewDependents };
