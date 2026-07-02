"use strict";
/*
 * Browser receipts (Phase 3 - the web medium, an OPTIONAL adapter).
 *
 * The web medium's honest gap: a `receipt-cmd:` can curl an API on head, but a rendered-UI
 * symptom (a button that never enabled, a modal that never opened, a value that never painted)
 * needs a real browser against the real deploy. A browser receipt runs the consumer's own
 * Playwright/e2e script against the PR's PREVIEW DEPLOYMENT and folds the pass/fail into the
 * verdict - moving G1/G3/G5 for web apps from agent honesty to CI mechanics.
 *
 * What this is NOT (stated plainly, because it changes what the result MEANS):
 *  - It is NOT a red->green receipt. A preview deploys only the HEAD build; there is no preview
 *    of the base commit to run the script red against. So a browser receipt is a HEAD-ONLY
 *    acceptance check (G1/G3/G5-shaped: does the fixed behavior actually work on the deploy),
 *    NOT proof the symptom reproduced first. It therefore NEVER substitutes for the carried
 *    red->green receipt - it runs IN ADDITION, when configured.
 *  - Playwright is NEVER a dependency of THIS repo. The consuming repo brings its own e2e stack;
 *    the receipts side only resolves the preview URL, exports it as RECEIPTS_PREVIEW_URL, runs
 *    the configured command, and reads the exit code. Dependency-free core, adapter surface.
 *
 * Trust posture: the command comes from the BASE config (like every other verify.* command), is
 * exit-masking-checked by the caller (a green from a `; echo` cannot be trusted - G9), and runs
 * through the same exec path as a test_command. The module never blocks by default (mode:warn):
 * a preview being flaky or unreachable is an honest WARN, never a silent pass and never (unless
 * mode:block) a hard fail on infra that is not the PR's fault.
 *
 * I/O is INJECTED (fetch, runCmd) so the whole thing is unit-testable offline - no real network,
 * no real browser, mirroring g6.js / g7.js / g13.js.
 */

// A URL we are willing to hand a browser: http(s) only. Anything else (a file:, a data:, a
// shell fragment that leaked in) is refused - we export it into the environment for a spawned
// command, so a non-URL there is either a misconfig or an injection attempt.
const URL_OK = /^https?:\/\/[^\s]+$/i;

// Read the FIRST non-empty line of a command's stdout as the URL. A url_cmd may print a
// trailing newline, or log a line of noise before the URL; the first clean http(s) line wins.
function firstUrlLine(out) {
  for (const raw of String(out || "").split("\n")) {
    const line = raw.trim();
    if (URL_OK.test(line)) return line;
  }
  return null;
}

/*
 * Parse a GitHub deployments API response (an array of deployment objects) plus their statuses
 * to find the preview URL for the PR head sha. Pure - the caller does the fetching and passes
 * the already-parsed JSON in.
 *
 *   deployments: the /repos/:repo/deployments?sha=<head> array (may be [])
 *   statusesById: Map<deploymentId, statusesArray> - the /deployments/:id/statuses array each
 *
 * Returns { url, sha, environment } for the first deployment that carries an environment_url
 * (preferring one whose latest status is "success"), or { url: null, ... } when none does.
 * `sha` is the deployment's own sha (recorded so the caller can require == head sha for G3).
 */
function pickPreviewDeployment(deployments, statusesById) {
  const deps = Array.isArray(deployments) ? deployments : [];
  // Prefer a deployment with a successful status AND an environment_url; fall back to any with
  // an environment_url (a preview that is still "in_progress" but already has a URL is usable).
  const withUrl = [];
  for (const d of deps) {
    if (!d || typeof d !== "object") continue;
    const statuses = (statusesById && statusesById.get(d.id)) || [];
    // environment_url can live on the deployment (payload) or on a status; a status URL wins
    // because it is the one the platform published when the deploy went live.
    const statusUrl = Array.isArray(statuses)
      ? (statuses.find((s) => s && s.environment_url) || {}).environment_url
      : null;
    const url = statusUrl || d.environment_url || (d.payload && d.payload.web_url) || null;
    if (!url || !URL_OK.test(url)) continue;
    const succeeded = Array.isArray(statuses) && statuses.some((s) => s && s.state === "success");
    withUrl.push({ url, sha: d.sha || null, environment: d.environment || null, succeeded });
  }
  if (!withUrl.length) return { url: null, sha: null, environment: null, succeeded: false };
  const best = withUrl.find((x) => x.succeeded) || withUrl[0];
  return best;
}

/*
 * Resolve the preview URL for a browser receipt.
 *
 *   cfg = verify.browser_receipt (the block), headSha = the PR head sha (for github-deployment)
 *   deps = injected I/O:
 *     runCmd(cmd) -> { ok, out }         (for url_source: "command")
 *     env         -> process.env-like    (for url_source: "env")
 *     ghDeployments(headSha) -> { ok, deployments, statusesById, reason } (for github-deployment)
 *
 * Returns { ok, url, source, sha, sha_source, reason }:
 *   ok=false + reason  => could NOT resolve (an honest WARN upstream, never a silent pass)
 *   sha (github-deployment only) = the deployment's sha, for the G3 head-match check
 */
function resolvePreviewUrl(cfg, headSha, deps) {
  const source = (cfg && cfg.url_source) || "env";
  const d = deps || {};
  if (source === "env") {
    const name = (cfg && cfg.url_env) || "RECEIPTS_PREVIEW_URL";
    const val = ((d.env || {})[name] || "").trim();
    if (!val) return { ok: false, url: null, source, reason: `url_source "env" but $${name} is unset or empty` };
    if (!URL_OK.test(val)) return { ok: false, url: null, source, reason: `$${name} is not an http(s) URL: "${val.slice(0, 80)}"` };
    return { ok: true, url: val, source, sha: null };
  }
  if (source === "command") {
    const cmd = cfg && cfg.url_cmd;
    if (!cmd) return { ok: false, url: null, source, reason: `url_source "command" but url_cmd is not set` };
    if (typeof d.runCmd !== "function") return { ok: false, url: null, source, reason: "no command runner available to resolve the URL" };
    const r = d.runCmd(cmd);
    if (!r || !r.ok) return { ok: false, url: null, source, reason: `url_cmd exited non-zero - could not resolve the preview URL (${cmd})` };
    const url = firstUrlLine(r.out);
    if (!url) return { ok: false, url: null, source, reason: `url_cmd printed no http(s) URL on any line (${cmd})` };
    return { ok: true, url, source, sha: null };
  }
  if (source === "github-deployment") {
    if (typeof d.ghDeployments !== "function")
      return { ok: false, url: null, source, reason: "GITHUB_TOKEN / GITHUB_REPOSITORY not available - cannot query the deployments API for the preview URL" };
    if (!headSha) return { ok: false, url: null, source, reason: "no head sha to look up a deployment for" };
    const g = d.ghDeployments(headSha);
    if (!g || !g.ok) return { ok: false, url: null, source, reason: g && g.reason ? g.reason : "deployments API lookup failed" };
    const pick = pickPreviewDeployment(g.deployments, g.statusesById);
    if (!pick.url)
      return { ok: false, url: null, source, reason: `no deployment for head ${String(headSha).slice(0, 10)} exposes an environment_url yet (a preview may still be building, or this platform does not post deployments)` };
    return { ok: true, url: pick.url, source, sha: pick.sha, environment: pick.environment };
  }
  return { ok: false, url: null, source, reason: `unknown url_source "${source}" (expected env | command | github-deployment)` };
}

/*
 * Run a browser receipt end to end. Pure orchestration over injected I/O so it is offline-
 * testable; verify.js wires the real fetch + runCmd + git.
 *
 *   cfg    = verify.browser_receipt block
 *   headSha
 *   deps   = { runCmd(cmd, envExtra) -> {ok,out,ms,code,timedOut}, resolveDeps (passed to
 *             resolvePreviewUrl), env }
 *
 * Returns a result object destined for RECEIPT.browser_receipt:
 *   { configured, url, source, sha_match, ok, degraded, reason, output_tail }
 *   - configured=false => the block was absent (nothing to do)
 *   - degraded=true    => could not resolve the URL / could not run => WARN upstream, ok=null
 *   - ok true/false    => the browser command's exit (0 = the head-only acceptance check passed)
 *   - sha_match: true/false/null (null = not a github-deployment resolution, so N/A)
 */
function runBrowserReceipt(cfg, headSha, deps) {
  if (!cfg || typeof cfg !== "object" || !cfg.command)
    return { configured: false };
  const d = deps || {};
  const res = {
    configured: true,
    mode: cfg.mode === "block" ? "block" : "warn",
    source: (cfg.url_source || "env"),
    url: null, sha_match: null, ok: null, degraded: false, reason: null, output_tail: null,
  };

  const resolved = resolvePreviewUrl(cfg, headSha, d.resolveDeps || {});
  if (!resolved.ok) {
    res.degraded = true;
    res.reason = `could not resolve preview URL - ${resolved.reason}`;
    return res;
  }
  res.url = resolved.url;

  // G3 sha binding: when the URL came from a deployment, the deployment's sha must be the PR
  // head. A mismatch means the preview is NOT the head build - a WARN (never a default block:
  // some platforms report a squashed/normalized sha, and we would rather flag than falsely fail).
  if (resolved.source === "github-deployment") {
    if (resolved.sha && headSha) res.sha_match = String(resolved.sha) === String(headSha);
    else res.sha_match = null; // deployment carried no sha to compare
  }

  if (typeof d.runCmd !== "function") {
    res.degraded = true;
    res.reason = "no command runner available to run the browser receipt";
    return res;
  }
  // Export the resolved URL so the consumer's script (playwright.config baseURL, or a plain
  // `page.goto(process.env.RECEIPTS_PREVIEW_URL)`) can read it. The env var name is FIXED
  // (RECEIPTS_PREVIEW_URL) regardless of url_source/url_env - url_env is only where we READ an
  // env-sourced URL from, not where the script reads it (the script always reads the canonical
  // name, so a consumer's script is url_source-agnostic).
  const r = d.runCmd(cfg.command, { RECEIPTS_PREVIEW_URL: resolved.url });
  res.ok = !!(r && r.ok);
  res.output_tail = tail((r && r.out) || "", 20);
  res.timed_out = !!(r && r.timedOut);
  if (res.timed_out) res.reason = "browser receipt command timed out";
  else if (!res.ok) res.reason = "browser receipt command failed on the preview (head-only acceptance check did not pass)";
  return res;
}

function tail(s, n) { return String(s || "").split("\n").slice(-(n || 20)).join("\n"); }

module.exports = { URL_OK, firstUrlLine, pickPreviewDeployment, resolvePreviewUrl, runBrowserReceipt };
