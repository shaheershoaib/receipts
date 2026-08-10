#!/usr/bin/env node
"use strict";
/*
 * Action-side reporter: turn the receipt artifact into feedback humans act on.
 *
 *   node report.js <receipt.json>
 *
 * Reads the CI environment (all optional - each surface degrades independently):
 *   GITHUB_STEP_SUMMARY  append the markdown report to the job summary (always, if set)
 *   COMMENT=true         upsert a PR comment with the same report (needs GH_TOKEN +
 *                        PR_NUMBER + GITHUB_REPOSITORY; needs `pull-requests: write`)
 *   GH_TOKEN, PR_NUMBER, HEAD_SHA, GITHUB_REPOSITORY, GITHUB_API_URL
 *
 * Also the G3 assist: when the repo's config says build.sha_source =
 * "github-deployments", look up whether ANY deployment reached the head sha and append
 * the answer to the report - advisory only (deploys typically land after merge; a
 * missing PREVIEW deployment is a hint, not a failure). Never changes the exit code:
 * reporting must not be able to flip a verdict.
 */
const fs = require("fs");
const path = require("path");
const { renderMarkdown, COMMENT_MARKER } = require("./render.js");

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const REPO = process.env.GITHUB_REPOSITORY || "";
const TOKEN = process.env.GH_TOKEN || "";

async function gh(pathname, init) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "receipts-enforcer",
      ...(init && init.body ? { "content-type": "application/json" } : {}),
      ...(init && init.headers),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// G3 assist: has any deployment reached the head sha? Returns a markdown line, or null
// when the check does not apply (no config / not github-deployments / no sha / no token).
async function deployLine(repoRoot, headSha) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, "receipts.config.json"), "utf8")); }
  catch { return null; }
  if (!cfg || !cfg.build || cfg.build.sha_source !== "github-deployments") return null;
  if (!headSha || !TOKEN || !REPO) return null;
  const dep = await gh(`/repos/${REPO}/deployments?sha=${encodeURIComponent(headSha)}&per_page=5`);
  if (dep.status !== 200 || !Array.isArray(dep.body))
    return `**G3 deploy lookup:** deployments API returned ${dep.status} - could not confirm a build carries \`${headSha.slice(0, 10)}\`; verify the deployed sha manually.`;
  if (!dep.body.length)
    return `**G3 right build (advisory):** no deployment carries head \`${headSha.slice(0, 10)}\` yet - anything observed on a deployed URL right now is the OLD build. Verify after the deploy reports this sha.`;
  for (const d of dep.body) {
    const st = await gh(`/repos/${REPO}/deployments/${d.id}/statuses?per_page=10`);
    if (st.status === 200 && Array.isArray(st.body) && st.body.some((s) => s.state === "success"))
      return `**G3 right build:** deployment \`${(d.environment || "?")}\` reports success for head \`${headSha.slice(0, 10)}\` ✅`;
  }
  return `**G3 right build (advisory):** deployment(s) exist for head \`${headSha.slice(0, 10)}\` but none report success yet - verify on the deployed build once one does.`;
}

/*
 * Is this run a pull request from a FORK? It matters for one reason: on a fork PR
 * GitHub downgrades GITHUB_TOKEN to read-only NO MATTER WHAT the workflow's
 * `permissions:` block says, so a write is refused even though the permission is
 * correctly declared. Telling that user to declare the permission they already
 * declared sends them to debug a config that was never wrong.
 */
function isForkPullRequest() {
  try {
    const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
    const pr = ev && ev.pull_request;
    if (!pr || !pr.head || !pr.base) return false;
    const head = pr.head.repo && pr.head.repo.full_name;
    const base = pr.base.repo && pr.base.repo.full_name;
    return Boolean(head && base && head !== base);
  } catch { return false; }  // no payload (local run, other event): assume same-repo
}

function postFailureHint(status) {
  if (status !== 403) return "";
  return isForkPullRequest()
    ? " - fork PR: GITHUB_TOKEN is read-only on forks regardless of the `permissions:` block, so commenting cannot work here. This is expected, not a misconfiguration; run the report on `pull_request_target` or read the result from the job summary."
    : " - the workflow needs `permissions: pull-requests: write`";
}

// Every comment on the PR. GitHub caps a page at 100, and a busy PR has more than
// that - stopping at the first page silently loses the existing report comment and
// posts a duplicate on every push.
async function allComments(prNumber) {
  const out = [];
  for (let page = 1; page <= 10; page++) {   // bounded: 1000 comments is not a real PR
    const res = await gh(`/repos/${REPO}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (res.status !== 200 || !Array.isArray(res.body) || !res.body.length) break;
    out.push(...res.body);
    if (res.body.length < 100) break;
  }
  return out;
}

// Upsert: refresh the one report comment instead of stacking a new one per push.
async function upsertComment(prNumber, body) {
  const mine = (await allComments(prNumber))
    .find((c) => String(c.body || "").startsWith(COMMENT_MARKER));
  if (mine) {
    const res = await gh(`/repos/${REPO}/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    return res.status === 200 ? "updated" : `update failed (${res.status}${postFailureHint(res.status)})`;
  }
  const res = await gh(`/repos/${REPO}/issues/${prNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  return res.status === 201 ? "created" : `create failed (${res.status}${postFailureHint(res.status)})`;
}

async function main() {
  const receiptPath = process.argv[2];
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(receiptPath, "utf8")); }
  catch {
    process.stderr.write(`receipts report: no readable receipt at ${receiptPath} - nothing to report\n`);
    return;
  }

  let md = renderMarkdown(rec);
  const g3 = await deployLine(process.cwd(), process.env.HEAD_SHA).catch(() => null);
  if (g3) md += `\n${g3}\n`;

  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); }
    catch (e) { process.stderr.write(`receipts report: could not write step summary - ${e.message}\n`); }
  } else {
    process.stdout.write(md);
  }

  if (String(process.env.COMMENT).toLowerCase() === "true") {
    const pr = process.env.PR_NUMBER;
    if (!pr || !TOKEN || !REPO) {
      process.stderr.write("receipts report: COMMENT=true but PR_NUMBER / GH_TOKEN / GITHUB_REPOSITORY missing - skipping the PR comment\n");
      return;
    }
    const outcome = await upsertComment(pr, COMMENT_MARKER + "\n" + md).catch((e) => `errored (${e.message})`);
    process.stderr.write(`receipts report: PR comment ${outcome}\n`);
  }
}

// Only run as a script. Required as a module (by tests) it exports its pieces, so
// the two network-I/O paths can be exercised against a stubbed fetch rather than
// being the untested corner of the enforcer.
if (require.main === module) {
  main().catch((e) => {
    // Reporting is a side-channel: it must never fail the job or flip a verdict.
    process.stderr.write(`receipts report: ${e && e.message ? e.message : e}\n`);
  });
}

module.exports = { deployLine, upsertComment, allComments, isForkPullRequest, postFailureHint };
