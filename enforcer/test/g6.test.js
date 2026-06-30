"use strict";
/* Unit tests for G6 surface-coverage logic (pure, injected in-memory I/O). */
const { test } = require("node:test");
const assert = require("node:assert");
const { globToRe, camelWords, commonTrailing, isDistinctive, computeG6 } = require("../g6.js");

function env(baseTree, headTree) {
  const pick = (c) => (c === "BASE" ? baseTree : headTree);
  return {
    base: "BASE", head: "HEAD",
    listAt: (c) => Object.keys(pick(c)),
    readAt: (c, p) => (Object.prototype.hasOwnProperty.call(pick(c), p) ? pick(c)[p] : null),
  };
}
const names = (findings, kind) => findings.filter((f) => !kind || f.kind === kind).flatMap((f) => f.uncovered).sort();

test("globToRe matches nested and flat, rejects non-members", () => {
  const re = globToRe("src/**/*Table.tsx");
  assert.ok(re.test("src/tables/OrdersTable.tsx"));
  assert.ok(re.test("src/OrdersTable.tsx"));
  assert.ok(!re.test("src/OrdersChart.tsx"));
  assert.ok(!re.test("app/OrdersTable.ts"));
});

test("camelWords / commonTrailing extract the family signature", () => {
  assert.deepEqual(camelWords("OrdersTable.tsx"), ["Orders", "Table"]);
  assert.deepEqual(camelWords("orders_table.py"), ["orders", "table"]);
  assert.deepEqual(commonTrailing([["Orders", "Table"], ["Users", "Table"]]), ["Table"]);
  assert.deepEqual(commonTrailing([["Orders", "List"], ["User", "Card"]]), []);
});

test("declared: uncovered family members are flagged when the PR touches the marker", () => {
  const PAG = 'import {Pagination} from "./Pagination"; export const T=()=>null;';
  const PLAIN = "export const T=()=>null;";
  const base = {
    "src/OrdersTable.tsx": PLAIN, "src/UsersTable.tsx": PLAIN, "src/InvoicesTable.tsx": PLAIN,
  };
  const head = {
    "src/OrdersTable.tsx": PAG, "src/UsersTable.tsx": PAG, "src/InvoicesTable.tsx": PLAIN, // Invoices missed
  };
  const r = computeG6({
    ...env(base, head),
    changed: ["src/OrdersTable.tsx", "src/UsersTable.tsx"],
    surfaces: [{ name: "table pagination", glob: "src/**/*Table.tsx", marker: "Pagination" }],
    auto: false,
  });
  assert.deepEqual(names(r.findings, "declared"), ["src/InvoicesTable.tsx"]);
});

test("declared: not flagged when the PR did not touch the marker (unless `always`)", () => {
  const PAG = "Pagination here";
  const PLAIN = "no marker";
  const trees = { "src/OrdersTable.tsx": PAG, "src/InvoicesTable.tsx": PLAIN };
  // PR changed an unrelated file; the family marker is untouched -> no finding
  const r = computeG6({
    ...env(trees, trees), changed: ["src/unrelated.ts"],
    surfaces: [{ glob: "src/**/*Table.tsx", marker: "Pagination" }], auto: false,
  });
  assert.equal(r.findings.length, 0);
  // `always` makes it a standing invariant -> flagged regardless of touch
  const r2 = computeG6({
    ...env(trees, trees), changed: ["src/unrelated.ts"],
    surfaces: [{ glob: "src/**/*Table.tsx", marker: "Pagination", always: true }], auto: false,
  });
  assert.deepEqual(names(r2.findings), ["src/InvoicesTable.tsx"]);
});

test("heuristic: an import rolled out to >=2 siblings flags the twins that missed it", () => {
  const withPag = 'import {Pagination} from "./Pagination";\nexport const T=()=>null;';
  const plain = "export const T=()=>null;";
  const base = {
    "src/OrdersTable.tsx": plain, "src/UsersTable.tsx": plain,
    "src/InvoicesTable.tsx": plain, "src/ProductsTable.tsx": 'import {Pagination} from "./Pagination";\nx', // already has it
  };
  const head = {
    "src/OrdersTable.tsx": withPag, "src/UsersTable.tsx": withPag, // adopters
    "src/InvoicesTable.tsx": plain, // missed
    "src/ProductsTable.tsx": 'import {Pagination} from "./Pagination";\nx', // covered
  };
  const r = computeG6({
    ...env(base, head),
    changed: ["src/OrdersTable.tsx", "src/UsersTable.tsx"],
  });
  assert.deepEqual(names(r.findings, "heuristic"), ["src/InvoicesTable.tsx"]);
});

test("isDistinctive: any affordance (incl. flat props) yes, ubiquitous plumbing no", () => {
  for (const t of ["Pagination", "ErrorBoundary", "useAuth", "rateLimit", "reportError", "aria-label", "data-testid", "MAX_RETRIES", "disabled", "loading", "selected", "subtotal"])
    assert.ok(isDistinctive(t), `${t} should be distinctive`);
  for (const t of ["value", "data", "item", "name", "error", "index", "if", "id", "return", "useState", "props", "div", "input"])
    assert.ok(!isDistinctive(t), `${t} should NOT be distinctive`);
});

test("heuristic generalizes beyond imports: a JSX ATTRIBUTE rolled out to siblings", () => {
  const withAria = '<input aria-label="x" />';
  const plain = "<input />";
  const base = { "src/NameInput.tsx": plain, "src/EmailInput.tsx": plain, "src/PhoneInput.tsx": plain };
  const head = { "src/NameInput.tsx": withAria, "src/EmailInput.tsx": withAria, "src/PhoneInput.tsx": plain };
  const r = computeG6({ ...env(base, head), changed: ["src/NameInput.tsx", "src/EmailInput.tsx"] });
  assert.deepEqual(names(r.findings, "heuristic"), ["src/PhoneInput.tsx"]);
});

test("heuristic generalizes beyond imports: a CALL rolled out to siblings", () => {
  const withCall = 'export const s = () => { reportError("e"); };';
  const plain = "export const s = () => {};";
  const base = { "src/AuthService.ts": plain, "src/UserService.ts": plain, "src/CartService.ts": plain };
  const head = { "src/AuthService.ts": withCall, "src/UserService.ts": withCall, "src/CartService.ts": plain };
  const r = computeG6({ ...env(base, head), changed: ["src/AuthService.ts", "src/UserService.ts"] });
  assert.deepEqual(names(r.findings, "heuristic"), ["src/CartService.ts"]);
});

test("heuristic catches a flat-lowercase affordance (disabled), suppresses a ubiquitous word (value)", () => {
  const withDisabled = "<button disabled />";
  const plain = "<button />";
  const base = { "src/SaveButton.tsx": plain, "src/EditButton.tsx": plain, "src/DeleteButton.tsx": plain };
  const head = { "src/SaveButton.tsx": withDisabled, "src/EditButton.tsx": withDisabled, "src/DeleteButton.tsx": plain };
  // `disabled` is a real prop, not a stopword -> now auto-flagged (the broadened rule)
  const r = computeG6({ ...env(base, head), changed: ["src/SaveButton.tsx", "src/EditButton.tsx"] });
  assert.deepEqual(names(r.findings, "heuristic"), ["src/DeleteButton.tsx"]);
  // a ubiquitous plumbing word rolled out the same way is suppressed (the noise floor)
  const wv = "const value = 1;", pv = "const z = 1;";
  const b2 = { "src/SaveButton.tsx": pv, "src/EditButton.tsx": pv, "src/DeleteButton.tsx": pv };
  const h2 = { "src/SaveButton.tsx": wv, "src/EditButton.tsx": wv, "src/DeleteButton.tsx": pv };
  const r2 = computeG6({ ...env(b2, h2), changed: ["src/SaveButton.tsx", "src/EditButton.tsx"] });
  assert.equal(r2.findings.length, 0);
});

test("heuristic: a single adopter or no common family does NOT fire", () => {
  const withPag = 'import {Pagination} from "./Pagination"; x';
  const plain = "x";
  // single adopter
  const r1 = computeG6({
    ...env({ "src/OrdersTable.tsx": plain, "src/UsersTable.tsx": plain },
           { "src/OrdersTable.tsx": withPag, "src/UsersTable.tsx": plain }),
    changed: ["src/OrdersTable.tsx"],
  });
  assert.equal(r1.findings.length, 0, "one adopter is not a rollout");
  // two adopters but no shared trailing word -> no confident family
  const r2 = computeG6({
    ...env({ "src/OrderList.tsx": plain, "src/UserCard.tsx": plain, "src/ItemList.tsx": plain },
           { "src/OrderList.tsx": withPag, "src/UserCard.tsx": withPag, "src/ItemList.tsx": plain }),
    changed: ["src/OrderList.tsx", "src/UserCard.tsx"],
  });
  assert.equal(r2.findings.length, 0, "no common family signature");
});
