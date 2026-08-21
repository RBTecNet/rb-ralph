# RB Execution Plan: multiple

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: feature-multiple-execution -->

## Phase 1: Define the contract

**Phase ID:** P01
**Goal:** Establish the public contract.
**Depends on:** none
**Context:**
- `.rb/features/multiple/SPEC.md`
- `.rb/features/multiple/PLAN.md`

- [x] T001 — Define the interface
  - **Scope:** `src/contracts/`, `tests/contracts/`
  - **Change:** Define the interface described by CT-001.
  - **Covers:** CT-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The exported contract requires `id` and `kind` and rejects an unsupported `kind` with `invalid_contract`.
  - **Validation:**
    - `npm test -- contracts`
  - **Expected evidence:** Contract artifact and passing contract tests.

## Phase 2: Implement consumers

**Phase ID:** P02
**Goal:** Implement independent consumers of the contract.
**Depends on:** P01
**Context:**
- `.rb/features/multiple/SPEC.md`
- `.rb/features/multiple/PLAN.md`

- [ ] T002 — Implement consumer A
  - **Scope:** `src/a/`, `tests/a/`
  - **Change:** Implement consumer A against CT-001.
  - **Covers:** RF-001, CT-001
  - **Depends on:** T001
  - **Parallel safe:** true
  - **Acceptance criteria:**
    - AC-T002-01: Given a valid CT-001 payload, consumer A stores one result and returns exit code 0.
  - **Validation:**
    - `npm test -- a`
  - **Expected evidence:** Consumer A changes and passing focused tests.

- [ ] T003 — Implement consumer B
  - **Scope:** `src/b/`, `tests/b/`
  - **Change:** Implement consumer B against CT-001.
  - **Covers:** RF-002, CT-001
  - **Depends on:** T001
  - **Parallel safe:** true
  - **Acceptance criteria:**
    - AC-T003-01: Given an invalid CT-001 payload, consumer B stores no result and returns `invalid_contract`.
  - **Validation:**
    - `npm test -- b`
  - **Expected evidence:** Consumer B changes and passing focused tests.
