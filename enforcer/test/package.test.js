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
  // Also a runtime read: the schema the enforcer derives its known config keys from.
  assert.ok(
    coveredBy(pkg.files, "receipts.config.schema.json"),
    "receipts.config.schema.json must ship in files - verify.js reads it at load for key validation"
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
  // The npm package is the third leg of the same release: a publish whose version
  // disagrees with the plugin pair ships a CLI that misreports what it is (found
  // during the 0.3.0 cut - nothing enforced package.json until this line).
  const pkg = readJson("package.json");
  assert.equal(
    pkg.version,
    plugin.version,
    "package.json version drifted from the plugin manifest - bump all three together"
  );
});

// The spec and the gate range are stated in five places that were all different at once:
// README said gates@1.4 while the spec said 1.5; plugin.json said G0-G17, marketplace.json
// G0-G14, the README table stopped at G14, and GATES.md shipped G19. Nothing derives them, so
// this pins every statement to the one source of truth - spec/GATES.md - the same way the
// versions above are pinned to the plugin manifest.
test("the spec version and the gate range agree everywhere they are stated", () => {
  const spec = fs.readFileSync(path.join(ROOT, "spec/GATES.md"), "utf8");
  const specVersion = (spec.match(/Spec version: `receipts\/gates@(\d+\.\d+)`/) || [])[1];
  assert.ok(specVersion, "spec/GATES.md must state its version as `receipts/gates@X.Y`");
  const maxGate = Math.max(...[...spec.matchAll(/^## G(\d+)\b/gm)].map((m) => Number(m[1])));
  assert.ok(maxGate >= 19, "expected at least G19 in spec/GATES.md");
  const range = `G0-G${maxGate}`;

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const v of readme.matchAll(/receipts\/gates@(\d+\.\d+)/g))
    assert.equal(v[1], specVersion, `README cites receipts/gates@${v[1]} but spec/GATES.md is ${specVersion}`);
  assert.ok(readme.includes(range), `README must name the full gate range ${range}`);

  const plugin = readJson("plugin/.claude-plugin/plugin.json");
  assert.ok(plugin.description.includes(range), `plugin.json description must say ${range}`);
  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.ok(marketplace.description.includes(range), `marketplace.json description must say ${range}`);
  for (const p of marketplace.plugins)
    assert.ok(p.description.includes(range), `marketplace plugin "${p.name}" description must say ${range}`);
  // Any other range in a manifest is stale (a G0-G17 that survived a G19 spec).
  for (const text of [plugin.description, marketplace.description, ...marketplace.plugins.map((p) => p.description)])
    for (const m of text.matchAll(/G0-G(\d+)/g))
      assert.equal(Number(m[1]), maxGate, `stale gate range G0-G${m[1]} in a manifest (spec has ${range})`);
});
