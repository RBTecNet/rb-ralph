# RB Ralph — Batch 2 Remediation Report

## Changes Implemented

- `lib/evidence.cjs`: added a stable digest for Batch 1 full product seals.
- `lib/validation-cache.cjs`: cache v2 binds a green command to its command identity and sealed product-state digest. Legacy entries miss safely.
- `bin/rb-ralph`: seals the product before and after G2; a validation that mutates product state is invalid evidence. It detects changed validation infrastructure, reruns it, and forbids same-attempt COMPLETE. G3 now receives its decision/reason only from the canonical audit helper.
- `lib/manager-audit.cjs`: is the sole parser for exhaustive and legacy decision surfaces; it rejects duplicate/invalid status, decision, reason, rows, findings, and invalid matrix/decision combinations. Finding closure now needs a stable ledger ID plus new evidence via `RB_RALPH_FINDING_RESOLUTION`.
- Tests and README now use explicit finding resolution and document the stricter protocol.

## Invariants Established

| Invariant | Runtime enforcement | Regression |
|---|---|---|
| `INV-EVID-001` | G2 detects changed test/config/script/dependency-like paths, reruns declared validation, and forces a new attempt before COMPLETE | `test-evidence-integrity.sh`: real G2 no-op validation-script change |
| `INV-EVID-002` | cache v2 requires exact product-seal digest and command identity | `test-validation-cache.sh`, `test-evidence-integrity.sh` |
| `INV-EVID-003` | Batch 1 full seal, not bounded G1 presentation evidence, is the deterministic cache/G2 state identity; pre/post-G2 comparison rejects mutation | `test-evidence-integrity.sh` |
| `INV-EVID-004` | `reconcile` preserves omissions; only named resolution with changed fingerprint closes | `test-evidence-integrity.sh` |
| `INV-EVID-005` | `manager-audit.cjs` owns exhaustive and legacy parsing; duplicate decisions/statuses/reasons fail closed | `test-evidence-integrity.sh`, `test-execution-parallelism.sh` |
| `INV-EVID-006` | declared task/AC rows require `PASS` for COMPLETE; `NOT_APPLICABLE` has no currently declared typed exemption | `test-evidence-integrity.sh` |

## Findings Status

| Finding | Status | Evidence |
|---|---|---|
| `RALPH-AUDIT-005` | RESOLVED | real G2 regression rejects same-attempt green after validation-infrastructure mutation |
| `RALPH-AUDIT-006` | RESOLVED | cache seal identity safe-reuse/stale-rejection regressions |
| `RALPH-AUDIT-009` | RESOLVED | omission and explicit-resolution lifecycle regressions |
| `RALPH-AUDIT-010` | RESOLVED | canonical parser rejects contradictory decisions; no shell last-line interpretation remains |
| `RALPH-AUDIT-012` | RESOLVED | full Batch 1 seal is reused for G2/cache correctness; bounded evidence remains presentation-only |

## Tests

- New: `tests/test-evidence-integrity.sh` — parser ambiguity, N/A bypass, finding lifecycle, cache continuity/staleness, and real G2 validation-infrastructure mutation.
- Updated: `tests/test-validation-cache.sh`; `tests/test-execution-parallelism.sh` fixtures now give explicit finding resolutions where they previously relied on omission.
- Full suite passed: `test-agent-context`, `test-context-efficiency`, `test-dashboard-focus`, `test-manager-review`, `test-validation-cache` (7), `test-evidence-integrity` (7), `test-authority-enforcement`, `test-execution-parallelism` (99), and `test-portability-and-contract` (247). `bash -n`, `node --check`, and `git diff --check` also passed.

## Performance Impact

One full product seal is captured before G2 and compared once after it. The seal is reused by every cache lookup/record in that attempt; the manager still receives only the bounded evidence index. This favors a cache miss over a stale green result and does not repeatedly hash the tree per command.

## Compatibility Notes

`--manager-audit legacy` still accepts the old decision/reason surface but now has the same duplicate-decision rejection and explicit-open-finding closure rule. Exhaustive managers must use `RB_RALPH_FINDING_RESOLUTION` to close a prior finding. Existing plans have no typed N/A exemption, so their declared rows cannot complete as `NOT_APPLICABLE`.

## Remaining Risks

Validation-mechanism detection is deliberately generic rather than language-specific. Unknown command dependencies are still safe for cache reuse because the full product seal must match exactly; a changed mechanism is conservatively rerun and cannot complete in that same attempt. Environment/provisioning identity outside the project remains outside this batch's scope.
