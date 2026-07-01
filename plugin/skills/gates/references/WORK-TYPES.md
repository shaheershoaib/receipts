# Applying the Gates across work types

The Gates read as if every change is a bug fix - "reproduce the reported symptom," "the
reporter," "the bug." That framing is just the most common case. The underlying mechanic -
a red-before / green-after test asserting the acceptance criterion - is TDD, and it applies
to any kind of change. What varies by work type is (1) what the receipt ASSERTS and (2)
which gates carry the weight. The fourteen gates are the invariant.

This composes with the medium dimension (`references/MEDIA.md`): work type sets WHAT is
asserted; medium sets what the surface / value / build ARE. The receipt is the intersection
of the two.

## The receipt, generalized

A receipt is a test that is red before the change and green after, asserting the
**acceptance criterion** - the thing that defines "done" for THIS change:

| Work type | Acceptance criterion (what the receipt asserts) | red-before | green-after | Gates that carry the weight |
|---|---|---|---|---|
| Fix | the reported symptom is gone | the bug reproduces | the symptom is gone | G0, G1, G4 |
| Feature | the new behavior works to its spec | the acceptance test fails (feature absent) | the feature works | G0-as-acceptance, G4, G6 (match siblings), G7 |
| Migration | data/schema transformed correctly, incl. EXISTING rows | a fixture with legacy rows fails the post-migrate assert | migrated + rollback works | G10 (expand/contract, order), G7, G1, G8 |
| Refactor | behavior is UNCHANGED | (inverted - see below) | the full suite stays green | G9 (dominant), G6 |
| Chore / deps / config | nothing breaks | (inverted) | the full suite stays green | G9, G8, G3, G7 |

## The fix (the default framing)

The spec as written. Observe the reported symptom (G0), reproduce it, fix the surface the
reporter sees (G4), and carry a test that is red on the bug and green on the fix.

## The feature

A feature has no pre-existing symptom; its "symptom" is the absence of the new behavior. So
G0 becomes "write the acceptance test for the new behavior FIRST" - red because the feature
does not exist yet, green once you build it. The "reporter" is the spec / the ticket's
definition of done. The surface gates apply to the NEW surface (G4: where the user will
actually use it; G2: which flow it belongs in). G6 matters extra - a new feature should
match its sibling features (same affordance, same patterns) or it ships an inconsistency.
G7: what will consume the new thing.

## The migration

The acceptance criterion is "the data/schema is correctly transformed, and EXISTING data
survives." The classic trap is a migration that works on fresh data and corrupts or skips
legacy rows - so the receipt MUST run on a fixture that includes representative legacy / edge
rows (not just newly-created ones) and assert their values after migrating (G1 by value).
G10 is central in its database form: expand / contract and ordering - add the new column (and
backfill) before the code reads it; drop the old column only after the code stops using it;
never a destructive change in the same deploy as the code that depends on it. Rollback is
part of "done." G7: every query / ORM model / report that consumes the schema. G8's
migration-number collision check applies when several migrations land in parallel.

## The refactor (the inverted receipt)

A refactor changes NO behavior, so there is nothing to make go red - the receipt inverts.
The proof is not red->green on a new test; it is **the existing suite staying green on head**,
with no behavior change. So:

- G9 (full-scope green) is the dominant gate: the WHOLE suite, on head, must pass - that is
  the refactor's receipt.
- Do not expect (or fake) a red-before. A characterization test that passes on both base and
  head is correct for a refactor, not a "weak receipt."
- G6 (consistency): a refactor that touches one of a set of twins should touch them all.
- If you cannot run the full suite to prove behavior is unchanged, that is an honest
  "unverified," not a clean "done."

## Chore / dependency bumps / config

Usually no behavior change, so the receipt inverts like a refactor (the full suite green is
the proof). A dependency bump adds a G7 emphasis: what depends on the bumped package, and
does it still work. A config / infra change is verified in its medium (`references/MEDIA.md`
- the applied state for IaC, the running service for a deploy config).

## How to signal the work type

- **Per task**, the agent determines the work type from the request ("add X" = feature,
  "fix Y" = fix, "migrate Z" = migration, "rename / extract / clean up" = refactor) and
  applies the framing above. It is not a project setting - most repos mix all of them.
- **For the enforcer**, put a `work-type: <fix|feature|migration|refactor|chore>` line in
  the PR body (or set `gates.work_type` as a project default - usually left unset). The
  enforcer only changes behavior for `refactor` / `chore`: it expects the inverted receipt
  (the full suite green on head) instead of a red->green on a new test, so a behavior-
  preserving change is not flagged as a missing or weak receipt.

## Extending

Any work type maps by answering one question: what is "done" here, and what test is red
until it is done? If the change has observable new or changed behavior, it carries a
red->green receipt (fix / feature / migration). If it must NOT change behavior, the receipt
inverts to "the suite stays green" (refactor / chore). That is the whole taxonomy.
