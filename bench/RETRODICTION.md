# Retrodiction pass - would the new gates have caught the real failures?

Method: each documented failure scored against the gate text as written.
Verdict = WOULD FIRE (the gate demands an artifact whose absence blocks) /
PARTIAL (names the trap, cannot force the answer) / MISS (not covered).
Mechanism = MECHANICAL (a query/count decides) or JUDGMENT (an agent decides).

## Migration failures

| # | Failure | Gate | Verdict | Mechanism |
|---|---|---|---|---|
| 1 | Reconciled on row counts only; 23 defects, 9 silent-corruption | G18 destination contract | WOULD FIRE | MECHANICAL |
| 2 | Keyed on re-sequenced id -> 41% attached to wrong entity | G18 key identity + match rate | WOULD FIRE | MECHANICAL |
| 3 | Natural key mapped N:1, silently picked wrong row | G18 key uniqueness | WOULD FIRE | MECHANICAL |
| 4 | Submit-flag read as funds-collected (18k) | G18 behaviour-not-names | PARTIAL | JUDGMENT |
| 5 | delivered_at 100% NULL -> date-scoped report empty | G18 census (NULL conventions) | WOULD FIRE | MECHANICAL |
| 6 | Delivery flag dropped; contact grain flattened to customer | -- | **MISS** | -- |
| 7 | Reload truncated app-managed users/roles | G18 reload scoping | WOULD FIRE | JUDGMENT |
| 8 | Grouping applied from a stale supplied CSV | G18 provenance | PARTIAL | JUDGMENT |
| 9 | Class codes only 49% covered | G18 coverage census | WOULD FIRE | MECHANICAL |
| 10 | Money column varchar -> $0 premiums | G18 census (type reality) | WOULD FIRE | MECHANICAL |
| 11 | Denormalized FK drifted from authoritative history | G18 full-population reconcile | WOULD FIRE | MECHANICAL |
| 12 | NULL-FK rows stashed identity in fallback cols | G18 carry-whole-identity | WOULD FIRE | MECHANICAL |

## Reopen failures

| # | Failure | Gate | Verdict | Mechanism |
|---|---|---|---|---|
| 13 | Fixed one of two serializers | G6 observable-keying | WOULD FIRE | JUDGMENT (artifact required) |
| 14 | Two stores of one state; one left stale | G6 write-side twins | WOULD FIRE | JUDGMENT (artifact required) |
| 15 | Test mocked the persist boundary | G9 round-trip | WOULD FIRE | MECHANICAL |
| 16 | Display parse bug diagnosed as data bug | ship sibling-surface | PARTIAL | JUDGMENT |
| 17 | Fixed prod, reporter retested lagging staging | G3 retest environment | WOULD FIRE | JUDGMENT |
| 18 | Thread grew new asks while building | ship close-out thread diff | WOULD FIRE | JUDGMENT |
| 19 | Forward-only fix; reporter's own record still wrong | G16 existing instances | WOULD FIRE | JUDGMENT |

## Score

19 cases: 15 WOULD FIRE, 3 PARTIAL, 1 MISS.
8 of the 15 are MECHANICAL (a query or count decides, not an opinion).

## The MISS - and what it exposes

Case 6 is not covered, and it is two distinct gaps:

**6a. Column-level coverage.** G18's coverage census counts ROWS (in scope /
transformed / skipped). A column present in the source and simply never carried
passes a row census perfectly - every row moved, one field silently absent. The
census must cover COLUMNS as well as rows.

**6b. Grain / cardinality change.** A transform that collapses a one-to-many into
a one-to-one (per-contact rows flattened to per-customer) loses information while
every row count still reconciles. Nothing in G18 asks whether the relationship's
grain survived.

Both are mechanical to check, which is what makes the omission worth fixing.

## Honest limits of this exercise

- Retrodiction, not prediction: these gates were written knowing these failures.
  A gate scoring WOULD FIRE here is necessary, not sufficient.
- "WOULD FIRE" mostly means the gate REQUIRES AN ARTIFACT whose absence is
  visible - not that a machine blocks. 11 of 19 are agent-side.
- I authored both the gates and this scoring. It needs an independent pass.
