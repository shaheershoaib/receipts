# Releasing (maintainers)

`receipts-cli` is on npm and the plugin installs from this repo's `main` through Claude Code's
marketplace, so a merge to `main` already ships the plugin to anyone who runs
`claude plugin update`; the npm release is the CLI's half. To cut a version:

1. Bump `version` in `package.json`, `plugin/.claude-plugin/plugin.json` **and**
   `.claude-plugin/marketplace.json` - a test keeps the three in lockstep.
2. Regenerate anything derived from an edited source, and commit the output:
   - `spec/*.md` or `enforcer/INIT.md` -> `npm run build:refs` (the bundled skill references)
   - `plugin/skills/gates/SKILL.md` -> `npm run build:adapters` (`adapters/AGENTS.md`, Cursor)
   - `plugin/mcp/trajectory-kb/index.js` -> `cd plugin/mcp/trajectory-kb && npm install && npm run build`
     (`server.bundle.mjs`; the handshake test in `plugin/mcp/trajectory-kb/test/` fails on a stale bundle)
3. If you edited `spec/GATES.md`, bump `receipts/gates@X.Y` there: additive -> minor, a changed
   meaning -> major. A test checks that the README and both manifests state the same version and
   gate range.
4. Move the `Unreleased` section of `CHANGELOG.md` under the new version heading with the date.
5. Tag and push - **CI publishes**: `git tag v<version> && git push origin v<version>`.

The `release` workflow re-checks the tag against `package.json`, refuses to republish a version
already on the registry, runs the full gate (enforcer suite, hook tests, gates-bench), and only
then publishes with **npm provenance** - a verifiable link from the tarball back to the run that
built it. A publish is a claim like any other; this makes it carry its own receipt.

## One-time setup: trusted publishing

No token anywhere: on npmjs.com open the `receipts-cli` package -> **Settings** -> **Trusted
Publisher** -> **GitHub Actions**, and enter organization/user `shaheershoaib`, repository
`receipts`, workflow `release.yml` (leave Environment blank). CI then mints a short-lived
credential from its own OIDC identity - there is no secret to leak, rotate, or lose. The trusted
publisher binds to the workflow FILENAME; renaming `release.yml` breaks publishing with a 404
that nothing else explains (a test guards the name).

This is also the path that keeps working: npm restricted 2FA-bypass tokens in July 2026 and
[retires their direct-publish capability in January 2027](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/).

## Publishing by hand instead

`npm publish --otp=<code>` from a clean checkout, after `npm login`. The OTP is required
interactively - a stored token cannot stand in for it, and as of January 2027 a 2FA-bypass token
cannot publish at all.

npm requires an auth token to publish even with no 2FA on the account. One-time: create a
**Granular Access Token** (npmjs.com -> Access Tokens) with **Packages and scopes = Read and
write, "All packages"** (Organizations = No access; no org needed), then
`npm config set //registry.npmjs.org/:_authToken=<TOKEN>`.

## The real-session CI step

The `plugin-install` job runs one real headless Claude turn to prove the SessionStart hook's
output reaches the model, but only when the repository has an `ANTHROPIC_API_KEY` secret; without
it the step is skipped with a notice in the job log. Adding the secret costs one short turn per
PR.
