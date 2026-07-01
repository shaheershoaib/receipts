"use strict";
/* Unit tests for G12 silencing-shape detection (pure, injected in-memory I/O). */
const { test } = require("node:test");
const assert = require("node:assert");
const { computeG12 } = require("../g12.js");

function env(baseTree, headTree) {
  const pick = (c) => (c === "BASE" ? baseTree : headTree);
  return {
    base: "BASE", head: "HEAD",
    readAt: (c, p) => (Object.prototype.hasOwnProperty.call(pick(c), p) ? pick(c)[p] : null),
  };
}

test("a removed throw is flagged; an added throw is not", () => {
  const r = computeG12({
    ...env(
      { "src/auth.js": "if (!ok) throw new Forbidden();\nreturn data;\n" },
      { "src/auth.js": "return data;\n" }
    ),
    changedSource: ["src/auth.js"],
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "removed-throw");

  const added = computeG12({
    ...env(
      { "src/auth.js": "return data;\n" },
      { "src/auth.js": "if (!ok) throw new Forbidden();\nreturn data;\n" }
    ),
    changedSource: ["src/auth.js"],
  });
  assert.equal(added.findings.length, 0, "adding a check is the opposite of silencing");
});

test("python: a removed raise is flagged; `raised` variable is not a raise", () => {
  const r = computeG12({
    ...env(
      { "app/views.py": "if not ok:\n    raise PermissionDenied()\nreturn data\n" },
      { "app/views.py": "return data\n" }
    ),
    changedSource: ["app/views.py"],
  });
  assert.equal(r.findings.length, 1);

  const noise = computeG12({
    ...env(
      { "app/views.py": "amount_raised = 1\n" },
      { "app/views.py": "x = 2\n" }
    ),
    changedSource: ["app/views.py"],
  });
  assert.equal(noise.findings.length, 0, "a variable named *raised is not a raise statement");
});

test("an added empty catch / except-pass is flagged", () => {
  const js = computeG12({
    ...env(
      { "src/save.js": "await save();\n" },
      { "src/save.js": "try { await save(); } catch (e) {}\n" }
    ),
    changedSource: ["src/save.js"],
  });
  assert.equal(js.findings.length, 1);
  assert.equal(js.findings[0].kind, "added-empty-catch");

  const py = computeG12({
    ...env(
      { "app/tasks.py": "send_email()\n" },
      { "app/tasks.py": "try:\n    send_email()\nexcept Exception:\n    pass\n" }
    ),
    changedSource: ["app/tasks.py"],
  });
  assert.equal(py.findings.length, 1);

  const promise = computeG12({
    ...env(
      { "src/fire.js": "fire();\n" },
      { "src/fire.js": "fire().catch(() => {});\n" }
    ),
    changedSource: ["src/fire.js"],
  });
  assert.equal(promise.findings.length, 1);
});

test("a catch that HANDLES the error is not flagged", () => {
  const r = computeG12({
    ...env(
      { "src/save.js": "await save();\n" },
      { "src/save.js": "try { await save(); } catch (e) { report(e); rollback(); }\n" }
    ),
    changedSource: ["src/save.js"],
  });
  assert.equal(r.findings.length, 0, "a handling catch is error handling, not silencing");
});

test("an added file removes nothing (no base to compare)", () => {
  const r = computeG12({
    ...env({}, { "src/new.js": "run();\n" }),
    changedSource: ["src/new.js"],
  });
  assert.equal(r.findings.length, 0);
});
