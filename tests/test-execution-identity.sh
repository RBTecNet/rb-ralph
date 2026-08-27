#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RALPH="$ROOT/bin/rb-ralph"
CORE="$ROOT/core/rb-harness.cjs"
IDENTITY="$ROOT/lib/execution-identity.cjs"
VERIFY="$ROOT/lib/operational-verifier.cjs"
FIXTURE="$ROOT/tests/fixtures/execution/valid/minimal/PHASES.md"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); printf 'ok %s - %s\n' "$PASS" "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
expect_failure() {
  local description="${!#}"
  set -- "${@:1:$#-1}"
  "$@" >/dev/null 2>&1 && fail "$description" || ok "$description"
}

# TEST-RUN-004 / residual RALPH-AUDIT-006: a bounded named value changes the
# deterministic identity without storing its raw value.
RB_BATCH3_MODE=one node "$IDENTITY" external "$TEMP_ROOT/a.json" test-v RB_BATCH3_MODE bash > "$TEMP_ROOT/a.digest"
RB_BATCH3_MODE=two node "$IDENTITY" external "$TEMP_ROOT/b.json" test-v RB_BATCH3_MODE bash > "$TEMP_ROOT/b.digest"
[ "$(cat "$TEMP_ROOT/a.digest")" != "$(cat "$TEMP_ROOT/b.digest")" ] || fail "external identity ignored named environment change"
! grep -Fq 'one' "$TEMP_ROOT/a.json" || fail "external identity persisted a raw environment value"
ok "TEST-RUN-004 hashes explicit material environment values without exposing them"

# TEST-OPS-001: unknown schema keys historically passed Ralph's local parser.
cat > "$TEMP_ROOT/invalid-operations.json" <<'JSON'
{"contract":"rb-operational/v1","unknown":true,"scenarios":[{"id":"x","title":"x","steps":[{"id":"x","kind":"file","path":"package.json"}]}]}
JSON
expect_failure node "$CORE" operations validate "$TEMP_ROOT/invalid-operations.json" "canonical validator rejects invalid operations"
expect_failure node "$VERIFY" validate "$TEMP_ROOT/invalid-operations.json" "TEST-OPS-001 operational verifier uses canonical rb-operational/v1 validation"

# TEST-OPS-002: copied dependencies cannot make an undeclared setup pass.
PROJECT="$TEMP_ROOT/clean-room"
mkdir -p "$PROJECT/node_modules/local-only"
printf 'module.exports=true;\n' > "$PROJECT/node_modules/local-only/index.js"
printf 'require("local-only");\n' > "$PROJECT/check.js"
printf '{"name":"clean-room"}\n' > "$PROJECT/package.json"
cat > "$TEMP_ROOT/clean-room-operations.json" <<'JSON'
{"contract":"rb-operational/v1","scenarios":[{"id":"clean","title":"clean","steps":[{"id":"run","kind":"command","command":{"argv":["node","check.js"]}}]}]}
JSON
expect_failure node "$VERIFY" run "$TEMP_ROOT/clean-room-operations.json" "$PROJECT" "TEST-OPS-002 clean room excludes inherited dependency directories"

# TEST-PERM-001: a manager cannot silently use a custom command without a
# declared observational capability contract.
mkdir -p "$PROJECT/.rb/init"
node "$CORE" project init "$PROJECT" --name clean --id clean >/dev/null
cp "$FIXTURE" "$PROJECT/.rb/init/PHASES.md"
node "$CORE" manifest sync "$PROJECT" >/dev/null
cat > "$TEMP_ROOT/agent" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
mkdir -p src tests
printf 'module.exports="0.1.0"\n' > src/a.js
printf '%s\n' 'RB_RALPH_EXECUTOR_RESULT: {"contract":"rb-ralph-executor-completion/v1","status":"completed"}'
EOF
cat > "$TEMP_ROOT/manager" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf 'RB_RALPH_DECISION: COMPLETE\nRB_RALPH_REASON: accepted\n'
EOF
chmod +x "$TEMP_ROOT/agent" "$TEMP_ROOT/manager"
expect_failure env -u RB_RALPH_CUSTOM_MANAGER_CAPABILITY RB_RALPH_FINAL_AUDIT=0 "$RALPH" --project "$PROJECT" --agent-cmd "$TEMP_ROOT/agent" --manager-cmd "$TEMP_ROOT/manager" "TEST-PERM-001 unsupported custom protected manager fails closed"

# TEST-RUN-001/002/003/004: completed phase evidence is reusable only while
# both sealed product state and bounded execution identity still match.
RESUME_PROJECT="$TEMP_ROOT/resume"
mkdir -p "$RESUME_PROJECT/.rb/init"
node "$CORE" project init "$RESUME_PROJECT" --name resume --id resume >/dev/null
cp "$FIXTURE" "$RESUME_PROJECT/.rb/init/PHASES.md"
printf '# context one\n' > "$RESUME_PROJECT/.rb/init/PROJECT.md"
printf '# plan\n' > "$RESUME_PROJECT/.rb/init/PLAN.md"
mkdir -p "$RESUME_PROJECT/src" "$RESUME_PROJECT/tests"
printf '{"scripts":{"test":"true"}}\n' > "$RESUME_PROJECT/package.json"
node "$CORE" manifest sync "$RESUME_PROJECT" >/dev/null
cat > "$TEMP_ROOT/resume-agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
n=0; [ ! -f "$TEST_RESUME_COUNT" ] || n="$(cat "$TEST_RESUME_COUNT")"; n=$((n+1)); printf '%s\n' "$n" > "$TEST_RESUME_COUNT"
mkdir -p src tests
printf 'stable\n' > src/product.txt
printf '%s\n' 'RB_RALPH_EXECUTOR_RESULT: {"contract":"rb-ralph-executor-completion/v1","status":"completed"}'
EOF
cat > "$TEMP_ROOT/resume-manager" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf 'RB_RALPH_DECISION: COMPLETE\nRB_RALPH_REASON: accepted\n'
EOF
chmod +x "$TEMP_ROOT/resume-agent" "$TEMP_ROOT/resume-manager"
resume_run() {
  TEST_RESUME_COUNT="$TEMP_ROOT/resume-count" RB_RALPH_CUSTOM_MANAGER_CAPABILITY=observational-v1 \
    RB_RALPH_FINAL_AUDIT=0 RB_RALPH_EVIDENCE_ENV=RB_BATCH3_MODE RB_BATCH3_MODE="${1:-one}" "$RALPH" --project "$RESUME_PROJECT" \
      --validation-mode run --manager-audit legacy --manager-retries 0 \
      --agent-cmd "$TEMP_ROOT/resume-agent" --manager-cmd "$TEMP_ROOT/resume-manager" >/dev/null
}
resume_run one
[ "$(cat "$TEMP_ROOT/resume-count")" = 1 ] || fail "initial phase did not execute"
resume_run one
[ "$(cat "$TEMP_ROOT/resume-count")" = 1 ] || fail "TEST-RUN-003 stable completed phase was not reused"
ok "TEST-RUN-003 stable product and execution identity reuse completed phase"
printf 'changed\n' > "$RESUME_PROJECT/src/product.txt"
resume_run one
[ "$(cat "$TEMP_ROOT/resume-count")" = 2 ] || fail "TEST-RUN-001 product change reused stale COMPLETE"
ok "TEST-RUN-001 material product change invalidates completed phase reuse"
printf '# context two\n' > "$RESUME_PROJECT/.rb/init/PROJECT.md"
node "$CORE" manifest sync "$RESUME_PROJECT" >/dev/null
resume_run one
[ "$(cat "$TEMP_ROOT/resume-count")" = 3 ] || fail "TEST-RUN-002 context change reused stale COMPLETE"
ok "TEST-RUN-002 context authority change invalidates completed phase reuse"
resume_run two
[ "$(cat "$TEMP_ROOT/resume-count")" = 4 ] || fail "TEST-RUN-004 external identity change reused stale COMPLETE"
ok "TEST-RUN-004 material external identity change invalidates completed phase reuse"

# TEST-RBF-001: no model-selected trivial scenario can close operational proof.
expect_failure env TEST_RESUME_COUNT="$TEMP_ROOT/resume-count" RB_RALPH_EVIDENCE_ENV=RB_BATCH3_MODE RB_BATCH3_MODE=two \
  RB_RALPH_CUSTOM_MANAGER_CAPABILITY=observational-v1 RB_RALPH_FINAL_AUDIT=1 \
  "$RALPH" --project "$RESUME_PROJECT" --validation-mode run --manager-audit legacy --manager-retries 0 \
  --agent-cmd "$TEMP_ROOT/resume-agent" --manager-cmd "$TEMP_ROOT/resume-manager" \
  "TEST-RBF-001 contractless dynamic RBF is blocked"
resume_events="$(find "$RESUME_PROJECT/.rb/runs" -name events.tsv -print -quit)"
grep -Fq $'RBF\t0\tBLOCKED\t' "$resume_events" || fail "dynamic RBF did not persist its missing-authority blocker"
ok "TEST-RBF-001 records explicit operational-contract authority requirement"

printf '1..%s\n' "$PASS"
