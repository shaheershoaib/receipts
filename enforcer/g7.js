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
 * without git. Scope (honest): built-in JS/TS and Python import scanners, plus an
 * explicit consumer graph (gates.G7.graph) for any stack. Other languages degrade to
 * "not computed" rather than a false all-clear.
 *
 * Python scope (honest): repo-relative resolution - absolute imports that map onto
 * package dirs present in the repo (`a.b.c` -> a/b/c.py or a/b/c/__init__.py) and
 * relative imports (`from ..util import x`). src/-layout indirection, namespace
 * packages, and sys.path tricks are NOT modeled - those repos use gates.G7.graph.
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

// ------------------------------------------------------------------------ python

const PY_EXT = /\.py$/;
// Vendored / environment python that is never a project consumer.
const PY_VENDOR = /(^|\/)(\.venv|venv|env|site-packages|__pycache__|\.tox)\//;

// Module key: "pkg/mod.py" -> "pkg/mod"; a package's __init__.py -> the package dir.
function pyKey(p) { return String(p || "").replace(PY_EXT, "").replace(/\/__init__$/, ""); }

/*
 * All candidate module KEYS a python source imports, resolved against the importer's
 * location. `from PKG import name` emits PKG as a definite key and PKG.name as a GUESS
 * (the import-a-submodule form) - `name` may equally be a mere symbol, and a guess key
 * is NOT harmless when the repo happens to contain a file at that exact path for
 * unrelated reasons (a phantom dependent). pyImportScan returns the two classes
 * separately so the caller can disambiguate against the file tree: when `PKG.py` itself
 * exists, the import resolved to that module file and the guess is dropped.
 * pyImportKeys stays the flat union (back-compat). Regex-level, like the JS scanner.
 */
function pyImportScan(importerPath, src) {
  const keys = new Set();
  const guesses = new Set();
  const dir = path.posix.dirname(importerPath);
  const fromDots = (dots) => {
    // 1 dot = the importer's own package dir; each extra dot walks one level up.
    let d = dir === "." ? "" : dir;
    for (let i = 1; i < dots; i++) d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
    return d;
  };
  const addTo = (set, baseDir, moduleDotted) => {
    const rel = moduleDotted ? moduleDotted.split(".").join("/") : "";
    const joined = baseDir && rel ? `${baseDir}/${rel}` : baseDir || rel;
    if (joined) set.add(path.posix.normalize(joined));
  };
  const add = (baseDir, moduleDotted) => addTo(keys, baseDir, moduleDotted);
  const guess = (baseDir, moduleDotted) => addTo(guesses, baseDir, moduleDotted);
  const text = String(src || "");
  let m;
  // from <dots><module> import a, b as c
  const fromRe = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([^\n#]+)/gm;
  while ((m = fromRe.exec(text))) {
    const dots = m[1].length;
    const mod = m[2];
    const baseDir = dots > 0 ? fromDots(dots) : "";
    if (dots > 0) {
      if (mod) add(baseDir, mod);
      // from . import sib  /  from .pkg import sub - each name MAY be a module (a guess).
      for (const name of m[3].split(",")) {
        const n = name.trim().split(/[ \t]+as[ \t]+/)[0].trim();
        if (/^\w+$/.test(n)) guess(baseDir, mod ? `${mod}.${n}` : n);
      }
    } else if (mod) {
      add("", mod);
      for (const name of m[3].split(",")) {
        const n = name.trim().split(/[ \t]+as[ \t]+/)[0].trim();
        if (/^\w+$/.test(n)) guess("", `${mod}.${n}`);
      }
    }
  }
  // import a.b, c as d
  const impRe = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm;
  while ((m = impRe.exec(text))) {
    for (const part of m[1].split(",")) {
      const mod = part.trim().split(/[ \t]+as[ \t]+/)[0].trim();
      if (mod) add("", mod);
    }
  }
  return { keys: [...keys], guesses: [...guesses].filter((g) => !keys.has(g)) };
}

// Flat union of definite keys + guesses (the historical shape).
function pyImportKeys(importerPath, src) {
  const { keys, guesses } = pyImportScan(importerPath, src);
  return [...new Set([...keys, ...guesses])];
}

// A from-import GUESS key (`from pkg.mod import thing` -> `pkg/mod/thing`) names a real
// submodule only when `pkg/mod` is a PACKAGE directory. When `pkg/mod.py` exists in the
// tree, the import resolved to that module file, `thing` is a symbol, and the guess is a
// phantom that can alias an unrelated file at that path - drop it.
function pyGuessIsModule(guessKey, fileSet) {
  const i = String(guessKey).lastIndexOf("/");
  if (i <= 0) return true; // top-level name: nothing to disambiguate against
  return !fileSet.has(guessKey.slice(0, i) + ".py");
}

// Co-located tests for a python source that exist at head: pkg/test_x.py, pkg/x_test.py,
// pkg/tests/test_x.py, and a root-level tests/test_x.py.
function pyCoLocatedTests(file, headSet) {
  const dir = path.posix.dirname(file);
  const stem = path.posix.basename(file).replace(PY_EXT, "");
  const at = (d, name) => (d === "." || d === "" ? name : `${d}/${name}`);
  const candidates = [
    at(dir, `test_${stem}.py`),
    at(dir, `${stem}_test.py`),
    at(dir, `tests/test_${stem}.py`),
    `tests/test_${stem}.py`,
  ];
  return [...new Set(candidates.filter((c) => headSet.has(c)))];
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
// Per-ecosystem dispatch: what keys a source imports, a changed file's key, its tests.
// `fileSet` (the tree at the ref being scanned) lets the python path drop phantom
// from-import guesses (see pyGuessIsModule); without it the flat union is returned.
function importKeysOf(file, src, fileSet) {
  if (JS_EXT.test(file)) return jsImports(src).map((s) => resolveJsKey(file, s)).filter(Boolean);
  if (PY_EXT.test(file)) {
    if (!fileSet) return pyImportKeys(file, src);
    const { keys, guesses } = pyImportScan(file, src);
    return keys.concat(guesses.filter((g) => pyGuessIsModule(g, fileSet)));
  }
  return [];
}
function keyOf(file) {
  if (JS_EXT.test(file)) return jsKey(file);
  if (PY_EXT.test(file)) return pyKey(file);
  return file;
}
function testsOf(file, headSet) {
  if (PY_EXT.test(file)) return pyCoLocatedTests(file, headSet);
  return coLocatedTests(file, headSet);
}
const isScannable = (f) =>
  (JS_EXT.test(f) && !f.includes("node_modules/")) || (PY_EXT.test(f) && !PY_VENDOR.test(f));

function computeNewDependents(opts) {
  const { base, head, changedSource, listAt, readAt, graph, allDependents } = opts;
  const haveGraph = graph && typeof graph === "object";
  const scannableChanged = (changedSource || []).filter((f) => JS_EXT.test(f) || PY_EXT.test(f));
  if (!haveGraph && !scannableChanged.length) {
    return { computed: false, supported: false, newDependents: [], note: "no JS/TS or Python changes and no gates.G7.graph - dependents not computed for this stack" };
  }

  const changedByKey = new Map(scannableChanged.map((f) => [keyOf(f), f]));
  const headFiles = listAt(head) || [];
  const headSet = new Set(headFiles);
  const deps = new Map(); // importer -> Set(changed file it imports)

  if (haveGraph) {
    for (const [importer, imported] of Object.entries(graph)) {
      if (TEST_PATH.test(importer)) continue; // a test is not a production consumer
      for (const imp of imported || []) {
        const k = keyOf(imp);
        const hit = (changedSource || []).find((c) => c === imp || keyOf(c) === k);
        if (hit) addDep(deps, importer, hit);
      }
    }
  } else {
    for (const f of headFiles) {
      if (!isScannable(f) || TEST_PATH.test(f)) continue;
      const src = readAt(head, f);
      if (!src) continue;
      for (const key of importKeysOf(f, src, headSet)) {
        if (changedByKey.has(key)) addDep(deps, f, changedByKey.get(key));
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
        // new-edge: did this importer import the changed file at base? (scan mode only)
        const baseKeys = new Set(importKeysOf(importer, readAt(base, importer) || "", baseSet));
        for (const c of changedImports) {
          if (!baseKeys.has(keyOf(c))) { isNew = true; reason = "new-edge"; break; }
        }
      }
    }
    if (!isNew) continue;
    newDependents.push({
      file: importer,
      imports: [...changedImports],
      tests: testsOf(importer, headSet),
      reason,
    });
  }
  newDependents.sort((a, b) => a.file.localeCompare(b.file));
  return { computed: true, supported: true, newDependents, note: null };
}

module.exports = { jsKey, jsImports, resolveJsKey, coLocatedTests, pyKey, pyImportKeys, pyImportScan, pyGuessIsModule, pyCoLocatedTests, computeNewDependents };
