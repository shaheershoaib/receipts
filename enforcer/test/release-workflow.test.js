"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/*
 * Guards on the release workflow. Publishing broke three separate ways while getting
 * 0.5.0 out, each from an edit to this file, and each failure surfaced ONLY at the moment
 * of release - the worst time to learn about it, and unreachable from PR CI because the
 * workflow runs on tags. These assert the load-bearing properties directly.
 *
 * The observed failures, for the record:
 *   - `npm install -g npm@latest` resolved to npm 12 (needs node ^22.22 || ^24.15 || >=26)
 *     against a node-20 runner -> EBADENGINE.
 *   - Dropping `registry-url` -> npm never attempts the OIDC exchange -> ENEEDAUTH.
 *   - No trusted publisher configured on npm -> E404 on PUT (npm masks auth failures as 404).
 */

const ROOT = path.join(__dirname, "..", "..");
// The trusted publisher on npmjs.com is bound to this EXACT filename. Renaming the file
// silently breaks publishing - npm rejects the OIDC identity and nothing else explains why.
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "release.yml");
const wf = () => fs.readFileSync(WORKFLOW_PATH, "utf8");

test("release.yml exists at the exact path the trusted publisher is bound to", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH),
    "the npm trusted publisher names the workflow FILENAME (release.yml); renaming or moving " +
    "this file breaks publishing with an unexplained 404");
});

test("id-token: write is present - OIDC cannot mint a credential without it", () => {
  assert.match(wf(), /^\s*id-token:\s*write\s*(#.*)?$/m);
});

test("setup-node keeps registry-url - without it npm never attempts OIDC", () => {
  assert.match(wf(), /registry-url:\s*['"]https:\/\/registry\.npmjs\.org['"]/,
    "removing registry-url was tried and produced ENEEDAUTH: setup-node must write the " +
    "registry line for trusted publishing to engage");
});

test("node is >= 22.14, the floor npm documents for trusted publishing", () => {
  const m = /node-version:\s*['"]?(\d+)(?:\.(\d+))?/.exec(wf());
  assert.ok(m, "no node-version pinned in the release workflow");
  const major = Number(m[1]);
  const minor = Number(m[2] || 0);
  assert.ok(major > 22 || (major === 22 && minor >= 14),
    `node ${major}.${minor} is below the documented 22.14 floor for trusted publishing`);
});

test("the npm upgrade is pinned to a major, never @latest", () => {
  const line = /npm install -g npm@(\S+)/.exec(wf());
  assert.ok(line, "the release workflow must install an npm new enough for trusted publishing");
  assert.notEqual(line[1], "latest",
    "npm@latest is a moving target whose engine requirement can outrun the pinned node - " +
    "exactly how the first v0.5.0 release attempt died (EBADENGINE)");
  assert.match(line[1], /^\^?\d+/, "pin the npm major (e.g. ^11)");
});

test("npm is new enough (>= 11.5.1) for trusted publishing", () => {
  const major = Number(/npm install -g npm@\^?(\d+)/.exec(wf())[1]);
  assert.ok(major >= 11, `npm ${major}.x is below the 11.5.1 floor for trusted publishing`);
});

test("publish carries --provenance", () => {
  assert.match(wf(), /npm publish[^\n]*--provenance/,
    "provenance is the verifiable link from the tarball back to the run that built it");
});

test("no NPM_TOKEN - trusted publishing must not fall back to a token", () => {
  const t = wf();
  assert.doesNotMatch(t, /NODE_AUTH_TOKEN:/,
    "an empty NODE_AUTH_TOKEN sends an empty credential; trusted publishing needs none");
  assert.doesNotMatch(t, /secrets\.NPM_TOKEN/,
    "npm retires 2FA-bypass tokens for direct publishing in January 2027 - do not reintroduce one");
});

test("the pre-publish gate still runs the full suite before anything reaches the registry", () => {
  const t = wf();
  for (const step of ["npm test", "plugin/hooks/test", "bench/run.js"])
    assert.ok(t.includes(step), `the release gate must still run ${step} before publishing`);
  assert.ok(t.indexOf("bench/run.js") < t.indexOf("npm publish"),
    "the gate must run BEFORE the publish step, not after");
});

test("the republish guard is present", () => {
  assert.match(wf(), /already on the registry/,
    "publishing over an existing version should fail loudly, not error mid-PUT");
});
