"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/*
 * spec/media.json is spec/MEDIA.md as data. Two representations of one fact (G15): the table
 * rows and the entries must name the same media, the contract must have the same nine
 * questions, and every medium `receipts init` can DETECT must resolve to an entry, or the
 * guard and doctor would print nothing for a project shape the detector recognises.
 */
const ROOT = path.join(__dirname, "..", "..");
const media = require(path.join(ROOT, "spec", "media.json"));
const md = fs.readFileSync(path.join(ROOT, "spec", "MEDIA.md"), "utf8");
const cli = fs.readFileSync(path.join(ROOT, "bin", "receipts.js"), "utf8");

const tableLabels = md.split("\n").filter((l) => /^\| /.test(l) && !/^\| Medium|^\|---/.test(l))
  .map((l) => l.split("|")[1].trim());

test("every MEDIA.md table row has a media.json entry with the same label, and vice versa", () => {
  const labels = Object.entries(media.media).filter(([id]) => id !== "unknown").map(([, m]) => m.label).sort();
  assert.deepEqual(labels, [...tableLabels].sort());
});

test("the contract has the nine questions MEDIA.md numbers", () => {
  const numbered = (md.match(/^\d+\. \*\*/gm) || []).length;
  assert.equal(media.contract.length, 9);
  assert.equal(numbered, 9, "MEDIA.md's observation contract changed length; update media.json");
  assert.deepEqual(media.contract.map((c) => c.key),
    ["surface", "value", "observe_by", "terminal_action", "build_artifact", "twin", "dependent", "receipt", "compat_boundary"]);
});

test("every medium id the detector can emit resolves to an entry (directly or via aliases)", () => {
  const emitted = [...new Set([...cli.matchAll(/medium = "([a-z]+)"/g)].map((m) => m[1]))];
  for (const id of emitted) {
    const resolved = media.media[id] || media.media[media.aliases[id]];
    assert.ok(resolved, `detector emits medium "${id}" but media.json has no entry or alias for it`);
  }
});

test("every entry carries the six row drafts and the four residue questions", () => {
  const reachKeys = media.reach.map((r) => r.key);
  for (const [id, m] of Object.entries(media.media)) {
    assert.deepEqual(Object.keys(m.row).sort(), ["build_artifact", "observe_by", "receipt", "surface", "terminal_action", "value"], id);
    assert.deepEqual(Object.keys(m.residue).sort(), [...reachKeys].sort(), id);
    for (const k of reachKeys) assert.ok(m.residue[k].length > 20, `${id}.residue.${k} is not a real question`);
  }
});
