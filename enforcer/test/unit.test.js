"use strict";
/* Unit tests for the enforcer's pure, security-critical helpers. */
const { test } = require("node:test");
const assert = require("node:assert");
const { masksExit, gateOn, isContractFile, contractBreaks, expandTestPlaceholders, resolveTimeout, unknownConfigKeys, parseCmdReceipts, meetsExpectation } = require("../verify.js");

test("resolveTimeout: 20-minute default, explicit 0 disables, positive honored", () => {
  assert.equal(resolveTimeout(undefined), 1200000, "no verify block => default");
  assert.equal(resolveTimeout({}), 1200000, "unset => default");
  assert.equal(resolveTimeout({ command_timeout_ms: 0 }), 0, "explicit 0 opts out");
  assert.equal(resolveTimeout({ command_timeout_ms: 5000 }), 5000);
  assert.equal(resolveTimeout({ command_timeout_ms: "junk" }), 1200000, "garbage => default");
});

test("unknownConfigKeys: typo'd keys are named, valid configs are silent", () => {
  assert.deepEqual(unknownConfigKeys({}), []);
  assert.deepEqual(unknownConfigKeys({
    version: 1,
    claim: { issue_link: "x", downgrade_tags: [] },
    verify: { test_command: "t", receipt_runs: 2 },
    gates: { medium: "web", G6: { mode: "warn" }, G8: { integration_branch: "main" } },
  }), []);
  assert.deepEqual(unknownConfigKeys({
    gatez: {},
    gates: { medium: "web", G6: { modee: "warn" } },
    verify: { test_comand: "npm t" },
  }).sort(), ["gates.G6.modee", "gatez", "verify.test_comand"]);
});

test("unknownConfigKeys: verify.browser_receipt is a known nested block; its typos are named", () => {
  // A valid browser_receipt block is silent.
  assert.deepEqual(unknownConfigKeys({
    verify: { test_command: "t", browser_receipt: { command: "npx playwright test", url_source: "github-deployment", url_env: "X", url_cmd: "c", mode: "block", timeout_ms: 1000 } },
  }), []);
  // A typo inside the block is named (not silently defaulted).
  assert.deepEqual(unknownConfigKeys({
    verify: { test_command: "t", browser_receipt: { command: "x", url_sauce: "env" } },
  }), ["verify.browser_receipt.url_sauce"]);
});

test("KNOWN_KEYS mirrors the JSON schema for verify.browser_receipt (no drift)", () => {
  // The enforcer validates keys against KNOWN_KEYS (schema-lite, no dep); the shipped schema is
  // the real contract. A key added to one but not the other is a silent hole - assert they match
  // for the new browser_receipt block.
  const fs = require("fs");
  const path = require("path");
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "receipts.config.schema.json"), "utf8"));
  const schemaKeys = Object.keys(schema.properties.verify.properties.browser_receipt.properties).sort();
  // KNOWN_KEYS is internal; re-derive the same list the enforcer uses by round-tripping an
  // object with every schema key through unknownConfigKeys (all-known => empty).
  const allKnown = {};
  for (const k of schemaKeys) allKnown[k] = "x";
  assert.deepEqual(
    unknownConfigKeys({ verify: { test_command: "t", browser_receipt: allKnown } }), [],
    "every schema key for verify.browser_receipt must be in the enforcer's KNOWN_KEYS - they drifted");
  // And browser_receipt itself must be a recognized verify.* key.
  assert.deepEqual(unknownConfigKeys({ verify: { test_command: "t", browser_receipt: { command: "x" } } }), []);
});

test("KNOWN_KEYS mirrors the JSON schema for agent.drive (no drift)", () => {
  // agent.drive shipped in the schema-less state once already: init wrote it, the schema
  // did not declare it, and the enforcer warned "unknown key: agent.drive" on every run.
  // Same parity assertion as browser_receipt so it cannot silently drift again.
  const fs = require("fs");
  const path = require("path");
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "receipts.config.schema.json"), "utf8"));
  const schemaKeys = Object.keys(schema.properties.agent.properties.drive.properties).sort();
  const allKnown = {};
  for (const k of schemaKeys) allKnown[k] = "x";
  assert.deepEqual(
    unknownConfigKeys({ agent: { drive: allKnown } }), [],
    "every schema key for agent.drive must be in the enforcer's KNOWN_KEYS - they drifted");
  assert.deepEqual(unknownConfigKeys({ agent: { drive: { auth: "x" } } }), []);
});

test("expandTestPlaceholders: {test} / {test_dirs} / {test_classes} select correctly per runner", () => {
  const goFiles = ["pkg/api/user_test.go", "pkg/api/auth_test.go", "pkg/db/store_test.go"];
  assert.equal(
    expandTestPlaceholders("go test {test_dirs}", goFiles),
    'go test "./pkg/api" "./pkg/db"',
    "go selects by package dir - a file path fed to -run matches nothing and exits 0");
  assert.equal(
    expandTestPlaceholders("go test {test_dirs}", ["main_test.go"]),
    'go test "./"',
    "a root-level test maps to the root package");
  assert.equal(
    expandTestPlaceholders("mvn -Dtest={test_classes} test", ["src/test/java/FooTest.java", "src/test/java/BarTest.java"]),
    "mvn -Dtest=FooTest,BarTest test",
    "surefire takes comma-joined class names, not paths");
  assert.equal(
    expandTestPlaceholders("npm test -- {test}", ["a b.test.js"]),
    'npm test -- "a b.test.js"',
    "file paths stay quoted");
  assert.equal(expandTestPlaceholders("pytest {test}", ["tests/test_x.py"]), 'pytest "tests/test_x.py"');
});

test("masksExit: clean commands pass, exit-maskers are caught", () => {
  // allowed: a single command whose own exit is the result
  assert.equal(masksExit("node test.js"), false);
  assert.equal(masksExit("pytest tests/x.py"), false);
  assert.equal(masksExit("a && b"), false, "&& propagates failure");
  assert.equal(masksExit("cmd 2>&1"), false, "stderr redirect preserves exit");
  assert.equal(masksExit("cmd > out.log"), false, "stdout redirect preserves exit");
  assert.equal(masksExit("cmd &> file"), false, "combined redirect preserves exit");
  // rejected: anything that can swallow a non-zero exit
  assert.equal(masksExit("npm test ; echo done"), true, "; sequencing");
  assert.equal(masksExit("cmd || true"), true, "|| or-true");
  assert.equal(masksExit("cmd | tee log"), true, "pipe: last stage wins");
  assert.equal(masksExit("cmd & other"), true, "background");
  assert.equal(masksExit("cmd\nother"), true, "newline sequencing");
  assert.equal(masksExit("echo `cmd`"), true, "backtick substitution");
  assert.equal(masksExit("echo $(cmd)"), true, "$() substitution");
});

test("parseCmdReceipts: grammar - command, expect suffix, multiple lines, non-receipt lines ignored", () => {
  // Bare command -> exit-0-only (expect: null)
  assert.deepEqual(
    parseCmdReceipts("closes #1\nreceipt-cmd: curl -fsS http://localhost:3000/health"),
    [{ raw: "curl -fsS http://localhost:3000/health", cmd: "curl -fsS http://localhost:3000/health", expect: null }]);

  // expect:/re/ suffix is split off; the command keeps its own slashes (a path is not the suffix)
  const one = parseCmdReceipts('receipt-cmd: sqlite3 app.db "select count(*) from users where email is null" expect:/^0$/');
  assert.equal(one.length, 1);
  assert.equal(one[0].cmd, 'sqlite3 app.db "select count(*) from users where email is null"');
  assert.equal(one[0].expect, "^0$");

  // a command containing slashes (an http:// URL / a path) with a trailing expect: - only the
  // trailing ` expect:/.../` is the assertion, the URL's slashes stay in the command
  const url = parseCmdReceipts("receipt-cmd: curl -s http://localhost/api/x expect:/\"ok\":true/");
  assert.equal(url[0].cmd, "curl -s http://localhost/api/x");
  assert.equal(url[0].expect, '"ok":true');

  // multiple receipt-cmd lines = multiple commands (ANDed by the enforcer)
  const many = parseCmdReceipts("receipt-cmd: cmd-a\nsome prose\nreceipt-cmd: cmd-b expect:/done/");
  assert.deepEqual(many.map((c) => c.cmd), ["cmd-a", "cmd-b"]);
  assert.deepEqual(many.map((c) => c.expect), [null, "done"]);

  // a body with no receipt-cmd line yields nothing; a bare `receipt:` path pin is NOT a cmd
  assert.deepEqual(parseCmdReceipts("closes #1\nreceipt: src/x.test.js"), []);
  assert.deepEqual(parseCmdReceipts(""), []);
});

test("meetsExpectation: exit-0 floor, plus optional multiline stdout regex", () => {
  // exit-0-only: met iff the process exited 0
  assert.equal(meetsExpectation({ ok: true, out: "whatever" }, null), true);
  assert.equal(meetsExpectation({ ok: false, out: "whatever" }, null), false, "non-zero exit never meets");
  // with a regex: met iff exit 0 AND output matches (multiline, so ^0$ matches a 0\n line)
  assert.equal(meetsExpectation({ ok: true, out: "0\n" }, /^0$/m), true, "multiline ^0$ matches a trailing-newline count");
  assert.equal(meetsExpectation({ ok: true, out: "3\n" }, /^0$/m), false, "count 3 does not match ^0$");
  assert.equal(meetsExpectation({ ok: false, out: "0\n" }, /^0$/m), false, "regex match cannot rescue a non-zero exit");
  assert.equal(meetsExpectation({ ok: true, out: '{"ok":true}\n' }, /"ok":true/), true);
});

test("gateOn: enabled/disabled semantics match the spec", () => {
  assert.equal(gateOn(null, "G1"), true, "no gates block => all on");
  assert.equal(gateOn({ enabled: "all" }, "G1"), true);
  assert.equal(gateOn({ disabled: ["G1"] }, "G1"), false);
  assert.equal(gateOn({ enabled: ["G0", "G2"] }, "G1"), false, "not in explicit list");
  assert.equal(gateOn({ enabled: ["G1"] }, "G1"), true);
  assert.equal(gateOn({ enabled: ["G1"], disabled: ["G1"] }, "G1"), false, "disabled wins");
});

test("isContractFile: detects contract artifacts, ignores code", () => {
  assert.equal(isContractFile("openapi.yaml"), true);
  assert.equal(isContractFile("api/schema.graphql"), true);
  assert.equal(isContractFile("user.proto"), true);
  assert.equal(isContractFile("src/app.js"), false);
  assert.equal(isContractFile("README.md"), false);
  // extra config glob catches a project-specific contract the defaults miss
  assert.equal(isContractFile("contracts/order.json"), false);
  assert.equal(isContractFile("contracts/order.json", ["contracts/*.json"]), true);
});

test("contractBreaks: structural breaking-change detection on JSON", () => {
  const breaksOf = (a, b) => contractBreaks("c.json", JSON.stringify(a), JSON.stringify(b)).breaks.join(" | ");

  // removed field is breaking
  assert.match(
    breaksOf({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
             { type: "object", properties: { a: { type: "string" } } }),
    /removed .*properties\.b/);

  // newly-required field is breaking (old callers don't send it)
  assert.match(
    breaksOf({ type: "object", properties: { a: {} } },
             { type: "object", required: ["a"], properties: { a: {} } }),
    /added required field "a"/);

  // narrowed type is breaking
  assert.match(
    breaksOf({ type: ["string", "null"] }, { type: "string" }),
    /type narrowed.*null/);

  // removed enum value is breaking
  assert.match(
    breaksOf({ enum: ["x", "y"] }, { enum: ["x"] }),
    /removed enum value "y"/);

  // additive change (new optional field) is NOT breaking
  assert.equal(
    breaksOf({ type: "object", properties: { a: {} } },
             { type: "object", properties: { a: {}, b: { type: "string" } } }),
    "");

  // a doc KEYWORD ("description") removed is not a contract break...
  assert.equal(
    breaksOf({ type: "object", description: "old", properties: { a: {} } },
             { type: "object", properties: { a: {} } }),
    "");

  // ...but a FIELD literally named "description" inside properties IS contract surface
  assert.match(
    breaksOf({ type: "object", properties: { description: { type: "string" } } },
             { type: "object", properties: {} }),
    /removed .*properties\.description/);
});

test("every documented receipt-cmd example parses clean and passes the exit-masking guard", () => {
  // The docs are part of the contract: a user copying a documented example must never
  // be BLOCKed by masksExit or the grammar. (Caught in review: a `test "$(curl ...)"`
  // example that the command-substitution guard rejects.)
  const fs = require("fs");
  const path = require("path");
  const docs = ["spec/RECEIPT.md", "spec/MEDIA.md", "enforcer/README.md"]
    .map((p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8")).join("\n");
  const snippets = [...docs.matchAll(/`receipt-cmd: ([^`]+)`/g)].map((m) => m[1]);
  assert.ok(snippets.length >= 4, "expected the documented examples to be found");
  for (const s of snippets) {
    const [parsed] = parseCmdReceipts(`receipt-cmd: ${s}`);
    assert.ok(parsed && parsed.cmd, `parses to a command: ${s}`);
    assert.ok(!masksExit(parsed.cmd), `documented example must not mask its exit: ${s}`);
    if (parsed.expect !== null) new RegExp(parsed.expect, "m"); // must compile
  }
});
