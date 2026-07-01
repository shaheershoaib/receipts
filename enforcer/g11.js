"use strict";
/*
 * G11 referee-integrity (the "don't shoot the referee" gate).
 *
 * The most-documented agent reward-hack: a test that cannot be made green is made to
 * DISAPPEAR - the file deleted, the case skipped (`.skip` / `xit` / `@pytest.mark.skip`),
 * or a snapshot regenerated wholesale so whatever the code now does IS the expectation.
 * The suite is green; its assertion power just dropped. G9 verifies the suite passes -
 * it cannot see that the suite was shrunk. G11 watches the referee itself.
 *
 * Three checks, all static over the base..head diff (no test run, so it can run on every
 * PR like G6). I/O injected for testability, like g6/g7:
 *   1. DELETED test files (renames are NOT deletions - the diff is taken with -M).
 *   2. Skip markers ADDED to changed test files, multi-framework (jest/mocha, pytest,
 *      unittest, go, rust, JUnit5, xUnit).
 *   3. SNAPSHOT churn: snapshot artifacts rewritten in a PR - green earned by making the
 *      current behavior the expectation is not proof the behavior is right.
 *
 * An honest escape hatch mirrors the downgrade tags: a `test-removal: <why>` line in the
 * PR body acknowledges intentional test removal/skip (a consolidation, a dead feature) -
 * the findings are then reported as acknowledged, never blocked.
 */

const TEST_PATH = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|\/__tests__\/|_spec\.)/i;
const SNAPSHOT_PATH = /(\.snap$|(^|\/)__snapshots__\/|\.ambr$|(^|\/)__image_snapshots__\/)/i;

// A skip marker that turns a test OFF, per framework. Anchored to marker shapes, not
// bare words, so prose mentioning "skip" does not count.
const SKIP_MARKERS = [
  // Negative lookbehinds keep the JS form from double-counting the python decorators
  // (@unittest.skip( / @pytest.mark.skip( also contain ".skip(").
  { re: /(?<!unittest)(?<!\bmark)\.skip\s*\(/g, name: ".skip(" }, // jest/mocha/vitest: test.skip / describe.skip
  { re: /\.todo\s*\(/g, name: ".todo(" },                        // test.todo
  { re: /\bx(it|describe|test)\s*\(/g, name: "xit(" },           // mocha/jasmine xit/xdescribe/xtest
  { re: /@pytest\.mark\.skip/g, name: "@pytest.mark.skip" },     // pytest (incl. skipif)
  { re: /@unittest\.skip/g, name: "@unittest.skip" },            // unittest (incl. skipIf/skipUnless)
  { re: /\bpytest\.skip\s*\(/g, name: "pytest.skip(" },
  { re: /\bt\.Skip\s*\(/g, name: "t.Skip(" },                    // go testing
  { re: /#\[ignore\b/g, name: "#[ignore]" },                     // rust
  { re: /@Disabled\b/g, name: "@Disabled" },                     // JUnit 5
  { re: /@Ignore\b/g, name: "@Ignore" },                         // JUnit 4
  { re: /\(Skip\s*=/g, name: "(Skip=" },                         // xUnit [Fact(Skip="...")]
  { re: /\bit\.only\s*\(|\btest\.only\s*\(|\bdescribe\.only\s*\(/g, name: ".only(" }, // .only silently skips EVERYTHING ELSE
];

// A skip marker is SYNTAX; the same characters inside a string literal are DATA (a test
// fixture describing a skip, a message mentioning one). Strip quoted strings before
// counting, so a file that merely *talks about* `.skip(` is not flagged - found by this
// very gate flagging its own test fixtures on the PR that introduced it.
function stripStrings(src) {
  return String(src || "").replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g, '""');
}

function countMarker(src, re) {
  const m = stripStrings(src).match(re);
  return m ? m.length : 0;
}

/*
 * computeG11({ nameStatus, readAt, base, head })
 *   nameStatus: [{ status: "A"|"M"|"D"|"R", file, to? }] - the -M name-status diff rows.
 *   -> { deletions: [file], skips: [{ file, marker, added }], snapshots: [file] }
 */
function computeG11(opts) {
  const { nameStatus, readAt, base, head } = opts;
  const deletions = [];
  const skips = [];
  const snapshots = [];

  for (const row of nameStatus || []) {
    const { status, file } = row;
    // Renames (R...) keep their referee - the test still exists under the new name; a
    // pure snapshot rename is likewise not a rewrite.
    if (status === "D" && TEST_PATH.test(file) && !SNAPSHOT_PATH.test(file)) deletions.push(file);
    if ((status === "A" || status === "M") && SNAPSHOT_PATH.test(file)) snapshots.push(file);
    if ((status === "M" || status === "A") && TEST_PATH.test(file) && !SNAPSHOT_PATH.test(file)) {
      const before = status === "A" ? "" : (readAt(base, file) || "");
      const after = readAt(head, file) || "";
      for (const { re, name } of SKIP_MARKERS) {
        const added = countMarker(after, re) - countMarker(before, re);
        if (added > 0) skips.push({ file, marker: name, added });
      }
    }
  }
  return { deletions, skips, snapshots };
}

// The honest escape hatch: a `test-removal: <why>` line (with actual content after the
// colon) acknowledges intentional removals/skips, mirroring the downgrade tags.
function testRemovalAcknowledged(prBody) {
  return /^\s*test-removal\s*:\s*\S/im.test(String(prBody || ""));
}

module.exports = { computeG11, testRemovalAcknowledged, stripStrings, SNAPSHOT_PATH };
