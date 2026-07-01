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

function count(src, re) {
  const m = String(src || "").match(re);
  return m ? m.length : 0;
}

/*
 * computeG12({ changedSource, readAt, base, head })
 *   -> { findings: [{ file, kind, name, removed?, added? }] }
 */
function computeG12(opts) {
  const { changedSource, readAt, base, head } = opts;
  const findings = [];
  for (const f of changedSource || []) {
    const before = readAt(base, f);
    if (before == null) continue; // an added file removed nothing
    const after = readAt(head, f) || "";
    const throwsRemoved = count(before, THROW_RE) - count(after, THROW_RE);
    if (throwsRemoved > 0)
      findings.push({ file: f, kind: "removed-throw", name: "throw/raise removed", removed: throwsRemoved });
    for (const { re, name } of EMPTY_CATCH_RES) {
      const added = count(after, re) - count(before, re);
      if (added > 0) findings.push({ file: f, kind: "added-empty-catch", name, added });
    }
  }
  return { findings };
}

module.exports = { computeG12 };
