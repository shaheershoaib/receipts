"use strict";
/* Unit tests for the enforcer's pure, security-critical helpers. */
const { test } = require("node:test");
const assert = require("node:assert");
const { masksExit, gateOn, isContractFile, contractBreaks, expandTestPlaceholders } = require("../verify.js");

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
