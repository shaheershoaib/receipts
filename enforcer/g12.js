"use strict";
/*
 * G12 fix-the-cause-not-the-alarm (the silencing gate) - enforcer assist.
 *
 * A symptom can be SILENCED rather than fixed: the reporter's 403 "fixed" by removing
 * the permission check, the error toast "fixed" by swallowing the exception, the
 * validation error "fixed" by deleting the validator. The receipt goes red->green
 * honestly - the symptom IS observably gone - and the fix is wrong in the worst way.
 * No re-run can catch this; it is a judgment gate (the skill carries the judgment).
 *
 * This module is the narrow, high-signal ASSIST: on a fix-claim, flag the two silencing
 * shapes that are cheap to see and usually wrong:
 *   1. the diff REMOVES throw/raise statements (the detector deleted), and
 *   2. the diff ADDS empty/swallowing catch blocks (the alarm muted).
 *
 * Occurrence-count over base/head (no line diff needed), production source only, WARN
 * only by default - some fixes legitimately remove a throw (the bug WAS the over-strict
 * check). The warning asks the question; the human answers it.
 */

// throw/raise statements: `throw x` / `throw new E` / `raise X` / bare `raise`.
// Word-anchored so `rethrow(...)` or a variable named `raised` does not count.
const THROW_RE = /(^|[^.\w])(throw\s+[^;\n]|raise\b)/g;

// An empty or swallowing catch: `catch {}` / `catch (e) {}` / `.catch(() => {})` /
// `except: pass` / `except Exception: pass` (same line or next line).
const EMPTY_CATCH_RES = [
  { re: /catch\s*(\([^)]*\))?\s*\{\s*\}/g, name: "empty catch {}" },
  { re: /\.catch\s*\(\s*\(\s*[^)]*\s*\)\s*=>\s*\{\s*\}\s*\)/g, name: ".catch(() => {})" },
  { re: /\.catch\s*\(\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)/g, name: ".catch(function(){})" },
  { re: /except[^:\n]*:\s*(\n\s*)?pass\b/g, name: "except: pass" },
];

// Test/CI-environment sniffing in PRODUCTION code - the optimizing agent's cheapest
// cheat the re-run gates cannot see: code that behaves correctly only where the gate
// runs (`if (process.env.CI) return expected`), green in CI, broken everywhere else.
// Curated to markers that identify a TEST/CI context; `NODE_ENV === "production"` is
// ubiquitous legitimate code, so NODE_ENV counts only when compared to 'test'.
const ENV_SNIFF_RES = [
  { re: /process\.env\.(CI|GITHUB_ACTIONS|GITLAB_CI|BUILDKITE|CIRCLECI|TRAVIS|JENKINS_URL|JEST_WORKER_ID|VITEST|VITEST_POOL_ID|NODE_TEST_CONTEXT)\b/g, name: "process.env CI/test marker" },
  { re: /NODE_ENV\s*(?:[!=]==?)\s*['"`]test['"`]|['"`]test['"`]\s*(?:[!=]==?)\s*[\w.\s]*NODE_ENV/g, name: "NODE_ENV === 'test'" },
  { re: /os\.environ(?:\.get)?\s*[([]\s*['"](CI|GITHUB_ACTIONS|GITLAB_CI|PYTEST_CURRENT_TEST)['"]/g, name: "os.environ CI/test marker" },
  { re: /['"]pytest['"]\s+in\s+sys\.modules/g, name: "'pytest' in sys.modules" },
  { re: /\bGetenv\(\s*"(CI|GITHUB_ACTIONS)"\s*\)/g, name: 'os.Getenv("CI")' },
  { re: /ENV\[\s*['"](CI|GITHUB_ACTIONS)['"]\s*\]/g, name: 'ENV["CI"]' },
];

function count(src, re) {
  const m = String(src || "").match(re);
  return m ? m.length : 0;
}

// Comments are documentation, not behavior: a docstring SAYING "if (process.env.CI)" is
// not a sniff (this gate flagged its own module header on the PR that introduced it).
// Block comments, URL-safe // comments, and full-line #/py comments go; STRING literals
// stay - real sniffs quote their marker (`os.environ.get('CI')`).
function stripCommentsForSniff(src) {
  return String(src || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?<!(?:https?|wss?|ftps?|file|ssh|git):)\/\/.*$/gm, "")
    .replace(/^[ \t]*#.*$/gm, "");
}

/*
 * computeEnvSniff({ changedSource, readAt, base, head })
 *   -> { findings: [{ file, kind: "added-env-sniff", name, added }] }
 * Occurrence-count added>0, like the silencing shapes - a pre-existing sniff is not this
 * PR's doing; an ADDED one on a verified claim is exactly the reward-hack shape.
 */
function computeEnvSniff(opts) {
  const { changedSource, readAt, base, head } = opts;
  const findings = [];
  for (const f of changedSource || []) {
    const before = stripCommentsForSniff(readAt(base, f) || "");
    const after = stripCommentsForSniff(readAt(head, f) || "");
    for (const { re, name } of ENV_SNIFF_RES) {
      const added = count(after, re) - count(before, re);
      if (added > 0) findings.push({ file: f, kind: "added-env-sniff", name, added });
    }
  }
  return { findings };
}

/*
 * computeG12({ changedSource, readAt, base, head })
 *   -> { findings: [{ file, kind, name, removed?, added? }] }
 */
function computeG12(opts) {
  const { changedSource, readAt, base, head } = opts;
  const findings = [];
  // Throw counting is per FILE, but "did this fix silence a detector?" is a question
  // about the DIFF. A refactor that moves a throw from one file to another shows a
  // removal in the source file and reads as silencing, when nothing was silenced.
  // So track the net across every changed file too.
  let removedTotal = 0, addedTotal = 0;
  for (const f of changedSource || []) {
    const before = readAt(base, f);
    if (before == null) continue; // an added file removed nothing
    const after = readAt(head, f) || "";
    const delta = count(before, THROW_RE) - count(after, THROW_RE);
    if (delta > 0) {
      removedTotal += delta;
      findings.push({ file: f, kind: "removed-throw", name: "throw/raise removed", removed: delta });
    } else if (delta < 0) {
      addedTotal += -delta;    // this file GAINED throws - a relocation target
    }
    for (const { re, name } of EMPTY_CATCH_RES) {
      const added = count(after, re) - count(before, re);
      if (added > 0) findings.push({ file: f, kind: "added-empty-catch", name, added });
    }
  }
  // net > 0 means throws genuinely disappeared from the diff. net <= 0 means every
  // removal is matched by an addition somewhere else - consistent with relocation.
  // The per-file findings are NOT dropped: a real silencing paired with an unrelated
  // new throw would net out too, and suppressing on that would be exactly the kind of
  // quiet weakening this gate exists to catch. They are annotated so the report can
  // say "moved, most likely" instead of accusing.
  const net = removedTotal - addedTotal;
  if (net <= 0) {
    for (const fnd of findings) {
      if (fnd.kind === "removed-throw") fnd.likely_relocated = true;
    }
  }
  return { findings, throws: { removed: removedTotal, added: addedTotal, net } };
}

module.exports = { computeG12, computeEnvSniff };
