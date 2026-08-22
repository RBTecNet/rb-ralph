#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RALPH="$ROOT/bin/rb-ralph"
CLI="$ROOT/core/rb-harness.cjs"
FIXTURE="$ROOT/tests/fixtures/execution/valid/multiple/PHASES.md"
MINIMAL_FIXTURE="$ROOT/tests/fixtures/execution/valid/minimal/PHASES.md"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

# This suite isolates rb-execution/v1 phase mechanics. The package-level Ralph
# suite covers the default runtime-only RBF operational acceptance separately.
export RB_RALPH_FINAL_AUDIT=0
export RB_RALPH_EXECUTION_UNIT=phase
export RB_RALPH_MANAGER_AUDIT_MODE=legacy

PASS=0

ok() {
  PASS=$((PASS + 1))
  printf 'ok %s - %s\n' "$PASS" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local file="$1" expected="$2" message="$3"
  grep -Fq "$expected" "$file" || fail "$message"
  ok "$message"
}

assert_eq() {
  local expected="$1" actual="$2" message="$3"
  [ "$expected" = "$actual" ] || fail "$message (expected=$expected actual=$actual)"
  ok "$message"
}

new_project() {
  local name="$1"
  local project="$TEMP_ROOT/$name"
  mkdir -p "$project/.rb/features/example"
  node "$CLI" project init "$project" --name "$name" --id "$name" >/dev/null
  cp "$FIXTURE" "$project/.rb/features/example/PHASES.md"
  node "$CLI" manifest sync "$project" >/dev/null
  printf '%s\n' "$project"
}

new_git_project() {
  local name="$1" project
  project="$(new_project "$name")"
  printf 'committed\n' > "$project/base.txt"
  mkdir -p "$project/src"
  printf '%s\n' 'left=base' 'right=base' > "$project/src/shared-scope.txt"
  git -C "$project" init -q
  git -C "$project" config user.name "RB Test"
  git -C "$project" config user.email "rb-test@localhost"
  git -C "$project" add .
  git -C "$project" commit -qm "fixture"
  printf 'local-change\n' > "$project/base.txt"
  printf 'untracked-context\n' > "$project/local.txt"
  printf '%s\n' "$project"
}

MOCK_STATE="$TEMP_ROOT/mock-state"
mkdir -p "$MOCK_STATE"
export MOCK_STATE

cat > "$TEMP_ROOT/mock-agent" <<'MOCK_AGENT'
#!/usr/bin/env bash
set -euo pipefail
prompt="$MOCK_STATE/agent-${RB_RALPH_PHASE_ID}-${RB_RALPH_ATTEMPT}.txt"
cat > "$prompt"
count_file="$MOCK_STATE/agent-count"
count=0
[ -f "$count_file" ] && count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
if [ "${MOCK_AGENT_RATE_LIMIT_ONCE:-0}" -eq 1 ] && [ "$count" -eq 1 ]; then
  printf '%s\n' 'RB_RALPH_PROVIDER_STATUS: RATE_LIMIT' 'RB_RALPH_RETRY_AFTER: 0'
  exit 75
fi
mkdir -p src
printf 'implemented by mock\n' > "src/rb-${RB_RALPH_PHASE_ID}.txt"
printf 'mock agent complete\n'
MOCK_AGENT

cat > "$TEMP_ROOT/mock-manager" <<'MOCK_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > "$MOCK_STATE/manager-${RB_RALPH_PHASE_ID}-${RB_RALPH_ATTEMPT}.txt"
case "${MOCK_MANAGER_SCENARIO:-complete}" in
  always-complete)
    printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: optimistic approval'
    ;;
  blocked)
    printf '%s\n' 'RB_RALPH_DECISION: BLOCKED' 'RB_RALPH_REASON: external decision required'
    ;;
  retry-once)
    if [ "$RB_RALPH_ATTEMPT" -eq 1 ]; then
      printf '%s\n' 'RB_RALPH_DECISION: RETRY' 'RB_RALPH_REASON: focused validation failed'
    else
      printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: implementation and evidence accepted'
    fi
    ;;
  echoed-protocol)
    printf '%s\n' \
      'RB_RALPH_DECISION: COMPLETE | RETRY | BLOCKED' \
      'RB_RALPH_REASON: <short evidence-based reason>' \
      'RB_RALPH_DECISION: COMPLETE' \
      'RB_RALPH_REASON: implementation and evidence accepted after echoed prompt'
    ;;
  *)
    if [ -f "src/rb-${RB_RALPH_PHASE_ID}.txt" ] || \
      { [ -f "src/T002.txt" ] && [ -f "src/T003.txt" ]; }; then
      printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: implementation and evidence accepted'
    else
      printf '%s\n' 'RB_RALPH_DECISION: RETRY' 'RB_RALPH_REASON: implementation file is missing'
    fi
    ;;
esac
MOCK_MANAGER

chmod +x "$TEMP_ROOT/mock-agent" "$TEMP_ROOT/mock-manager"

cat > "$TEMP_ROOT/parallel-agent" <<'PARALLEL_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > "$MOCK_STATE/parallel-prompt-${RB_RALPH_TASK_ID}.txt"
touch "$MOCK_STATE/started-${RB_RALPH_TASK_ID}"
for _ in $(seq 1 100); do
  started="$(find "$MOCK_STATE" -name 'started-T*' -type f | wc -l)"
  [ "$started" -ge 2 ] && break
  sleep 0.02
done
started="$(find "$MOCK_STATE" -name 'started-T*' -type f | wc -l)"
[ "$started" -ge 2 ] || exit 9
touch "$MOCK_STATE/parallel-${RB_RALPH_TASK_ID}"
mkdir -p src
printf 'parallel implementation\n' > "src/${RB_RALPH_TASK_ID}.txt"
printf 'parallel task %s complete\n' "$RB_RALPH_TASK_ID"
PARALLEL_AGENT
chmod +x "$TEMP_ROOT/parallel-agent"

cat > "$TEMP_ROOT/isolated-agent" <<'ISOLATED_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
[ "$(cat base.txt)" = "local-change" ]
[ "$(cat local.txt)" = "untracked-context" ]
printf '%s\t%s\n' "$RB_RALPH_TASK_ID" "$RB_RALPH_PROJECT_ROOT" >> "$MOCK_STATE/isolation-roots.tsv"
mkdir -p src
case "${ISOLATED_AGENT_SCENARIO:-disjoint}" in
  conflict) printf 'implemented %s\n' "$RB_RALPH_TASK_ID" > src/shared.txt ;;
  overlap)
    if [ "$RB_RALPH_TASK_ID" = "T002" ]; then
      sed -i 's/left=base/left=T002/' src/shared-scope.txt
    else
      sed -i 's/right=base/right=T003/' src/shared-scope.txt
    fi
    ;;
  *) printf 'implemented %s\n' "$RB_RALPH_TASK_ID" > "src/${RB_RALPH_TASK_ID}.txt" ;;
esac
ISOLATED_AGENT
chmod +x "$TEMP_ROOT/isolated-agent"

cat > "$TEMP_ROOT/mock-memory" <<'MOCK_MEMORY'
#!/usr/bin/env bash
set -euo pipefail
command="$1"
shift
printf '%s\t%s\n' "$command" "$*" >> "$MOCK_STATE/memory-calls.tsv"
case "$command" in
  remote-bootstrap)
    printf '%s\n' '{"project":{"id":"memory-project","name":"Memory Project"},"memories":[{"memory":{"title":"Prior decision","content":"Keep provider neutrality","confidence":"confirmed","evidence":[]}}]}'
    ;;
  remote-checkpoint)
    cp "$1" "$MOCK_STATE/checkpoint.json"
    printf '%s\n' '{"id":"00000000-0000-4000-8000-000000000001","kind":"handoff"}'
    ;;
  *) exit 9 ;;
esac
MOCK_MEMORY
chmod +x "$TEMP_ROOT/mock-memory"

PROJECT="$(new_project dry-run)"
"$RALPH" --project "$PROJECT" --dry-run > "$TEMP_ROOT/dry-run.out"
assert_contains "$TEMP_ROOT/dry-run.out" $'document-complete\tphase=P01' "dry-run recognizes checked phase"
assert_contains "$TEMP_ROOT/dry-run.out" $'pending\tphase=P02' "dry-run schedules pending phase"
[ ! -d "$PROJECT/.rb/runs" ] || fail "dry-run must not create run state"
ok "dry-run creates no state"

"$RALPH" --project "$PROJECT" --list > "$TEMP_ROOT/list.out"
assert_contains "$TEMP_ROOT/list.out" $'feature-multiple-execution\t.rb/features/example/PHASES.md' "list uses manifest artifact identity"

"$RALPH" --project "$PROJECT" --validation-mode manager --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/run.out"
assert_contains "$TEMP_ROOT/run.out" "P01 skipped" "execution skips a document-complete phase"
assert_contains "$TEMP_ROOT/run.out" "P02 complete" "manager completes pending phase"
assert_eq "1" "$(cat "$MOCK_STATE/agent-count")" "implementation agent ran once"
EVENTS="$(find "$PROJECT/.rb/runs" -name events.tsv -type f -print -quit)"
assert_contains "$EVENTS" $'P02\t1\tCOMPLETE\t' "append-only state records completion"

"$RALPH" --project "$PROJECT" --validation-mode manager --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/resume.out"
assert_contains "$TEMP_ROOT/resume.out" "P02 resumed as complete" "same plan hash resumes accepted phase"
assert_eq "1" "$(cat "$MOCK_STATE/agent-count")" "resume does not spend another agent call"

printf '0\n' > "$MOCK_STATE/agent-count"
RETRY_PROJECT="$(new_project retry-project)"
MOCK_MANAGER_SCENARIO=retry-once "$RALPH" --project "$RETRY_PROJECT" --validation-mode manager --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/retry.out"
assert_contains "$TEMP_ROOT/retry.out" "retry requested" "manager can request a bounded retry"
assert_eq "2" "$(cat "$MOCK_STATE/agent-count")" "retry invokes a fresh implementation attempt"
RETRY_FINDINGS="$(find "$RETRY_PROJECT/.rb/runs" -name findings.tsv -type f -print -quit)"
assert_contains "$RETRY_FINDINGS" $'F-P02-A001\tP02\t1\tresolved\tfocused validation failed\t' \
  "manager findings remain structured until later evidence resolves them"
awk -F '\t' '$1 == "F-P02-A001" && $6 != "" && $7 == "2" && $8 != "" { found=1 } END { exit(found ? 0 : 1) }' \
  "$RETRY_FINDINGS" || fail "finding resolution is not bound to opening and closing evidence fingerprints"
ok "finding resolution is bound to opening and closing evidence fingerprints"
assert_contains "$MOCK_STATE/agent-P02-2.txt" "F-P02-A001 (attempt 1): focused validation failed" \
  "fresh executor receives the cumulative finding ledger"

# Sequential pending tasks are separate fresh provider invocations by default,
# even when bounded parallelism is not enabled.
cat > "$TEMP_ROOT/fresh-task-agent" <<'FRESH_TASK_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > "$MOCK_STATE/fresh-task-${RB_RALPH_TASK_ID:?}.prompt"
printf '%s\n' "$RB_RALPH_TASK_ID" >> "$MOCK_STATE/fresh-task-calls"
mkdir -p src
printf 'implemented\n' > "src/${RB_RALPH_TASK_ID}.txt"
FRESH_TASK_AGENT
cat > "$TEMP_ROOT/fresh-task-manager" <<'FRESH_TASK_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: integrated task evidence accepted'
FRESH_TASK_MANAGER
chmod +x "$TEMP_ROOT/fresh-task-agent" "$TEMP_ROOT/fresh-task-manager"
FRESH_TASK_PROJECT="$(new_project fresh-task-boundary)"
RB_RALPH_EXECUTION_UNIT=task "$RALPH" --project "$FRESH_TASK_PROJECT" --validation-mode manager \
  --agent-cmd "$TEMP_ROOT/fresh-task-agent" --manager-cmd "$TEMP_ROOT/fresh-task-manager" \
  > "$TEMP_ROOT/fresh-task.out"
assert_eq "2" "$(wc -l < "$MOCK_STATE/fresh-task-calls" | tr -d ' ')" \
  "two sequential tasks receive two fresh executor calls"
assert_contains "$MOCK_STATE/fresh-task-calls" 'T002' "first sequential task has its own provider identity"
assert_contains "$MOCK_STATE/fresh-task-calls" 'T003' "second sequential task has its own provider identity"
assert_contains "$MOCK_STATE/fresh-task-T002.prompt" 'Implement only the task below in this fresh execution context' \
  "fresh task prompt uses the bounded task extract as authority"

# An incomplete manager matrix consumes only a manager-completion retry. The
# valid retry returns every observable finding as one batch to the next agent.
cat > "$TEMP_ROOT/exhaustive-agent" <<'EXHAUSTIVE_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > "$MOCK_STATE/exhaustive-agent-${RB_RALPH_ATTEMPT:?}.prompt"
count=0
[ ! -f "$MOCK_STATE/exhaustive-agent.count" ] || count="$(cat "$MOCK_STATE/exhaustive-agent.count")"
count=$((count + 1))
printf '%s\n' "$count" > "$MOCK_STATE/exhaustive-agent.count"
mkdir -p src
printf 'attempt=%s\n' "$RB_RALPH_ATTEMPT" > src/exhaustive.txt
EXHAUSTIVE_AGENT
cat > "$TEMP_ROOT/exhaustive-manager" <<'EXHAUSTIVE_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
count=0
[ ! -f "$MOCK_STATE/exhaustive-manager.count" ] || count="$(cat "$MOCK_STATE/exhaustive-manager.count")"
count=$((count + 1))
printf '%s\n' "$count" > "$MOCK_STATE/exhaustive-manager.count"
if [ "$count" -eq 1 ]; then
  printf '%s\n' \
    'RB_RALPH_AUDIT_STATUS: COMPLETE' \
    'RB_RALPH_CRITERION: T001 | FAIL | source boundary lacks the required behavior' \
    'RB_RALPH_FINDING: T001 | src/exhaustive.txt | task behavior complete | first independent defect | src/exhaustive.txt' \
    'RB_RALPH_DECISION: RETRY' \
    'RB_RALPH_REASON: incomplete first audit response'
elif [ "$count" -eq 2 ]; then
  printf '%s\n' \
    'RB_RALPH_AUDIT_STATUS: COMPLETE' \
    'RB_RALPH_CRITERION: T001 | FAIL | source boundary lacks the required behavior' \
    'RB_RALPH_CRITERION: AC-T001-01 | FAIL | version behavior is not proven' \
    'RB_RALPH_FINDING: T001 | src/exhaustive.txt | task behavior complete | first independent defect | src/exhaustive.txt' \
    'RB_RALPH_FINDING: AC-T001-01 | consumer version boundary | exit zero and version 0.1.0 | second independent defect | canonical consumer probe' \
    'RB_RALPH_DECISION: RETRY' \
    'RB_RALPH_REASON: complete two-finding batch'
else
  printf '%s\n' \
    'RB_RALPH_AUDIT_STATUS: COMPLETE' \
    'RB_RALPH_CRITERION: T001 | PASS | current source and changed-path evidence' \
    'RB_RALPH_CRITERION: AC-T001-01 | PASS | canonical consumer probe passes' \
    'RB_RALPH_DECISION: COMPLETE' \
    'RB_RALPH_REASON: complete matrix accepted'
fi
EXHAUSTIVE_MANAGER
chmod +x "$TEMP_ROOT/exhaustive-agent" "$TEMP_ROOT/exhaustive-manager"
EXHAUSTIVE_PROJECT="$TEMP_ROOT/exhaustive-project"
mkdir -p "$EXHAUSTIVE_PROJECT/.rb/features/example"
node "$CLI" project init "$EXHAUSTIVE_PROJECT" --name exhaustive --id exhaustive >/dev/null
cp "$MINIMAL_FIXTURE" "$EXHAUSTIVE_PROJECT/.rb/features/example/PHASES.md"
node "$CLI" manifest sync "$EXHAUSTIVE_PROJECT" >/dev/null
RB_RALPH_EXECUTION_UNIT=task RB_RALPH_MANAGER_AUDIT_MODE=exhaustive \
  "$RALPH" --project "$EXHAUSTIVE_PROJECT" --validation-mode manager \
  --manager-retries 2 --manager-retry-wait 0 \
  --agent-cmd "$TEMP_ROOT/exhaustive-agent" --manager-cmd "$TEMP_ROOT/exhaustive-manager" \
  > "$TEMP_ROOT/exhaustive.out"
assert_eq "2" "$(cat "$MOCK_STATE/exhaustive-agent.count")" \
  "incomplete audit matrix does not consume an executor repair attempt"
assert_eq "3" "$(cat "$MOCK_STATE/exhaustive-manager.count")" \
  "manager completes the missing matrix over the same evidence before repair"
assert_contains "$MOCK_STATE/exhaustive-agent-2.prompt" 'first independent defect' \
  "next executor receives the first finding in the exhaustive batch"
assert_contains "$MOCK_STATE/exhaustive-agent-2.prompt" 'second independent defect' \
  "next executor receives the second finding in the exhaustive batch"
EXHAUSTIVE_RUN="$(basename "$(find "$EXHAUSTIVE_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
RB_RALPH_WATCH_COLS=118 RB_RALPH_WATCH_LINES=45 \
  "$ROOT/bin/rb-ralph-watch" --project "$EXHAUSTIVE_PROJECT" --run "$EXHAUSTIVE_RUN" \
  --once --no-color > "$TEMP_ROOT/exhaustive-dashboard.out"
assert_contains "$TEMP_ROOT/exhaustive-dashboard.out" 'total=2 open=0 resolved=2' \
  "dashboard exposes cumulative open and resolved finding counts"
if [ "$(find "$EXHAUSTIVE_PROJECT/.rb/runs/$EXHAUSTIVE_RUN/logs" -name '*manager*-audit.json' -type f | wc -l | tr -d ' ')" -lt 3 ]; then
  fail "manager audit completion reports were not preserved for every review call"
fi
ok "manager audit completion reports remain canonical evidence"

printf '0\n' > "$MOCK_STATE/agent-count"
ECHOED_PROTOCOL_PROJECT="$(new_project echoed-protocol-project)"
MOCK_MANAGER_SCENARIO=echoed-protocol "$RALPH" --project "$ECHOED_PROTOCOL_PROJECT" --validation-mode manager --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/echoed-protocol.out"
assert_contains "$TEMP_ROOT/echoed-protocol.out" "P02 complete" "manager parser ignores an echoed protocol template"
assert_eq "1" "$(cat "$MOCK_STATE/agent-count")" "echoed protocol does not consume a retry"

printf '0\n' > "$MOCK_STATE/agent-count"
printf '0\n' > "$MOCK_STATE/validation-count"
VALIDATION_PROJECT="$(new_project validation-project)"
sed -i 's#npm test -- a#./validate.sh#; s#npm test -- b#./validate.sh#' "$VALIDATION_PROJECT/.rb/features/example/PHASES.md"
cat > "$VALIDATION_PROJECT/validate.sh" <<'VALIDATE'
#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$MOCK_STATE/validation-count")"
count=$((count + 1))
printf '%s\n' "$count" > "$MOCK_STATE/validation-count"
if [ "$count" -eq 1 ]; then
  printf 'focused validation failed once\n' >&2
  exit 1
fi
printf 'focused validation passed\n'
VALIDATE
chmod +x "$VALIDATION_PROJECT/validate.sh"
node "$CLI" manifest sync "$VALIDATION_PROJECT" >/dev/null
"$RALPH" --project "$VALIDATION_PROJECT" --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/validation.out"
assert_contains "$TEMP_ROOT/validation.out" "deterministic validation failed" "failed command overrides an optimistic manager"
assert_eq "2" "$(cat "$MOCK_STATE/agent-count")" "deterministic failure triggers another agent attempt"
assert_contains "$MOCK_STATE/agent-P02-2.txt" "PREVIOUS_MANAGER_FEEDBACK" "retry prompt carries evidence from prior attempt"
VALIDATION_LOG="$(find "$VALIDATION_PROJECT/.rb/runs" -name '*validation.log' -type f | sort | head -n 1)"
assert_contains "$VALIDATION_LOG" "exit=1" "validation command output and exit code are persisted"

BLOCKED_PROJECT="$(new_project blocked-project)"
if MOCK_MANAGER_SCENARIO=blocked "$RALPH" --project "$BLOCKED_PROJECT" --validation-mode manager --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/blocked.out" 2>&1; then
  fail "blocked manager decision must stop the run"
fi
assert_contains "$TEMP_ROOT/blocked.out" "blocked by manager" "blocked decision fails closed"

MULTIPLE_PROJECT="$(new_project multiple-project)"
cp "$MINIMAL_FIXTURE" "$MULTIPLE_PROJECT/.rb/init/PHASES.md"
node "$CLI" manifest sync "$MULTIPLE_PROJECT" >/dev/null
if "$RALPH" --project "$MULTIPLE_PROJECT" --dry-run > "$TEMP_ROOT/multiple.out" 2>&1; then
  fail "multiple plans without --plan must be rejected"
fi
assert_contains "$TEMP_ROOT/multiple.out" "Multiple ready plans found" "multiple plans require explicit selection"
"$RALPH" --project "$MULTIPLE_PROJECT" --plan init-minimal-execution --dry-run > "$TEMP_ROOT/selected.out"
assert_contains "$TEMP_ROOT/selected.out" "plan=init-minimal-execution" "plan selection accepts artifact ID"

printf '0\n' > "$MOCK_STATE/agent-count"
PROVIDER_PROJECT="$(new_project provider-project)"
RB_RALPH_CLAUDE_BIN="$TEMP_ROOT/mock-agent" \
RB_RALPH_CODEX_BIN="$TEMP_ROOT/mock-manager" \
  "$RALPH" --project "$PROVIDER_PROJECT" --validation-mode manager \
    --agent-provider claude --manager-provider codex > "$TEMP_ROOT/providers.out"
assert_contains "$TEMP_ROOT/providers.out" "P02 complete" "built-in provider selectors support mixed LLM roles"
assert_eq "1" "$(cat "$MOCK_STATE/agent-count")" "mixed provider selection invokes the implementation adapter"

UNISOLATED_PROJECT="$(new_project unisolated-parallel-project)"
if "$RALPH" --project "$UNISOLATED_PROJECT" --validation-mode manager --parallel 2 \
  --agent-cmd "$TEMP_ROOT/parallel-agent" --manager-cmd "$TEMP_ROOT/mock-manager" \
  > "$TEMP_ROOT/unisolated-parallel.out" 2>&1; then
  fail "parallel execution without worktree isolation must fail closed"
fi
assert_contains "$TEMP_ROOT/unisolated-parallel.out" "requires --isolation worktree" "parallel agents cannot share one working tree"

PARALLEL_PROJECT="$(new_git_project parallel-project)"
"$RALPH" --project "$PARALLEL_PROJECT" --validation-mode manager --parallel 2 --isolation worktree \
  --agent-cmd "$TEMP_ROOT/parallel-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/parallel.out"
assert_contains "$TEMP_ROOT/parallel.out" "2 independent task agents" "parallel-safe independent tasks use separate agents"
[ -f "$MOCK_STATE/parallel-T002" ] && [ -f "$MOCK_STATE/parallel-T003" ] || fail "task agents did not overlap"
ok "parallel task agents overlap in execution"
assert_contains "$MOCK_STATE/parallel-prompt-T002.txt" "T002 — Implement consumer A" "parallel agent receives its own task"
if grep -Fq "T003 — Implement consumer B" "$MOCK_STATE/parallel-prompt-T002.txt"; then
  fail "parallel task prompt contains a sibling task"
fi
ok "parallel task prompt excludes sibling work"

printf '0\n' > "$MOCK_STATE/agent-count"
SEQUENTIAL_PROJECT="$(new_project sequential-fallback)"
sed -i '0,/Parallel safe:\*\* true/s//Parallel safe:** false/' "$SEQUENTIAL_PROJECT/.rb/features/example/PHASES.md"
node "$CLI" manifest sync "$SEQUENTIAL_PROJECT" >/dev/null
"$RALPH" --project "$SEQUENTIAL_PROJECT" --validation-mode manager --parallel 2 \
  --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/sequential.out"
assert_contains "$TEMP_ROOT/sequential.out" "sequential phase agent" "unsafe task forces conservative sequential fallback"
assert_eq "1" "$(cat "$MOCK_STATE/agent-count")" "sequential fallback uses one implementation agent"

ISOLATED_PROJECT="$(new_git_project isolated-project)"
"$RALPH" --project "$ISOLATED_PROJECT" --validation-mode manager --parallel 2 --isolation worktree \
  --agent-cmd "$TEMP_ROOT/isolated-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/isolated.out"
assert_contains "$TEMP_ROOT/isolated.out" "isolation snapshot=" "worktree mode creates an immutable execution snapshot"
assert_contains "$TEMP_ROOT/isolated.out" "isolated task patches integrated" "isolated patches pass integration before main tree application"
[ -f "$ISOLATED_PROJECT/src/T002.txt" ] && [ -f "$ISOLATED_PROJECT/src/T003.txt" ] || fail "isolated task patches were not applied"
ok "disjoint task patches are applied to the primary working tree"
assert_eq "local-change" "$(cat "$ISOLATED_PROJECT/base.txt")" "tracked local changes survive snapshot and integration"
assert_eq "untracked-context" "$(cat "$ISOLATED_PROJECT/local.txt")" "untracked local context survives snapshot and integration"
ISOLATION_PATCH="$(find "$ISOLATED_PROJECT/.rb/runs" -name combined.patch -type f -print -quit)"
[ -s "$ISOLATION_PATCH" ] || fail "combined isolation patch was not persisted"
ok "combined worktree patch is retained as run evidence"
WORKTREE_COUNT="$(git -C "$ISOLATED_PROJECT" worktree list --porcelain | grep -c '^worktree ')"
assert_eq "1" "$WORKTREE_COUNT" "temporary worktrees are removed after integration"

CONFLICT_PROJECT="$(new_git_project conflict-project)"
if ISOLATED_AGENT_SCENARIO=conflict MOCK_MANAGER_SCENARIO=always-complete \
  "$RALPH" --project "$CONFLICT_PROJECT" \
  --validation-mode manager --parallel 2 --isolation worktree --max-attempts 1 --max-total-attempts 1 \
  --agent-cmd "$TEMP_ROOT/isolated-agent" --manager-cmd "$TEMP_ROOT/mock-manager" \
  > "$TEMP_ROOT/conflict.out" 2>&1; then
  fail "conflicting isolated task patches must fail closed"
fi
[ ! -e "$CONFLICT_PROJECT/src/shared.txt" ] || fail "conflicting patches partially changed the primary tree"
ok "conflicting task patches leave the primary tree unchanged"
assert_contains "$TEMP_ROOT/conflict.out" "patch integration failed; primary working tree unchanged" "integration failure is reported accurately"
assert_contains "$TEMP_ROOT/conflict.out" "retry requested: implementation agent or isolated integration exited with 1" "optimistic manager cannot override integration failure"
CONFLICT_PATCHES="$(find "$CONFLICT_PROJECT/.rb/runs" -name 'T*.patch' -type f | wc -l)"
assert_eq "2" "$CONFLICT_PATCHES" "conflicting task patches remain available as run evidence"
CONFLICT_WORKTREES="$(git -C "$CONFLICT_PROJECT" worktree list --porcelain | grep -c '^worktree ')"
assert_eq "1" "$CONFLICT_WORKTREES" "temporary worktrees are cleaned after integration conflict"

OVERLAP_PROJECT="$(new_git_project overlap-project)"
if ISOLATED_AGENT_SCENARIO=overlap MOCK_MANAGER_SCENARIO=always-complete \
  "$RALPH" --project "$OVERLAP_PROJECT" \
  --validation-mode manager --parallel 2 --isolation worktree --max-attempts 1 --max-total-attempts 1 \
  --agent-cmd "$TEMP_ROOT/isolated-agent" --manager-cmd "$TEMP_ROOT/mock-manager" \
  > "$TEMP_ROOT/overlap.out" 2>&1; then
  fail "parallel patches touching one path must fail even when their hunks do not conflict"
fi
assert_eq $'left=base\nright=base' "$(cat "$OVERLAP_PROJECT/src/shared-scope.txt")" "same-path parallel patches leave the primary tree unchanged"
OVERLAP_LOG="$(find "$OVERLAP_PROJECT/.rb/runs" -name 'P02-attempt-1-agent.log' -type f -print -quit)"
assert_contains "$OVERLAP_LOG" "parallel path overlap is prohibited" "same-path parallel work is rejected before integration"

printf '0\n' > "$MOCK_STATE/agent-count"
MEMORY_PROJECT="$(new_project memory-project)"
RB_MEMORY_TEST_TOKEN="test-token" "$RALPH" --project "$MEMORY_PROJECT" --validation-mode manager \
  --memory-url "http://127.0.0.1:8787/mcp" --memory-token-env RB_MEMORY_TEST_TOKEN \
  --memory-cli "$TEMP_ROOT/mock-memory" \
  --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/memory.out"
assert_contains "$TEMP_ROOT/memory.out" "memory context loaded for project=memory-project" "Ralph bootstraps memory using the stable manifest project ID"
assert_contains "$MOCK_STATE/agent-P02-1.txt" "ADVISORY LONG-TERM MEMORY" "Ralph injects bounded memory as advisory context"
assert_contains "$MOCK_STATE/agent-P02-1.txt" "Keep provider neutrality" "implementation agent receives retrieved memory content"
assert_contains "$TEMP_ROOT/memory.out" "checkpoint stored in RB Memory" "Ralph checkpoints an accepted phase through MCP client CLI"
assert_contains "$MOCK_STATE/checkpoint.json" '"projectId":"memory-project"' "Ralph checkpoint retains stable project identity"
assert_contains "$MOCK_STATE/checkpoint.json" '"actor":"rb-ralph"' "Ralph checkpoint records executor provenance"

printf '0\n' > "$MOCK_STATE/agent-count"
RATE_PROJECT="$(new_project rate-project)"
MOCK_AGENT_RATE_LIMIT_ONCE=1 "$RALPH" --project "$RATE_PROJECT" --validation-mode manager \
  --rate-limit-wait 0 --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/rate.out"
assert_contains "$TEMP_ROOT/rate.out" "without consuming attempt 1" "rate limit repeats the same logical attempt"
assert_eq "2" "$(cat "$MOCK_STATE/agent-count")" "agent is reinvoked after provider availability wait"
RATE_EVENTS="$(find "$RATE_PROJECT/.rb/runs" -name events.tsv -type f -print -quit)"
assert_contains "$RATE_EVENTS" $'P02\t1\tRATE_LIMIT\t' "rate-limit wait is recorded in append-only state"
assert_contains "$RATE_EVENTS" $'P02\t1\tCOMPLETE\t' "completion retains the original attempt number"

printf '0\n' > "$MOCK_STATE/agent-count"
BUDGET_PROJECT="$(new_project budget-project)"
if "$RALPH" --project "$BUDGET_PROJECT" --validation-mode manager --max-prompt-bytes 10 \
  --agent-cmd "$TEMP_ROOT/mock-agent" --manager-cmd "$TEMP_ROOT/mock-manager" > "$TEMP_ROOT/budget.out" 2>&1; then
  fail "oversized prompt must fail before provider execution"
fi
assert_contains "$TEMP_ROOT/budget.out" "exceeding --max-prompt-bytes=10" "prompt budget fails closed"
assert_eq "0" "$(cat "$MOCK_STATE/agent-count")" "prompt budget rejection spends no agent call"

STALE_PROJECT="$(new_project stale-project)"
printf '\nchanged after manifest sync\n' >> "$STALE_PROJECT/.rb/features/example/PHASES.md"
if "$RALPH" --project "$STALE_PROJECT" --dry-run > "$TEMP_ROOT/stale.out" 2>&1; then
  fail "stale execution plan must be rejected"
fi
assert_contains "$TEMP_ROOT/stale.out" "Artifact discovery failed" "stale tree stops before provider execution"

printf '1..%s\n' "$PASS"
