# RB Execution Plan: minimal

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: init-minimal-execution -->

## Phase 1: Build the foundation

**Phase ID:** P01
**Goal:** Build the smallest verified foundation.
**Depends on:** none
**Context:**
- `.rb/init/PROJECT.md`
- `.rb/init/PLAN.md`

- [ ] T001 — Create the foundation
  - **Scope:** `src/`, `tests/`
  - **Change:** Implement the documented foundation without unrelated changes.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The foundation exposes the behavior required by RF-001.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** Source changes, regression tests, and passing validation output.
