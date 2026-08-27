# RB Ralph — Batch 4 Remediation Report

Runtime altered: RB Ralph `0.10.1`.

## Changes Implemented

- Parallel worktree integration now selects `combined` validation mode. It
  executes every declared deterministic command fresh after the patches have
  been integrated, retains the combined product seal as the G2/G3/accepted
  phase identity, and does not reuse isolated or earlier cache proof.
- Added one `rb-ralph-executor-completion/v1` classifier for all executor
  invocations. It distinguishes `completed`, `incomplete`, `failed`,
  `timeout`, and `rate_limited`. A no-delta clean exit needs a terminal
  structured result; an incidental legacy marker is not sufficient.
- Added packaged release identity metadata and verifier. It binds `VERSION` to
  the runtime metadata and labels the consolidated `0.8.11` document as a
  historical snapshot rather than current runtime authority.
- Added deterministic known-value redaction and typed provenance manifests for
  executor output/submission, manager narrative, validation output, operational
  verification output, and orchestrator-generated evidence.

## Parallel Combined-State Integrity

`validation-cache.cjs select ... combined` bypasses cache reuse and emits the
complete declared command matrix after successful worktree integration. G2
seals that integrated product state; the same digest is supplied to G3 and is
persisted in `rb-ralph-phase-evidence/v1` acceptance records. The existing
Batch 1 primary-tree seal remains in place before integration, so a worktree
executor changing the primary project still fails closed before patches apply.

This is intentionally proof by combined deterministic validation, not semantic
static analysis and not a change that disables parallelism.

## Executor Completion Protocol

`lib/executor-completion.cjs` is the sole G0 completion interpreter. A terminal
structured result is:

```text
RB_RALPH_EXECUTOR_RESULT: {"contract":"rb-ralph-executor-completion/v1","status":"completed"}
```

It is only a claim that the turn ended. It is not acceptance evidence and does
not bypass G1, G2, G3, a product seal, manager review, or deterministic
validation. Built-in and custom adapter output is evaluated under the same
rule. A successful invocation with a product delta is classified complete but
still requires all downstream gates; a clean no-delta invocation without the
terminal result is incomplete.

## Contract and Runtime Identity

`RB-RALPH-CONTRACT-IDENTITY.json` ships with the runtime and is verified before
execution. It identifies `0.10.1` as the executable version, labels the
consolidated `RB-RALPH-CONTRACT.md` `0.8.11` snapshot historical, and names the
independent authoritative data contracts: `rb-manifest/v1`,
`rb-execution/v1`, and `rb-operational/v1`. The package installer copies both
the metadata and verifier; a mismatched runtime version fails verification.

## Evidence Provenance and Redaction

`rb-ralph-evidence-provenance/v1` records distinguish:

- orchestrator-generated deterministic evidence;
- provider output and provider-submitted evidence (`untrusted`);
- manager narrative (`provider-asserted`);
- deterministic validation output;
- operational verification output.

Provider submissions from `RB_RALPH_AGENT_EVIDENCE_DIR` are retained but remain
provider-originated/untrusted after copy. They cannot become G2/G3 proof merely
by residing beneath `.rb/runs`.

Before canonical persistence, Ralph redacts known values from executor,
manager, validation, operational, and provider-submission output. The bounded
source set is configured credential values, values of `RB_RALPH_EVIDENCE_ENV`,
the configured memory-token environment, and explicit/inherited operational
environment values. No entropy or suspicious-string detector was added; secrets
Ralph does not possess and external network side effects remain outside this
deterministic boundary.

## Invariants Established

| Invariant | Runtime enforcement | Regression |
| --- | --- | --- |
| `INV-FINAL-001` | Fresh complete declared deterministic matrix after parallel integration; combined seal is phase acceptance identity | `TEST-FINAL-001`, `TEST-FINAL-002` |
| `INV-FINAL-002` | Canonical completion classifier with five explicit outcomes and terminal structured result | `TEST-FINAL-003`, `TEST-FINAL-004`, `TEST-FINAL-005` |
| `INV-FINAL-003` | Packaged release identity verifies `VERSION`; historical consolidated snapshot cannot present as current | `TEST-FINAL-006` |
| `INV-FINAL-004` | Provenance manifests/index label deterministic, provider, manager, validation, and operational evidence | `TEST-FINAL-007` |
| `INV-FINAL-005` | Known values are redacted before canonical log/submission persistence without deleting ordinary diagnostics | `TEST-FINAL-008`, `TEST-FINAL-009` |

## Findings Status

| Finding | Status | Basis |
| --- | --- | --- |
| `RALPH-AUDIT-015` | **RESOLVED** | Parallel acceptance now relies on fresh validation of the integrated product state, not isolated success/cache or path compatibility alone. |
| `RALPH-AUDIT-016` | **RESOLVED** | G0 completion has one provider-neutral canonical interpretation; old substring matching is not acceptance. |
| `RALPH-AUDIT-017` | **RESOLVED** | Runtime metadata mechanically distinguishes current executable identity from the historical consolidated snapshot and preserves data-contract independence. |
| `RALPH-AUDIT-018` | **RESOLVED** | Canonical evidence has explicit provenance; provider submissions remain untrusted; known values are deterministically redacted. |
| `RALPH-AUDIT-011` | **PARTIALLY_RESOLVED** (unchanged) | Built-ins/direct API have enforced protected contracts; custom managers still rely on `observational-v1` plus Batch 1 sealing, not an OS sandbox Ralph can independently prove. |

## Tests

The complete Ralph regression suite passed after the final changes:

- `tests/test-agent-context.sh`;
- `tests/test-context-efficiency.sh`;
- `tests/test-dashboard-focus.sh`;
- `tests/test-manager-review.sh`;
- `tests/test-validation-cache.sh` (`1..7`);
- `tests/test-evidence-integrity.sh` (`1..7`);
- `tests/test-authority-enforcement.sh`;
- `tests/test-execution-identity.sh` (`1..11`);
- `tests/test-execution-parallelism.sh` (`1..99`);
- `tests/test-portability-and-contract.sh` (`1..247`);
- `tests/test-final-remediation.sh` (`1..17`).

`bash -n` passed for runtime, adapters, installer, and Batch 4 test; Node
syntax checks passed for all changed/new helpers; `git diff --check` passed.

## Performance Impact

Only phases actually using parallel worktrees forgo validation-cache reuse, and
then only because the integrated behavior is the acceptance object. Sequential
execution keeps cache v3 behavior. Product seals are reused; provenance is
written once per evidence class; redaction scans only known values and does not
perform heuristic secret analysis.

## Compatibility Notes

The changes preserve task and phase execution units, shared and worktree modes,
fresh execution, retry/resume, Codex, Claude, OpenCode, direct API, custom
adapters, executor YOLO, protected managers, and explicit operational
acceptance. Custom executor adapters that complete with no product delta must
emit the terminal structured completion result. The documented custom-manager
`observational-v1` boundary is unchanged.

## Remaining Risks

Ralph does not prove arbitrary custom-adapter OS isolation, network side-effect
absence, or redaction of secrets it never receives. Combined-state validation
proves only the declared deterministic matrix; an insufficient product test
matrix remains a product-authoring risk, not a cache/integration acceptance
bypass. These boundaries are explicit and no broader sandbox, semantic analyzer,
release platform, or general secret detector was introduced.
