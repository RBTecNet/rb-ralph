#!/usr/bin/env bash
# --manager-review: how deeply the technical manager judges a phase.
#
# `delivery` (default) asks one question — did the executor deliver what the
# fragment asked for? — and accepts when it did. `code` additionally audits the
# changed source for defects the criteria did not name.
#
# The scope narrows judgment only. A deterministic gate still overrides any
# optimistic COMPLETE, and that conversion lives in the orchestrator rather than
# in the prompt, so no review scope can approve past it.
set -euo pipefail
export RB_RALPH_CUSTOM_MANAGER_CAPABILITY=observational-v1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RALPH="$ROOT/bin/rb-ralph"
CLI="$ROOT/core/rb-harness.cjs"
FIXTURE="$ROOT/tests/fixtures/execution/valid/multiple/PHASES.md"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rb-ralph-manager-review.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT
export MOCK_STATE="$TEMP_ROOT/state"
mkdir -p "$MOCK_STATE"
failures=0

check() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" "$haystack"; then printf 'PASS %s\n' "$label"
  else printf 'FAIL %s (missing: %s)\n' "$label" "$needle"; failures=$((failures + 1)); fi
}
refute() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" "$haystack"; then printf 'FAIL %s (unexpected: %s)\n' "$label" "$needle"; failures=$((failures + 1))
  else printf 'PASS %s\n' "$label"; fi
}
expect_exit() {
  local label="$1" expected="$2"; shift 2
  local actual=0
  "$@" >/dev/null 2>&1 || actual=$?
  if [ "$actual" = "$expected" ]; then printf 'PASS %s\n' "$label"
  else printf 'FAIL %s (exit %s, expected %s)\n' "$label" "$actual" "$expected"; failures=$((failures + 1)); fi
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

cat > "$TEMP_ROOT/agent" <<'AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
case "${RB_RALPH_TASK_ID:-phase}" in
  T002) mkdir -p src/a && printf 'done\n' > src/a/result.txt ;;
  T003) mkdir -p src/b && printf 'done\n' > src/b/result.txt ;;
  *) mkdir -p src && printf 'done\n' > src/phase.txt ;;
esac
printf 'RB_RALPH_EXECUTOR_STATUS: COMPLETE\n'
AGENT
cat > "$TEMP_ROOT/manager" <<'MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > "$MOCK_STATE/manager-${RB_RALPH_PHASE_ID}.txt"
printf '%s\n' 'RB_RALPH_AUDIT_STATUS: COMPLETE'
for id in T002 AC-T002-01 T003 AC-T003-01; do
  printf 'RB_RALPH_CRITERION: %s | PASS | evidenced in current source\n' "$id"
done
printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: delivered'
MANAGER
chmod +x "$TEMP_ROOT/agent" "$TEMP_ROOT/manager"

run_ralph() {
  local project="$1"; shift
  RB_RALPH_EXECUTION_UNIT=task "$RALPH" --project "$project" --validation-mode manager --no-final-audit \
    --agent-cmd "$TEMP_ROOT/agent" --manager-cmd "$TEMP_ROOT/manager" "$@" >/dev/null 2>&1 || true
}

# --- default scope -----------------------------------------------------------
run_ralph "$(new_project default-scope)"
PROMPT="$MOCK_STATE/manager-P02.txt"
check "delivery is the default scope" "$PROMPT" "REVIEW_SCOPE: delivery"
check "delivery states the single question it asks" "$PROMPT" "Did the executor deliver what this fragment asked for?"
check "delivery accepts an evidenced criterion" "$PROMPT" "whose observable outcome is evidenced is PASS"
check "delivery refuses to gate on unrequested concerns" "$PROMPT" "Do not withhold PASS for style, naming, structure"
check "delivery keeps out-of-scope defects out of findings" "$PROMPT" "Do not open findings for defects outside the declared criteria"
check "delivery says the deterministic gates still bind" "$PROMPT" "never approves past a deterministic gate"
refute "delivery does not ask for unnamed defects" "$PROMPT" "including independent defects in criteria this phase did not name"

# --- opt-in code scope -------------------------------------------------------
run_ralph "$(new_project code-scope)" --manager-review code
check "code scope is announced to the manager" "$PROMPT" "REVIEW_SCOPE: code"
check "code scope audits the changed source itself" "$PROMPT" "then audit the changed source itself"
check "code scope asks for defects the criteria did not name" "$PROMPT" "including independent defects in criteria this phase did not name"
check "code scope refuses a criterion satisfied by defective code" "$PROMPT" "technically satisfied by defective code is not PASS"
refute "code scope drops the delivery-only narrowing" "$PROMPT" "Do not open findings for defects outside the declared criteria"

# --- both scopes keep the shared protocol ------------------------------------
check "the audit matrix protocol is unchanged" "$PROMPT" "RB_RALPH_CRITERION:"
check "the decision protocol is unchanged" "$PROMPT" "RB_RALPH_DECISION: COMPLETE | RETRY | BLOCKED"

# --- input validation --------------------------------------------------------
PROJECT="$(new_project rejects-unknown)"
expect_exit "an unknown scope is rejected before any provider runs" 1 \
  "$RALPH" --project "$PROJECT" --manager-review thorough \
  --agent-cmd "$TEMP_ROOT/agent" --manager-cmd "$TEMP_ROOT/manager"
expect_exit "a missing value is rejected" 1 \
  "$RALPH" --project "$PROJECT" --manager-review

# --- the environment variable and profiles -----------------------------------
RB_RALPH_MANAGER_REVIEW=code run_ralph "$(new_project env-scope)"
check "RB_RALPH_MANAGER_REVIEW selects the scope" "$PROMPT" "REVIEW_SCOPE: code"

for pair in "balanced:delivery" "fast:delivery" "strict:code"; do
  name="${pair%%:*}"; want="${pair##*:}"
  got="$(grep -A 8 "^  $name: {" "$ROOT/lib/profiles.cjs" | grep -oP 'managerReview: "\K[a-z]+' | head -1)"
  if [ "$got" = "$want" ]; then printf 'PASS profile %s declares managerReview %s\n' "$name" "$want"
  else printf 'FAIL profile %s declares %s, expected %s\n' "$name" "${got:-none}" "$want"; failures=$((failures + 1)); fi
done

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'test-manager-review: all checks passed\n'
else
  printf 'test-manager-review: %s check(s) failed\n' "$failures"
  exit 1
fi
