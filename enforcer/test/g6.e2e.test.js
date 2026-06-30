"use strict";
/*
 * G6 end-to-end (the user's exact problem): a pattern claimed "app-wide" but applied to only
 * some sibling surfaces. Here: pagination added to 2 of 4 *Table components.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { cfg, makeRepo, runVerify } = require("./helpers.js");

const PLAIN = "export const T = () => null;\n";
const WITH_PAG = 'import { Pagination } from "./Pagination";\nexport const T = () => null;\n';
const TABLES = ["OrdersTable", "UsersTable", "InvoicesTable", "ProductsTable"];

function tablesRepo(over = {}, adopt = ["OrdersTable", "UsersTable"]) {
  const baseFiles = { "receipts.config.json": cfg(over) };
  for (const t of TABLES) baseFiles[`src/${t}.tsx`] = PLAIN;
  const headFiles = {};
  for (const t of adopt) headFiles[`src/${t}.tsx`] = WITH_PAG;
  return makeRepo({ baseFiles, headFiles });
}
const g6warn = (v) => (v.warnings || []).find((w) => /G6 incomplete rollout/i.test(w));

// The headline case: an UNLINKED PR (no `closes #N`) that rolls pagination out to some tables
// still gets the missed twins flagged - G6 runs on every PR, not just fix-claims.
test("heuristic: incomplete rollout on an unlinked PR is surfaced (warn, exit 0)", () => {
  const r = tablesRepo();
  const v = runVerify({ ...r, prBody: "add pagination to the tables" }); // not a fix-claim
  assert.equal(v.exitCode, 0, v.raw);
  const w = g6warn(v);
  assert.ok(w, "expected a G6 warning: " + JSON.stringify(v.warnings));
  assert.match(w, /InvoicesTable/);
  assert.match(w, /ProductsTable/);
  assert.ok(!/OrdersTable/.test(w.split("lack it:")[1] || ""), "adopters are not listed as missing");
});

test("heuristic block mode: an incomplete rollout fails the gate", () => {
  const r = tablesRepo({ gates: { G6: { mode: "block" } } });
  const v = runVerify({ ...r, prBody: "add pagination" });
  assert.equal(v.verdict, "BLOCK", v.raw);
  assert.match(v.reason, /G6 incomplete rollout/i);
});

test("a COMPLETE rollout does not warn (no false positive)", () => {
  const r = tablesRepo({}, TABLES); // all four get pagination
  const v = runVerify({ ...r, prBody: "add pagination to every table" });
  assert.ok(!g6warn(v), "a complete rollout must not be flagged: " + JSON.stringify(v.warnings));
});

test("declared family: the project's coverage invariant flags the gaps", () => {
  const r = tablesRepo(
    { gates: { G6: { auto: false, surfaces: [{ name: "table pagination", glob: "src/**/*Table.tsx", marker: "Pagination" }] } } },
    ["OrdersTable"]); // only Orders gets it
  const v = runVerify({ ...r, prBody: "paginate orders" });
  const w = g6warn(v);
  assert.ok(w, "expected a declared-family G6 warning: " + JSON.stringify(v.warnings));
  assert.match(w, /table pagination/);
  assert.match(w, /UsersTable/);
});
