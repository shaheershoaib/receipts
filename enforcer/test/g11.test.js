"use strict";
/* Unit tests for G11 referee-integrity logic (pure, injected in-memory I/O). */
const { test } = require("node:test");
const assert = require("node:assert");
const { computeG11, testRemovalAcknowledged } = require("../g11.js");

function env(baseTree, headTree) {
  const pick = (c) => (c === "BASE" ? baseTree : headTree);
  return {
    base: "BASE", head: "HEAD",
    readAt: (c, p) => (Object.prototype.hasOwnProperty.call(pick(c), p) ? pick(c)[p] : null),
  };
}

test("deleted test files are flagged; renames and production deletions are not", () => {
  const r = computeG11({
    ...env({}, {}),
    nameStatus: [
      { status: "D", file: "src/auth.test.js" },
      { status: "R", file: "src/old.test.js", to: "src/new.test.js" },
      { status: "D", file: "src/legacy-helper.js" }, // production code, not a referee
      { status: "M", file: "src/app.js" },
    ],
  });
  assert.deepEqual(r.deletions, ["src/auth.test.js"], "only the real test deletion counts");
});

test("skip/focus markers ADDED to a changed test are flagged, pre-existing ones are not", () => {
  const base = { "a.test.js": "test.skip('old flake', t1);\ntest('b', t2);\n" };
  const head = { "a.test.js": "test.skip('old flake', t1);\ntest.skip('b', t2);\nit.only('c', t3);\n" };
  const r = computeG11({
    ...env(base, head),
    nameStatus: [{ status: "M", file: "a.test.js" }],
  });
  const markers = r.skips.map((s) => s.marker).sort();
  assert.deepEqual(markers, [".only(", ".skip("], "one NEW .skip and one NEW .only; the pre-existing skip is not re-flagged");
  assert.equal(r.skips.find((s) => s.marker === ".skip(").added, 1);
});

test("multi-framework markers: pytest / unittest / go / rust / junit / xunit", () => {
  const cases = [
    ["test_x.py", "@pytest.mark.skip\ndef test_a(): pass\n"],
    ["test_y.py", "@unittest.skip('later')\ndef test_b(): pass\n"],
    ["pkg/x_test.go", "func TestA(t *testing.T) { t.Skip(\"later\") }\n"],
    ["tests/z.rs", "#[ignore]\nfn test_c() {}\n"],
    ["src/test/AJavaTest.java", "@Disabled\nvoid testD() {}\n"],
    ["Tests/BTest.cs", "[Fact(Skip=\"later\")]\npublic void TestE() {}\n"],
  ];
  for (const [file, src] of cases) {
    const r = computeG11({
      ...env({ [file]: "" }, { [file]: src }),
      nameStatus: [{ status: "M", file }],
    });
    assert.equal(r.skips.length, 1, `${file}: expected the added skip marker to be flagged`);
  }
});

test("snapshot churn: modified/added snapshots flagged, deletions and renames not", () => {
  const r = computeG11({
    ...env({}, {}),
    nameStatus: [
      { status: "M", file: "src/__snapshots__/App.test.tsx.snap" },
      { status: "A", file: "src/__snapshots__/New.test.tsx.snap" },
      { status: "D", file: "src/__snapshots__/Dead.test.tsx.snap" },
      { status: "R", file: "src/__snapshots__/Old.snap", to: "src/__snapshots__/Renamed.snap" },
    ],
  });
  assert.deepEqual(r.snapshots.sort(), [
    "src/__snapshots__/App.test.tsx.snap",
    "src/__snapshots__/New.test.tsx.snap",
  ]);
});

test("a deleted snapshot is not double-counted as a deleted test", () => {
  const r = computeG11({
    ...env({}, {}),
    nameStatus: [{ status: "D", file: "src/__snapshots__/App.test.tsx.snap" }],
  });
  assert.deepEqual(r.deletions, [], "snapshot artifacts are churn, not referees");
});

test("markers inside STRING LITERALS are data, not skips (no false positive)", () => {
  // The self-referential case: a test whose fixtures/messages mention markers as strings
  // (this very suite) must not be flagged. Found live: G11 flagged its own test file.
  const base = { "meta.test.js": "test('a', t);\n" };
  const head = {
    "meta.test.js":
      "test('a', t);\n" +
      "const fixture = \"test.skip('x', f); @pytest.mark.skip t.Skip( xit(\";\n" +
      "assert.ok(msg.includes('.skip('));\n" +
      "const tpl = `describe.skip( @Disabled #[ignore]`;\n",
  };
  const r = computeG11({
    ...env(base, head),
    nameStatus: [{ status: "M", file: "meta.test.js" }],
  });
  assert.deepEqual(r.skips, [], "string-literal marker mentions are not skips");
});

test("test-removal acknowledgment: real tag matches, bare mention does not", () => {
  assert.ok(testRemovalAcknowledged("test-removal: consolidated into auth.e2e.test.ts"));
  assert.ok(testRemovalAcknowledged("Closes #9\n  Test-Removal: feature deleted, see #8"));
  assert.ok(!testRemovalAcknowledged("we discussed test-removal:\n"), "no content after the colon");
  assert.ok(!testRemovalAcknowledged("no tag here"));
});
