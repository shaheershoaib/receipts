"use strict";
/*
 * Package-integrity tests (the shipped-artifact class): the published npm package must
 * carry every module its shipped entry points require. 0.2.0 shipped enforcer/verify.js
 * WITHOUT enforcer/g6.js (its own require), so `npx receipts-cli verify` crashed on
 * arrival with MODULE_NOT_FOUND - while CI stayed green, because CI tests the repo tree,
 * where every module exists regardless of the `files` allowlist. A green that tested the
 * wrong artifact (G3's lesson, applied to our own release pipeline).
 *
 * Two static receipts against that class:
 *   1. walk the relative require() graph from the shipped entry points and assert the
 *      `files` allowlist covers every file reached;
 *   2. keep the marketplace listing's version in lockstep with the plugin manifest.
 * (pack.e2e.test.js is the dynamic half: it runs a real verification through an actual
 * `npm pack` tarball.)
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

// npm `files` semantics (the subset this package uses - no globs): an entry includes
// that exact file, or that directory's whole subtree.
function coveredBy(files, rel) {
  return files.some((f) => rel === f || rel.startsWith(f.replace(/\/$/, "") + "/"));
}

// All relative require() specifiers in a CJS source (regex-level, like the enforcer).
function relativeRequires(src) {
  const out = [];
  const re = /require\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

function resolveRel(fromRel, spec) {
  let p = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (!/\.(js|json|node)$/.test(p)) p += ".js";
  return p;
}

test("npm files allowlist covers the shipped require graph (the 0.2.0 g6.js hole)", () => {
  const pkg = readJson("package.json");
  // Entry points the package exposes: the bin, and the engine the bin spawns.
  const queue = ["bin/receipts.js", "enforcer/verify.js"];
  const seen = new Set();
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    assert.ok(
      coveredBy(pkg.files, rel),
      `${rel} is required by a shipped module but not covered by package.json "files" - ` +
      `the published CLI would crash with MODULE_NOT_FOUND (this is exactly how 0.2.0 shipped broken)`
    );
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const spec of relativeRequires(src)) queue.push(resolveRel(rel, spec));
  }
  // Not a require, but a runtime read: the loop-skill template `init` scaffolds from.
  assert.ok(
    coveredBy(pkg.files, "plugin/templates/loop-skill/SKILL.md.tmpl"),
    "the loop-skill template init scaffolds from must ship in files"
  );
});

test("marketplace listing version tracks the plugin manifest", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const plugin = readJson("plugin/.claude-plugin/plugin.json");
  assert.equal(
    marketplace.version,
    plugin.version,
    ".claude-plugin/marketplace.json version drifted from plugin/.claude-plugin/plugin.json - bump the pair together (see the README release checklist)"
  );
});
