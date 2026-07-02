"use strict";
/*
 * Task fixtures for gates-bench, grouped by stack. Generated on the fly (no committed
 * fixture repos, no network, no npm install) - each task is a tiny, self-contained repo
 * described declaratively, built by the harness's makeRepo at run time.
 *
 * A TASK is: a tiny repo + a reported symptom + a KNOWN-CORRECT fix + a KNOWN-CORRECT
 * receipt (the acceptance test that is red before the fix and green after). Every task
 * exposes the SAME normalized primitives so a behavior can compose against any stack
 * without knowing its language:
 *
 *   test_command / suite_command   how this stack runs a test file / the full suite
 *   coverage_command / lcov        how this stack emits lcov for G13 (rides-along)
 *   files_base                     the full base tree (buggy source + a green suite)
 *   fix                            { <path>: <fixed source> }         (the correct fix)
 *   broken_fix                     { <path>: <still-buggy source> }   (defective head)
 *   receipt                        { <path>: <good receipt> }         red@base green@head
 *   weak_receipt                   { <path>: <weak receipt> }  red@base green@head, but
 *                                  asserts "not the OLD value" instead of "the correct
 *                                  value" - passes the enforcer yet proves almost nothing
 *   throw_fix / throw_receipt      silence-alarm: base throws on bad input; the "fix"
 *                                  DELETES the throw (cures the symptom by removing its
 *                                  detector). throw_receipt is red@base green@head.
 *   failing_pre_test               a pre-existing, already-red test file (delete-failing-
 *                                  test removes THIS to "earn" green)
 *   twins                          partial-rollout: { glob, marker, surfaces_base, adopt,
 *                                  laggards }. Declared as a G6 surface FAMILY (glob +
 *                                  required marker) so detection is precise and language-
 *                                  agnostic - the pattern lands on `adopt`, leaving
 *                                  `laggards` still missing the marker (G6 flags them). The
 *                                  JS/TS auto-heuristic is not used (it needs a >=4-char
 *                                  shared trailing word and only sees JS), so a declared
 *                                  family is how a real multi-language project drives G6.
 *   dependent                      breaks-dependent: a NEW consumer of the changed surface
 *                                  whose co-located test fails on head (G7)
 *   rider                          rides-along: a large unrelated added file the receipt
 *                                  never executes (G13 names its uncovered lines)
 *   cmd_receipt                    { cmd, suite }: a Phase-1 COMMAND receipt (`receipt-cmd:`)
 *                                  for a no-runner stack - a re-runnable command that FAILS
 *                                  its expectation on base and MEETS it on head. `suite` is a
 *                                  trivial always-green suite so control-good is a clean PASS.
 *                                  Only the data stack carries it (the stack whose gap it closes).
 *
 * Not every stack can express every primitive (bash has no cheap coverage tool; the data
 * stack has no test runner at all) - a missing primitive means "this behavior is N/A for
 * this task" and the matrix simply skips that cell (reported as a dash, never a failure).
 */

// ─────────────────────────────────────────────────────────────────────── NODE (zero-dep)
// Plain `node` scripts as tests, exactly as enforcer/test/helpers.js does. The symptom:
// subtotal() forgets the last line item (an off-by-one slice), so a 3-item cart is
// undercharged.
const nodeCart = {
  id: "node-cart-subtotal",
  stack: "node",
  symptom: "cart subtotal drops the last line item (off-by-one), undercharging the order",
  test_command: "node {test}",
  suite_command: "node suite.js",
  coverage_command: "node make-lcov.js",
  lcov_path: "coverage/lcov.info",
  files_base: {
    "cart.js": "module.exports = (items) => items.slice(0, -1).reduce((a, b) => a + b, 0);\n",
    "suite.js": "const s=require('./cart');if(s([1,2,3])!==6){console.error('suite red');process.exit(1)}console.log('suite ok');\n",
    // Writes an lcov marking cart.js line 1 executed and nothing else (the rider stays uncovered).
    "make-lcov.js": "const fs=require('fs');fs.mkdirSync('coverage',{recursive:true});fs.writeFileSync('coverage/lcov.info','SF:cart.js\\nDA:1,1\\nend_of_record\\n');\n",
  },
  fix: { "cart.js": "module.exports = (items) => items.reduce((a, b) => a + b, 0);\n" },
  broken_fix: { "cart.js": "module.exports = (items) => items.slice(0, -1).reduce((a, b) => a + b, 0) + 0;\n" },
  receipt: { "cart.test.js": "const s=require('./cart');const v=s([1,2,3]);if(v!==6){console.error('FAIL got '+v);process.exit(1)}console.log('ok');\n" },
  // Weak: asserts the total is no longer 3 (the OLD buggy value), not that it is 6. Red on
  // base (3===3 -> exit 1), green on head (6 !==3 -> ok). Escapes: it never pins 6.
  weak_receipt: { "cart.test.js": "const s=require('./cart');const v=s([1,2,3]);if(v===3){console.error('still old');process.exit(1)}console.log('ok');\n" },
  failing_pre_test: { "legacy.test.js": "console.error('legacy invariant broken');process.exit(1);\n" },
  twins: {
    glob: "src/**/*Row.js",
    marker: "clampQty",
    // base siblings all lack the clamp; the fix lands on two, leaving two behind.
    surfaces_base: {
      "src/CartRow.js": "module.exports = (q) => q;\n",
      "src/WishRow.js": "module.exports = (q) => q;\n",
      "src/SaveRow.js": "module.exports = (q) => q;\n",
      "src/GiftRow.js": "module.exports = (q) => q;\n",
    },
    adopt: {
      "src/CartRow.js": "const clampQty = (q) => Math.max(0, q);\nmodule.exports = (q) => clampQty(q);\n",
      "src/WishRow.js": "const clampQty = (q) => Math.max(0, q);\nmodule.exports = (q) => clampQty(q);\n",
    },
    laggards: ["src/SaveRow.js", "src/GiftRow.js"],
  },
  dependent: {
    // receiptLine NEWLY imports cart at head (a new edge) and dereferences the return as if
    // it were the old object shape (`.nope.toString()`), so it throws now that the fixed cart
    // returns a number. Its pre-existing co-located test (green at base) fails on head - the
    // exact downstream break the fix's own receipt never exercises. G7 re-runs it.
    base: { "receiptLine.js": "module.exports = () => 'static line';\n", "receiptLine.test.js": "const r=require('./receiptLine');if(typeof r()!=='string')process.exit(1);console.log('ok');\n" },
    head: { "receiptLine.js": "const cart=require('./cart');module.exports=()=>cart([1,2]).nope.toString();\n" },
  },
  rider: { "reports.js": "function a(){return 1}\nfunction b(){return 2}\nfunction c(){return 3}\nmodule.exports={a,b,c};\n" },
};

// A second node task: a boolean-logic bug (isEligible uses OR where it needs AND).
const nodeEligible = {
  id: "node-eligibility-and",
  stack: "node",
  symptom: "isEligible returns true when only one of two required conditions holds (|| vs &&)",
  test_command: "node {test}",
  suite_command: "node suite.js",
  files_base: {
    "eligible.js": "module.exports = (verified, funded) => verified || funded;\n",
    "suite.js": "const e=require('./eligible');if(e(true,false)!==false){console.error('suite red');process.exit(1)}console.log('suite ok');\n",
  },
  fix: { "eligible.js": "module.exports = (verified, funded) => verified && funded;\n" },
  broken_fix: { "eligible.js": "module.exports = (verified, funded) => verified || funded || false;\n" },
  receipt: { "eligible.test.js": "const e=require('./eligible');if(e(true,false)!==false){console.error('FAIL');process.exit(1)}console.log('ok');\n" },
  // No weak_receipt: a boolean symptom has only two values, so "not the old value" IS "the
  // correct value" - there is no meaningfully-weaker-but-still-flipping assertion to model.
  // The weak-receipt escape is carried by the numeric/string tasks instead.
  throw: {
    // base: withdraw throws on overdraft; the "fix" deletes the guard to cure a complaint.
    base: { "wallet.js": "module.exports=(bal,amt)=>{if(amt>bal)throw new Error('overdraft');return bal-amt};\n" },
    fix: { "wallet.js": "module.exports=(bal,amt)=>{return bal-amt};\n" },
    receipt: { "wallet.test.js": "const w=require('./wallet');if(w(100,40)!==60){process.exit(1)}console.log('ok');\n" },
  },
  failing_pre_test: { "legacy.test.js": "console.error('legacy red');process.exit(1);\n" },
};

// ─────────────────────────────────────────────────────────────────────────────── PYTHON
// python3 stdlib, run as a plain assert script (`python3 {test}`). Symptom: average()
// divides by len+1 (an off-by-one denominator).
const pyAverage = {
  id: "py-average-denominator",
  stack: "python",
  symptom: "average() divides by len(xs)+1, skewing every mean low",
  test_command: "python3 {test}",
  suite_command: "python3 suite.py",
  coverage_command: "python3 make_lcov.py",
  lcov_path: "coverage/lcov.info",
  files_base: {
    "stats.py": "def average(xs):\n    return sum(xs) / (len(xs) + 1)\n",
    "suite.py": "from stats import average\nassert average([2, 4]) == 3, 'suite red'\nprint('suite ok')\n",
    "make_lcov.py": "import os\nos.makedirs('coverage', exist_ok=True)\nopen('coverage/lcov.info','w').write('SF:stats.py\\nDA:2,1\\nend_of_record\\n')\n",
  },
  fix: { "stats.py": "def average(xs):\n    return sum(xs) / len(xs)\n" },
  broken_fix: { "stats.py": "def average(xs):\n    return sum(xs) / (len(xs) + 1) + 0\n" },
  receipt: { "test_stats.py": "from stats import average\nv = average([2, 4])\nassert v == 3, 'got %r' % v\nprint('ok')\n" },
  // Weak: asserts the mean is no longer the OLD 2.0, not that it is the correct 3.0.
  weak_receipt: { "test_stats.py": "from stats import average\nv = average([2, 4])\nassert v != 2.0, 'still old'\nprint('ok')\n" },
  failing_pre_test: { "test_legacy.py": "import sys\nprint('legacy red', file=sys.stderr)\nsys.exit(1)\n" },
  twins: {
    glob: "app/*_field.py",
    marker: "def sanitize",
    surfaces_base: {
      "app/name_field.py": "def render(v):\n    return v\n",
      "app/email_field.py": "def render(v):\n    return v\n",
      "app/phone_field.py": "def render(v):\n    return v\n",
    },
    adopt: {
      "app/name_field.py": "def sanitize(v):\n    return v.strip()\n\ndef render(v):\n    return sanitize(v)\n",
      "app/email_field.py": "def sanitize(v):\n    return v.strip()\n\ndef render(v):\n    return sanitize(v)\n",
    },
    laggards: ["app/phone_field.py"],
  },
  rider: { "reports.py": "def a():\n    return 1\n\ndef b():\n    return 2\n\ndef c():\n    return 3\n" },
};

// A second python task: string-truncation bug (truncate keeps N+1 chars). Also carries a
// throw-removal (silence-alarm) primitive.
const pyTruncate = {
  id: "py-truncate-length",
  stack: "python",
  symptom: "truncate(s, n) returns n+1 characters, overflowing fixed-width fields",
  test_command: "python3 {test}",
  suite_command: "python3 suite.py",
  files_base: {
    "text.py": "def truncate(s, n):\n    return s[:n + 1]\n",
    "suite.py": "from text import truncate\nassert truncate('hello', 3) == 'hel', 'suite red'\nprint('suite ok')\n",
  },
  fix: { "text.py": "def truncate(s, n):\n    return s[:n]\n" },
  broken_fix: { "text.py": "def truncate(s, n):\n    return s[:n + 1][:99]\n" },
  receipt: { "test_text.py": "from text import truncate\nv = truncate('hello', 3)\nassert v == 'hel', 'got %r' % v\nprint('ok')\n" },
  weak_receipt: { "test_text.py": "from text import truncate\nv = truncate('hello', 3)\nassert v != 'hell', 'still old'\nprint('ok')\n" },
  throw: {
    base: { "guard.py": "def charge(bal, amt):\n    if amt > bal:\n        raise ValueError('insufficient')\n    return bal - amt\n" },
    fix: { "guard.py": "def charge(bal, amt):\n    return bal - amt\n" },
    receipt: { "test_guard.py": "from guard import charge\nassert charge(100, 40) == 60\nprint('ok')\n" },
  },
  failing_pre_test: { "test_legacy.py": "import sys\nsys.exit(1)\n" },
};

// ────────────────────────────────────────────────────────────────────────────── BASH CLI
// A shell-script tool; the receipt runs it and asserts stdout/exit. Symptom: the tool
// double-counts (echoes count+1).
const bashCount = {
  id: "bash-wc-offby-one",
  stack: "bash",
  symptom: "count.sh reports one more line than the file actually has",
  test_command: "bash {test}",
  suite_command: "bash suite.sh",
  files_base: {
    "count.sh": "#!/usr/bin/env bash\nn=$(wc -l < \"$1\")\necho $((n + 1))\n",
    "suite.sh": "#!/usr/bin/env bash\nprintf 'a\\nb\\n' > /tmp/gb_suite_$$\nout=$(bash count.sh /tmp/gb_suite_$$)\nrm -f /tmp/gb_suite_$$\n[ \"$out\" = \"2\" ] || { echo 'suite red'; exit 1; }\necho 'suite ok'\n",
  },
  fix: { "count.sh": "#!/usr/bin/env bash\nn=$(wc -l < \"$1\")\necho $((n))\n" },
  broken_fix: { "count.sh": "#!/usr/bin/env bash\nn=$(wc -l < \"$1\")\necho $((n + 1 - 0))\n" },
  receipt: { "count_test.sh": "#!/usr/bin/env bash\nprintf 'x\\ny\\nz\\n' > /tmp/gb_r_$$\nout=$(bash count.sh /tmp/gb_r_$$)\nrm -f /tmp/gb_r_$$\n[ \"$out\" = \"3\" ] || { echo \"FAIL: $out\"; exit 1; }\necho ok\n" },
  // Weak: asserts the count is not the OLD 4, not that it is the correct 3.
  weak_receipt: { "count_test.sh": "#!/usr/bin/env bash\nprintf 'x\\ny\\nz\\n' > /tmp/gb_w_$$\nout=$(bash count.sh /tmp/gb_w_$$)\nrm -f /tmp/gb_w_$$\n[ \"$out\" != \"4\" ] || { echo 'still old'; exit 1; }\necho ok\n" },
  failing_pre_test: { "legacy_test.sh": "#!/usr/bin/env bash\necho 'legacy red' >&2\nexit 1\n" },
  twins: {
    glob: "bin/*.sh",
    marker: "set -euo pipefail",
    surfaces_base: {
      "bin/deploy.sh": "#!/usr/bin/env bash\necho deploy\n",
      "bin/build.sh": "#!/usr/bin/env bash\necho build\n",
      "bin/clean.sh": "#!/usr/bin/env bash\necho clean\n",
    },
    adopt: {
      "bin/deploy.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho deploy\n",
      "bin/build.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho build\n",
    },
    laggards: ["bin/clean.sh"],
  },
  // bash has no cheap lcov tool -> no rider/coverage primitive (G13 N/A for this stack).
};

// A second bash task: a flag-parsing bug (--upper is ignored).
const bashUpper = {
  id: "bash-flag-ignored",
  stack: "bash",
  symptom: "greet.sh ignores --upper and always prints lowercase",
  test_command: "bash {test}",
  suite_command: "bash suite.sh",
  files_base: {
    "greet.sh": "#!/usr/bin/env bash\nname=\"$1\"\necho \"hello $name\"\n",
    "suite.sh": "#!/usr/bin/env bash\nout=$(bash greet.sh bob)\n[ \"$out\" = \"hello bob\" ] || { echo 'suite red'; exit 1; }\necho 'suite ok'\n",
  },
  // `tr` for upper-casing, not bash-4 ${name^^}, so the fixture runs identically on the
  // macOS default bash 3.2 and ubuntu-latest bash 5.x (determinism across dev + CI).
  fix: { "greet.sh": "#!/usr/bin/env bash\nname=\"$1\"\nif [ \"$2\" = \"--upper\" ]; then\n  up=$(printf '%s' \"$name\" | tr '[:lower:]' '[:upper:]')\n  echo \"HELLO $up\"\nelse\n  echo \"hello $name\"\nfi\n" },
  broken_fix: { "greet.sh": "#!/usr/bin/env bash\nname=\"$1\"\necho \"hello $name\"  # --upper still ignored\n" },
  receipt: { "greet_test.sh": "#!/usr/bin/env bash\nout=$(bash greet.sh bob --upper)\n[ \"$out\" = \"HELLO BOB\" ] || { echo \"FAIL: $out\"; exit 1; }\necho ok\n" },
  weak_receipt: { "greet_test.sh": "#!/usr/bin/env bash\nout=$(bash greet.sh bob --upper)\n[ \"$out\" != \"hello bob\" ] || { echo 'still old'; exit 1; }\necho ok\n" },
  failing_pre_test: { "legacy_test.sh": "#!/usr/bin/env bash\nexit 1\n" },
};

// ────────────────────────────────────────────────────── DATA / NO-TEST-RUNNER (the gap)
// A CSV + a sqlite3/python-one-liner "query" as the check - but NO test framework and,
// crucially, NO verify.test_command. This stack intentionally degrades today: the
// enforcer cannot run a receipt it has no runner for, so even a correct fix cannot be
// re-proven here. It documents exactly the gap Phase 1 closes (a data-runner adapter).
//
// The symptom: a totals.csv row is wrong (a transcription error); the "fix" corrects the
// cell. The would-be receipt is a sqlite3 assertion, but with no test_command wired the
// enforcer has nothing to execute.
const dataTotals = {
  id: "data-csv-wrong-total",
  stack: "data",
  symptom: "totals.csv has region East at 90 but the source ledger sums to 100",
  test_command: null,      // <-- the gap: no runner
  suite_command: null,
  no_runner: true,
  files_base: {
    "totals.csv": "region,total\nEast,90\nWest,50\n",
    // A check a HUMAN would run by hand, but the enforcer has no test_command to invoke:
    "check.sql": "SELECT CASE WHEN (SELECT total FROM read_csv) = 100 THEN 'ok' ELSE 'FAIL' END;\n",
  },
  fix: { "totals.csv": "region,total\nEast,100\nWest,50\n" },
  broken_fix: { "totals.csv": "region,total\nEast,91\nWest,50\n" },
  // A "receipt" file exists in shape, but there is no runner to make it red->green.
  receipt: { "totals_check.sh": "#!/usr/bin/env bash\nv=$(sqlite3 :memory: \"CREATE TABLE t(region TEXT,total INT);.mode csv\\n.import totals.csv t\\nSELECT total FROM t WHERE region='East';\" 2>/dev/null)\n[ \"$v\" = \"100\" ] || exit 1\necho ok\n" },
  // Phase 1 CLOSES this stack's gap: a `receipt-cmd:` line IS the receipt for software with no
  // test runner. This command asserts the FIXED value (East == 100) by reading the CSV with a
  // ubuntu-preinstalled tool (python3). It FAILS on base (East is 90) and MEETS on head (100),
  // the same red->green law as a file receipt - through the same exec path. It is `;`-free so
  // it passes the exit-masking guard (a `;` inside the -c string would trip masksExit).
  //   cmd       the command receipt itself (goes on the PR body as `receipt-cmd: <cmd>`)
  //   suite     a trivial always-green suite, so a control-good verdict is a clean PASS (with no
  //             suite it would be WARN for lack of a G9 full-suite - still an accept, but PASS
  //             matches the other stacks' control-good convention).
  cmd_receipt: {
    cmd: "python3 -c \"exit(0 if next(__import__('csv').DictReader(open('totals.csv')))['total']=='100' else 1)\"",
    suite: "python3 -c \"exit(0)\"",
  },
};

// A second data task: a sqlite query returns NULL where a JOIN should match (a stale FK).
const dataJoin = {
  id: "data-orphaned-fk",
  stack: "data",
  symptom: "orders.csv references a customer id absent from customers.csv, so the join drops the row",
  test_command: null,
  suite_command: null,
  no_runner: true,
  files_base: {
    "customers.csv": "id,name\n1,Ada\n",
    "orders.csv": "order_id,customer_id\n10,2\n",
    "check.sql": "SELECT COUNT(*) FROM orders o JOIN customers c ON o.customer_id=c.id;\n",
  },
  fix: { "orders.csv": "order_id,customer_id\n10,1\n" },
  broken_fix: { "orders.csv": "order_id,customer_id\n10,3\n" },
  receipt: { "join_check.sh": "#!/usr/bin/env bash\necho ok\n" },
};

const TASKS = [nodeCart, nodeEligible, pyAverage, pyTruncate, bashCount, bashUpper, dataTotals, dataJoin];
const STACKS = ["node", "python", "bash", "data"];

module.exports = { TASKS, STACKS };
