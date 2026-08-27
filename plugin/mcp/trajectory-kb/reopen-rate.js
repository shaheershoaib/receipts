// The aggregation, with no transport and no filesystem: a grouping rule is testable
// without spawning a server, and a test that needs an MCP SDK installed is a test that
// silently does not run wherever it is not.
export const CAUSE_CLASSES = [
  "wrong-surface",      // fixed a surface the reporter never sees
  "parallel-twin",      // an identical flow elsewhere was left broken
  "partial-class",      // the reported instance was fixed, its siblings were not
  "env-parity",         // the fix was right; the environment it was checked on was not
  "regression",         // a later change broke it again
  "misread-report",     // the symptom was understood wrongly
  "unverified-claim",   // closed without observing the symptom gone
];

export function computeReopenRate(live, args = {}) {
  // The unit is the OBSERVABLE (surface_key), never the ticket or the file. One flaky
  // surface reopened under five ticket numbers is ONE recurring miss; counting tickets
  // reports five unrelated ones and hides the pattern that would fix it.

  const bySurface = new Map();
  for (const e of live) {
    const k = e.surface_key || (args.deriveSurfaceKey ? args.deriveSurfaceKey(e) : null) || "(unkeyed)";
    if (!bySurface.has(k)) bySurface.set(k, []);
    bySurface.get(k).push(e);
  }

  const causes = {}, envParity = {};
  let observables = 0, reopened = 0, reopenEvents = 0;
  const worst = [];
  for (const [key, entries] of bySurface) {
    observables += 1;
    const reopens = entries.filter((e) => e.reopened);
    if (!reopens.length) continue;
    // A surface whose ONLY reopens are env-parity has not actually come back: the fix was
    // right and the environment was wrong. Counting it here would inflate the headline with
    // exactly the class this metric promises to exclude, and point the next fix at the
    // wrong surface.
    const realReopens = reopens.filter((r) => r.cause_class !== "env-parity");
    if (realReopens.length) {
      reopened += 1;
      reopenEvents += realReopens.length;
    }
    for (const r of reopens) {
      const c = r.cause_class || "unclassified";
      // Environment-parity reopens are bucketed SEPARATELY and never folded into the
      // headline. The fix was correct; the environment it was checked on was not. Mixing
      // them in blames the surface for a staging problem and sends the next fix to the
      // wrong place.
      if (c === "env-parity") envParity[key] = (envParity[key] || 0) + 1;
      else causes[c] = (causes[c] || 0) + 1;
    }
    if (realReopens.length) {
      worst.push({ surface_key: key, reopens: realReopens.length, causes: dedupeStrings(realReopens.map((r) => r.cause_class || "unclassified")) });
    }
  }
  worst.sort((a, b) => b.reopens - a.reopens);

  const envTotal = Object.values(envParity).reduce((a, b) => a + b, 0);
  return {
    observables,
    observables_reopened: reopened,
    reopen_events: reopenEvents,
    // the headline rate EXCLUDES env-parity, for the reason above
    reopen_rate: observables ? Number((reopened / observables).toFixed(3)) : 0,
    by_cause: causes,
    env_parity_excluded: { events: envTotal, surfaces: Object.keys(envParity).length, detail: envParity },
    worst_offenders: worst.slice(0, args.n || 10),
    note:
      "Unit is the observable (surface_key), not the ticket. env-parity reopens are reported " +
      "separately and excluded from reopen_rate: the fix was right, the environment was not. " +
      "A cause_class that dominates is a missing capability, not bad luck.",
  };
}

function dedupeStrings(xs) { return [...new Set(xs)]; }
