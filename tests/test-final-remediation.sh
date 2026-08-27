#!/usr/bin/env bash
set -euo pipefail
export RB_RALPH_CUSTOM_MANAGER_CAPABILITY=observational-v1
export RB_RALPH_MANAGER_AUDIT_MODE=legacy

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RALPH="$ROOT/bin/rb-ralph"
CORE="$ROOT/core/rb-harness.cjs"
COMPLETION="$ROOT/lib/executor-completion.cjs"
IDENTITY="$ROOT/lib/release-identity.cjs"
MULTIPLE="$ROOT/tests/fixtures/execution/valid/multiple/PHASES.md"
MINIMAL="$ROOT/tests/fixtures/execution/valid/minimal/PHASES.md"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_ROOT"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); printf 'ok %s - %s\n' "$PASS" "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "$3"; ok "$3"; }
assert_not_contains() { ! grep -Fq -- "$2" "$1" || fail "$3"; ok "$3"; }

new_project() {
  local name="$1" fixture="$2" project
  project="$TEMP_ROOT/$name"
  mkdir -p "$project/.rb/features/test"
  node "$CORE" project init "$project" --name "$name" --id "$name" >/dev/null
  cp "$fixture" "$project/.rb/features/test/PHASES.md"
  node "$CORE" manifest sync "$project" >/dev/null
  printf '%s\n' "$project"
}

completion_result() {
  node -e 'const r=require(process.argv[1]);process.stdout.write(r.status)' "$1"
}

# TEST-FINAL-003/004/005: completion uses a terminal structured result for
# every adapter category. Legacy/incidental text is not sufficient.
printf '%s\n' 'ordinary provider output' > "$TEMP_ROOT/builtin-empty.log"
node "$COMPLETION" classify "$TEMP_ROOT/builtin-empty.log" 0 0 "$TEMP_ROOT/builtin-empty.json"
printf '%s\n' 'ordinary provider output' > "$TEMP_ROOT/custom-empty.log"
node "$COMPLETION" classify "$TEMP_ROOT/custom-empty.log" 0 0 "$TEMP_ROOT/custom-empty.json"
[ "$(completion_result "$TEMP_ROOT/builtin-empty.json")" = incomplete ] || fail "built-in empty result completed"
[ "$(completion_result "$TEMP_ROOT/custom-empty.json")" = incomplete ] || fail "custom empty result completed"
ok "built-in and custom clean empty turns are uniformly incomplete"
cat > "$TEMP_ROOT/mock-codex-complete" <<'CODEX'
#!/usr/bin/env bash
cat > /dev/null
printf '%s\n' 'RB_RALPH_EXECUTOR_RESULT: {"contract":"rb-ralph-executor-completion/v1","status":"completed"}'
CODEX
chmod +x "$TEMP_ROOT/mock-codex-complete"
RB_RALPH_ROLE=agent RB_RALPH_PROJECT_ROOT="$TEMP_ROOT" RB_RALPH_CODEX_BIN="$TEMP_ROOT/mock-codex-complete" \
  "$ROOT/adapters/codex.sh" < /dev/null > "$TEMP_ROOT/builtin-completed.log"
node "$COMPLETION" classify "$TEMP_ROOT/builtin-completed.log" 0 0 "$TEMP_ROOT/builtin-completed.json"
[ "$(completion_result "$TEMP_ROOT/builtin-completed.json")" = completed ] || fail "built-in structured completion was rejected"
ok "built-in adapter completion uses the same canonical parser"
printf '%s\n' 'RB_RALPH_EXECUTOR_RESULT: {"contract":"rb-ralph-executor-completion/v1","status":"completed"}' > "$TEMP_ROOT/completed.log"
node "$COMPLETION" classify "$TEMP_ROOT/completed.log" 0 0 "$TEMP_ROOT/completed.json"
[ "$(completion_result "$TEMP_ROOT/completed.json")" = completed ] || fail "structured completion was rejected"
ok "terminal structured executor completion is accepted as a G0 result"
printf '%s\n' 'RB_RALPH_EXECUTOR_STATUS: COMPLETE' 'ordinary trailing provider message' > "$TEMP_ROOT/ambiguous.log"
node "$COMPLETION" classify "$TEMP_ROOT/ambiguous.log" 0 0 "$TEMP_ROOT/ambiguous.json"
[ "$(completion_result "$TEMP_ROOT/ambiguous.json")" = incomplete ] || fail "incidental legacy marker completed"
ok "incidental legacy completion marker is not canonical"

# TEST-FINAL-006: the package relationship rejects a version mismatch and
# labels the older consolidated snapshot as historical rather than current.
node "$IDENTITY" "$ROOT/VERSION" "$ROOT/RB-RALPH-CONTRACT-IDENTITY.json" >/dev/null
cp "$ROOT/RB-RALPH-CONTRACT-IDENTITY.json" "$TEMP_ROOT/identity.json"
sed -i 's/"1.0.0"/"0.0.0"/' "$TEMP_ROOT/identity.json"
if node "$IDENTITY" "$ROOT/VERSION" "$TEMP_ROOT/identity.json" >/dev/null 2>&1; then fail "release identity accepted a mismatched runtime"; fi
ok "runtime and packaged contract identity metadata must agree"

cat > "$TEMP_ROOT/parallel-agent" <<'AGENT'
#!/usr/bin/env bash
set -euo pipefail
case "$RB_RALPH_TASK_ID" in
  T002) mkdir -p src/a; printf 'interface=%s\n' "${PARALLEL_INTERFACE:-v2}" > src/a/interface.txt ;;
  T003) mkdir -p src/b; printf 'consumer=%s\n' "${PARALLEL_CONSUMER:-v1}" > src/b/consumer.txt ;;
esac
printf '%s\n' 'RB_RALPH_EXECUTOR_RESULT: {"contract":"rb-ralph-executor-completion/v1","status":"completed"}'
AGENT
cat > "$TEMP_ROOT/complete-manager" <<'MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: manager reviewed combined evidence'
MANAGER
chmod +x "$TEMP_ROOT/parallel-agent" "$TEMP_ROOT/complete-manager"

parallel_project() {
  local name="$1" project
  project="$(new_project "$name" "$MULTIPLE")"
  sed -i -e 's/- \[ \] T001/- [x] T001/' \
    -e 's#`npm test -- a`#`bash tests/combined.sh`#' \
    -e 's#`npm test -- b`#`bash tests/combined.sh`#' \
    "$project/.rb/features/test/PHASES.md"
  mkdir -p "$project/tests"
  cat > "$project/tests/combined.sh" <<'CHECK'
#!/usr/bin/env bash
set -euo pipefail
[ "$(cut -d= -f2 src/a/interface.txt)" = "$(cut -d= -f2 src/b/consumer.txt)" ]
CHECK
  chmod +x "$project/tests/combined.sh"
  node "$CORE" manifest sync "$project" >/dev/null
  git -C "$project" init -q
  git -C "$project" config user.name "RB Final Test"
  git -C "$project" config user.email "rb-final@test.invalid"
  git -C "$project" add . && git -C "$project" commit -qm fixture
  printf '%s\n' "$project"
}

# TEST-FINAL-001: different paths integrate but the combined command fails.
BAD_PROJECT="$(parallel_project parallel-combined-fail)"
if PARALLEL_INTERFACE=v2 PARALLEL_CONSUMER=v1 RB_RALPH_FINAL_AUDIT=0 \
  "$RALPH" --project "$BAD_PROJECT" --parallel 2 --isolation worktree --validation-mode run \
  --max-total-attempts 1 --agent-cmd "$TEMP_ROOT/parallel-agent" --manager-cmd "$TEMP_ROOT/complete-manager" \
  > "$TEMP_ROOT/parallel-fail.out" 2>&1; then fail "invalid integrated parallel state completed"; fi
BAD_RUN="$(find "$BAD_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)"
assert_contains "$BAD_RUN/logs/P02-attempt-1-validation.log" 'impact=full reason=parallel patches were integrated' "parallel integration forces full combined validation"
assert_contains "$BAD_RUN/logs/P02-attempt-1-validation.log" 'exit=1' "invalid combined behavior fails deterministic validation"
assert_not_contains "$BAD_RUN/events.tsv" $'P02\t1\tCOMPLETE\t' "parallel isolated success cannot independently complete an invalid integrated state"

# TEST-FINAL-002: compatible different-path patches retain parallelism and pass.
GOOD_PROJECT="$(parallel_project parallel-combined-pass)"
PARALLEL_INTERFACE=v2 PARALLEL_CONSUMER=v2 RB_RALPH_FINAL_AUDIT=0 \
  "$RALPH" --project "$GOOD_PROJECT" --parallel 2 --isolation worktree --validation-mode run \
  --agent-cmd "$TEMP_ROOT/parallel-agent" --manager-cmd "$TEMP_ROOT/complete-manager" > "$TEMP_ROOT/parallel-pass.out"
GOOD_RUN="$(find "$GOOD_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)"
assert_contains "$GOOD_RUN/events.tsv" $'P02\t1\tCOMPLETE\t' "compatible parallel patches complete after combined validation"
assert_contains "$GOOD_RUN/logs/P02-attempt-1-validation.log" 'impact=full reason=parallel patches were integrated' "combined-state proof is retained with the accepted phase"

# TEST-FINAL-007/008/009: provider submission remains untrusted and known
# synthetic secrets are redacted while ordinary diagnostics remain available.
SECRET='rb-final-synthetic-secret-9d61f2'
EVIDENCE_PROJECT="$(new_project evidence-provenance "$MINIMAL")"
mkdir -p "$EVIDENCE_PROJECT/tests"
cat > "$EVIDENCE_PROJECT/tests/validate.sh" <<'VALIDATE'
#!/usr/bin/env bash
printf 'ordinary validation diagnostic\n'
printf '%s\n' "$RB_FINAL_SECRET"
VALIDATE
chmod +x "$EVIDENCE_PROJECT/tests/validate.sh"
sed -i 's#`npm test`#`bash tests/validate.sh`#' "$EVIDENCE_PROJECT/.rb/features/test/PHASES.md"
node "$CORE" manifest sync "$EVIDENCE_PROJECT" >/dev/null
cat > "$TEMP_ROOT/evidence-agent" <<'EVIDENCE_AGENT'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p src
printf 'implementation\n' > src/foundation.txt
printf 'ordinary executor diagnostic\n%s\n' "$RB_FINAL_SECRET"
printf 'provider evidence %s\n' "$RB_FINAL_SECRET" > "$RB_RALPH_AGENT_EVIDENCE_DIR/provider.txt"
printf '%s\n' 'RB_RALPH_EXECUTOR_RESULT: {"contract":"rb-ralph-executor-completion/v1","status":"completed"}'
EVIDENCE_AGENT
chmod +x "$TEMP_ROOT/evidence-agent"
RB_FINAL_SECRET="$SECRET" RB_RALPH_EVIDENCE_ENV=RB_FINAL_SECRET RB_RALPH_FINAL_AUDIT=0 \
  "$RALPH" --project "$EVIDENCE_PROJECT" --validation-mode run \
  --agent-cmd "$TEMP_ROOT/evidence-agent" --manager-cmd "$TEMP_ROOT/complete-manager" > "$TEMP_ROOT/evidence.out"
EVIDENCE_RUN="$(find "$EVIDENCE_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)"
PROVIDER_SUBMISSION="$(find "$EVIDENCE_RUN/evidence" -path '*agent-submission/provider.txt' -print -quit)"
PROVIDER_PROVENANCE="${PROVIDER_SUBMISSION%/*}-provenance.json"
assert_contains "$PROVIDER_PROVENANCE" 'provider-submitted' "provider evidence has explicit provider provenance"
assert_contains "$PROVIDER_PROVENANCE" 'untrusted' "provider evidence cannot impersonate deterministic proof"
assert_not_contains "$EVIDENCE_RUN/logs/P01-attempt-1-agent.log" "$SECRET" "known secret is redacted from executor output"
assert_not_contains "$EVIDENCE_RUN/logs/P01-attempt-1-validation.log" "$SECRET" "known secret is redacted from validation output"
assert_not_contains "$PROVIDER_SUBMISSION" "$SECRET" "known secret is redacted from provider submission"
assert_contains "$EVIDENCE_RUN/logs/P01-attempt-1-validation.log" 'ordinary validation diagnostic' "ordinary validation diagnostics survive redaction"
assert_contains "$EVIDENCE_RUN/logs/P01-attempt-1-agent.log" 'ordinary executor diagnostic' "ordinary executor diagnostics survive redaction"

printf '1..%s\n' "$PASS"
