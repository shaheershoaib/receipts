"use strict";
/* Unit tests for the render-twin drift check (pure; changed-paths injected). */
const { test } = require("node:test");
const assert = require("node:assert");
const { computeRenderTwins } = require("../g6.js");

const TW = [{ name: "invoice", surfaces: ["**/invoice_view.tsx", "**/invoice_pdf.html"] }];

test("render_twins: touching SOME surfaces of a set but not all is flagged as drift", () => {
  const r = computeRenderTwins({ changed: ["app/ui/invoice_view.tsx"], twins: TW });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].name, "invoice");
  assert.deepEqual(r.findings[0].touched, ["**/invoice_view.tsx"]);
  assert.deepEqual(r.findings[0].untouched, ["**/invoice_pdf.html"]);
});

test("render_twins: touching ALL surfaces of a set is not drift", () => {
  const r = computeRenderTwins({ changed: ["a/invoice_view.tsx", "b/invoice_pdf.html"], twins: TW });
  assert.equal(r.findings.length, 0);
});

test("render_twins: touching NONE of a set's surfaces is not drift", () => {
  const r = computeRenderTwins({ changed: ["src/unrelated.ts"], twins: TW });
  assert.equal(r.findings.length, 0);
});

test("render_twins: a set with fewer than two surfaces is ignored", () => {
  const r = computeRenderTwins({ changed: ["a/only.tsx"], twins: [{ name: "x", surfaces: ["**/only.tsx"] }] });
  assert.equal(r.findings.length, 0);
});

test("render_twins: empty / missing / malformed config is a safe no-op", () => {
  assert.equal(computeRenderTwins({ changed: ["a.tsx"], twins: [] }).findings.length, 0);
  assert.equal(computeRenderTwins({ changed: ["a.tsx"] }).findings.length, 0);
  assert.equal(computeRenderTwins({ changed: ["a.tsx"], twins: [null, { surfaces: "nope" }] }).findings.length, 0);
});

test("render_twins: independent sets are evaluated separately", () => {
  const twins = [
    { name: "invoice", surfaces: ["**/inv_view.tsx", "**/inv_pdf.html"] },
    { name: "report", surfaces: ["**/rep_view.tsx", "**/rep_pdf.html"] },
  ];
  // touch invoice fully (no finding) but report partially (one finding)
  const r = computeRenderTwins({ changed: ["a/inv_view.tsx", "b/inv_pdf.html", "c/rep_view.tsx"], twins });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].name, "report");
});
