# RB Ralph — Batch 3 Remediation Report

## Changes Implemented

- Added persisted deterministic execution identity and phase acceptance records.
- Bound cache v3 reuse to both the Batch 2 product seal and deterministic execution identity.
- Revalidated explicit `OPERATIONS.json` through the canonical RB Harness `rb-operational/v1` validator before execution.
- Made clean rooms exclude dependency trees, build outputs, caches, local environments, and run/Git state by default.
- Blocked contractless dynamic RBF rather than accepting a model-selected scenario.
- Rerun all declared deterministic phase commands when RBF changes product state.
- Hardened built-in adapter protected modes and reject unsupported custom manager capability unless explicitly declared.

## Execution Identity

Deterministic identity contains platform, architecture, Node version, Ralph version, bounded runner/tool version digests, and only explicitly named environment variables (`RB_RALPH_EVIDENCE_ENV`) as presence plus SHA-256 value digest. Operational identity additionally binds the explicit operational contract and its declared environment names.

It intentionally excludes model, provider, effort, credentials, and arbitrary inherited environment values. Those remain provenance/telemetry, not deterministic proof inputs. Product identity remains the Batch 2 full seal; phase and RBF acceptance records persist the exact product/execution/operational digests accepted.

## Permission Capability Matrix

| Adapter | Executor protected | Manager protected |
| --- | --- | --- |
| Codex | forced `workspace-write` | forced `read-only` |
| Claude | forced `acceptEdits` | forced `plan` |
| OpenCode | Ralph-owned no-external-directory policy | Ralph-owned deny edit/bash/task/external-directory policy |
| direct API | unsupported (fails closed) | read-only manager tools |
| custom adapter | adapter-defined | fails closed unless it declares `observational-v1`; Batch 1 seal remains a backstop |

Executor YOLO remains available. Manager YOLO is never enabled.

## Operational Acceptance

`bin/rb-ralph` invokes the canonical RB Harness operations validator, and `operational-verifier.cjs` invokes the same validator before executing a scenario. Clean rooms no longer copy installed dependencies, build products, or caches. An explicit contract is mandatory for RBF; missing authority records `BLOCKED` rather than manufacturing dynamic acceptance.

Accepted RBF evidence persists product digest, operations fingerprint, and operational execution identity. If RBF changes product state, all declared deterministic command validations are rerun before final manager acceptance.

## Invariants Established

- Reuse requires matching accepted product seal and execution identity.
- Cache entries without the v3 execution identity miss safely.
- Named environmental values are non-secret digests only.
- Operational schema validity has one authority.
- A clean-room pass cannot depend only on copied local dependencies/builds/caches.
- Contractless RBF cannot select a trivial or undocumented acceptance boundary.
- RBF changes cannot bypass prior deterministic validation.

## Findings Status

| Finding | Status | Basis |
| --- | --- | --- |
| RALPH-AUDIT-007 | RESOLVED | `*-accepted.json` binds resume to sealed product and deterministic execution identity. |
| RALPH-AUDIT-011 | PARTIALLY_RESOLVED | Built-ins/direct API have enforced contracts; custom adapters still rely on an explicit external capability declaration plus Batch 1 fail-after-call seal. |
| RALPH-AUDIT-013 | RESOLVED | Canonical `rb-operational/v1` validation is mandatory; clean room excludes undeclared local execution state. |
| RALPH-AUDIT-014 | RESOLVED | Dynamic RBF is fail-closed; explicit RBF mutations rerun deterministic regression validation. |
| RALPH-AUDIT-006 external-state residual | RESOLVED | Cache v3 and phase/RBF reuse bind bounded external execution identity. |

## Tests

- Complete RB Ralph suite passed:
  - `tests/test-agent-context.sh`;
  - `tests/test-context-efficiency.sh`;
  - `tests/test-dashboard-focus.sh`;
  - `tests/test-manager-review.sh`;
  - `tests/test-validation-cache.sh` (`1..7`);
  - `tests/test-evidence-integrity.sh` (`1..7`);
  - `tests/test-authority-enforcement.sh`;
  - `tests/test-execution-identity.sh` (`1..11`);
  - `tests/test-execution-parallelism.sh`;
  - `tests/test-portability-and-contract.sh`.
- Batch 3 coverage: `TEST-RUN-001` product change, `TEST-RUN-002` Context change, `TEST-RUN-003` stable reuse, `TEST-RUN-004` named external environment identity, `TEST-PERM-001` unsupported custom manager, `TEST-OPS-001` validator parity, `TEST-OPS-002` clean-room dependency state, and `TEST-RBF-001` fail-closed dynamic RBF all passed.
- Enforcement/proof map: phase/RBF acceptance records in `bin/rb-ralph` enforce items 1–4 and 11; `execution-identity.cjs` and cache v3 enforce item 4; built-in adapters and `configure_roles` enforce items 5–6; canonical core plus `operational-verifier.cjs` enforce items 7–8; the RBF contract gate enforces item 9; `rerun_rbf_regressions` enforces item 10.
- Static checks passed: `bash -n` for runtime/adapters/installer/all named test scripts; `node --check` for Batch 3 helpers; and `git diff --check`.

## Performance Impact

One current product seal is made per invocation for resume identity and reused for phase comparisons. The execution identity uses a small fixed tool set plus explicitly named variables; it neither scans the full environment nor stores values. Cache reuse prefers a miss when identity is unavailable or differs.

## Compatibility Notes

Legacy cache files are v2 and miss safely. Existing custom manager adapters must explicitly declare `RB_RALPH_CUSTOM_MANAGER_CAPABILITY=observational-v1` or use a built-in/direct API manager. Projects without `OPERATIONS.json` must add an explicit contract or disable final audit deliberately.

## Remaining Risks

The custom-manager declaration is an adapter contract, not an OS sandbox Ralph can independently measure; its product/control-plane seals remain defense in depth. Cross-platform and network side effects remain outside the bounded local execution identity. Batch 4 findings were not changed intentionally.
