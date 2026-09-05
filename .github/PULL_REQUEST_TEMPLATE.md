## Summary

- 

## Why

<!-- Motivation, not the diff. Drop the section if the summary says it all. -->

## Receipt

<!--
The enforcer reads THIS body (dogfood: receipts gates its own PRs). Keep exactly one of:

  closes #N                      -> a fix-claim: the changed test file(s) must FAIL on main and PASS here.
                                    Pin one explicitly with `receipt: path/to/the.test.js` if the diff
                                    touches several tests, or use `receipt-cmd: <command> expect:/<regex>/`
                                    for software with no test runner.
  work-type: refactor | chore    -> no behaviour change: the proof is the full suite staying green.
  work-type: feature             -> the acceptance test is red until the behaviour exists.
  unverified-reasoned: <why>     -> you could not verify it; tracked as such, never counted as a clean fix.

A deleted or skipped test needs `test-removal: <why>` here, or G11 flags it.
-->

## Test plan

- [ ] `npm test`
- [ ] `node --test plugin/hooks/test/*.test.mjs plugin/mcp/trajectory-kb/test/*.test.mjs`
- [ ] `node bench/run.js`
- [ ] <!-- the by-value check for THIS change: the command you ran and what it printed -->

## Notes

<!-- Deploy or upgrade implications, generated files you regenerated (build:refs / build:adapters / the MCP bundle), follow-ups. -->
