#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RALPH="$PACKAGE_ROOT/bin/rb-ralph"
INSTALL_ENTRY="$PACKAGE_ROOT/rb-ralph.sh"
CORE="$PACKAGE_ROOT/core/rb-harness.cjs"
MINIMAL_FIXTURE="$PACKAGE_ROOT/tests/fixtures/execution/valid/minimal/PHASES.md"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_ROOT"' EXIT

PASS=0
PROJECT_SEQUENCE=0

ok() {
  PASS=$((PASS + 1))
  printf 'ok %s - %s\n' "$PASS" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local path="$1" expected="$2" message="$3"
  grep -Fq -- "$expected" "$path" || fail "$message"
  ok "$message"
}

assert_not_contains() {
  local path="$1" unexpected="$2" message="$3"
  if grep -Fq -- "$unexpected" "$path"; then fail "$message"; fi
  ok "$message"
}

assert_not_exists() {
  local path="$1" message="$2"
  [ ! -e "$path" ] || fail "$message"
  ok "$message"
}

expect_failure() {
  local output="$1"
  shift
  if "$@" > "$output" 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
}

new_project() {
  local label="$1" project
  PROJECT_SEQUENCE=$((PROJECT_SEQUENCE + 1))
  project="$TEMP_ROOT/projects/$label-$PROJECT_SEQUENCE"
  mkdir -p "$project/.rb/features/test"
  node "$CORE" project init "$project" --name "$label" --id "ralph-test-$PROJECT_SEQUENCE" >/dev/null
  cp "$MINIMAL_FIXTURE" "$project/.rb/features/test/PHASES.md"
  node "$CORE" manifest sync "$project" >/dev/null
  printf '%s\n' "$project"
}

make_core_wrapper() {
  local path="$1" label="$2"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
    printf 'printf %q\\n >> "$CORE_TRACE"\n' "$label"
    printf 'exec node %q "$@"\n' "$CORE"
  } > "$path"
  chmod +x "$path"
}

MOCK_STATE="$TEMP_ROOT/mock-state"
mkdir -p "$MOCK_STATE"
export MOCK_STATE
# Existing contract tests exercise P01 semantics in isolation. Dedicated tests
# below opt into the new default final audit explicitly.
export RB_RALPH_FINAL_AUDIT=0

MOCK_DRIVER="$TEMP_ROOT/mock-driver"
export MOCK_DRIVER
cat > "$MOCK_DRIVER" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
provider="${MOCK_PROVIDER:-custom}"
cat > "$MOCK_STATE/${MOCK_RUN_TAG}-${provider}-${RB_RALPH_ROLE}.prompt"
printf '%s|%s|agent_model=%s|manager_model=%s|args=%s|permission=%s|yolo=%s|model=%s|generic_agent_model=%s|generic_manager_model=%s\n' \
  "$provider" "$RB_RALPH_ROLE" "${RB_RALPH_CODEX_AGENT_MODEL:-}" \
  "${RB_RALPH_CODEX_MANAGER_MODEL:-}" "$*" \
  "${RB_RALPH_PERMISSION_MODE:-missing}" "${RB_RALPH_YOLO:-missing}" \
  "${RB_RALPH_MODEL:-}" "${RB_RALPH_AGENT_MODEL:-}" "${RB_RALPH_MANAGER_MODEL:-}" \
  >> "$MOCK_STATE/roles.log"
if [ "$RB_RALPH_ROLE" = "agent" ]; then
  mkdir -p src
  printf 'implemented by %s\n' "$provider" > "src/${MOCK_RUN_TAG}.txt"
  printf 'executor-output-%s\n' "$provider"
else
  printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: reviewed evidence'
fi
MOCK
chmod +x "$MOCK_DRIVER"

cat > "$TEMP_ROOT/mock-codex" <<'MOCK_CODEX'
#!/usr/bin/env bash
export MOCK_PROVIDER=codex
exec "$MOCK_DRIVER" "$@"
MOCK_CODEX
cat > "$TEMP_ROOT/mock-claude" <<'MOCK_CLAUDE'
#!/usr/bin/env bash
export MOCK_PROVIDER=claude
exec "$MOCK_DRIVER" "$@"
MOCK_CLAUDE
cat > "$TEMP_ROOT/mock-opencode" <<'MOCK_OPENCODE'
#!/usr/bin/env bash
export MOCK_PROVIDER=opencode
exec "$MOCK_DRIVER" "$@"
MOCK_OPENCODE
cat > "$TEMP_ROOT/custom-agent" <<'CUSTOM_AGENT'
#!/usr/bin/env bash
export MOCK_PROVIDER=custom-agent
exec "$MOCK_DRIVER" "$@"
CUSTOM_AGENT
cat > "$TEMP_ROOT/custom-manager" <<'CUSTOM_MANAGER'
#!/usr/bin/env bash
export MOCK_PROVIDER=custom-manager
exec "$MOCK_DRIVER" "$@"
CUSTOM_MANAGER
chmod +x "$TEMP_ROOT/mock-codex" "$TEMP_ROOT/mock-claude" \
  "$TEMP_ROOT/mock-opencode" "$TEMP_ROOT/custom-agent" "$TEMP_ROOT/custom-manager"

run_role_project() {
  local tag="$1" project="$2"
  shift 2
  MOCK_RUN_TAG="$tag" \
  RB_RALPH_CODEX_BIN="$TEMP_ROOT/mock-codex" \
  RB_RALPH_CLAUDE_BIN="$TEMP_ROOT/mock-claude" \
  RB_RALPH_OPENCODE_BIN="$TEMP_ROOT/mock-opencode" \
    "$RALPH" --project "$project" --validation-mode manager --max-attempts 1 "$@"
}

# 1. The source runner works through its real path without relying on cwd.
REAL_PROJECT="$(new_project real-path)"
(cd / && "$RALPH" --project "$REAL_PROJECT" --list) > "$TEMP_ROOT/real-path.out"
assert_contains "$TEMP_ROOT/real-path.out" "init-minimal-execution" "real-path invocation works outside the repository"

# 2. A PATH symlink resolves package resources while --project remains relative to the caller.
PATH_DIR="$TEMP_ROOT/path directory/bin"
CALL_DIR="$TEMP_ROOT/caller directory"
mkdir -p "$PATH_DIR" "$CALL_DIR"
RELATIVE_PROJECT="$CALL_DIR/relative project"
PROJECT_SEQUENCE=$((PROJECT_SEQUENCE + 1))
mkdir -p "$RELATIVE_PROJECT/.rb/features/test"
node "$CORE" project init "$RELATIVE_PROJECT" --name "relative project" --id "ralph-test-$PROJECT_SEQUENCE" >/dev/null
cp "$MINIMAL_FIXTURE" "$RELATIVE_PROJECT/.rb/features/test/PHASES.md"
node "$CORE" manifest sync "$RELATIVE_PROJECT" >/dev/null
ln -s "$RALPH" "$PATH_DIR/rb-ralph"
(cd "$CALL_DIR" && PATH="$PATH_DIR:$PATH" rb-ralph --project "relative project" --list) > "$TEMP_ROOT/symlink.out"
assert_contains "$TEMP_ROOT/symlink.out" "init-minimal-execution" "PATH symlink preserves caller-relative project paths"

# 3 and 4. The self-installer copies the complete package into a prefix containing spaces.
INSTALL_PREFIX="$TEMP_ROOT/installed prefix"
"$INSTALL_ENTRY" --install --prefix "$INSTALL_PREFIX" > "$TEMP_ROOT/install.out"
[ -L "$INSTALL_PREFIX/bin/rb-ralph" ] || fail "installed launcher is not a symlink"
[ -x "$INSTALL_PREFIX/libexec/rb-ralph/adapters/codex.sh" ] || fail "installed adapters are missing"
[ -x "$INSTALL_PREFIX/libexec/rb-ralph/adapters/opencode.sh" ] || fail "installed OpenCode adapter is missing"
[ -x "$INSTALL_PREFIX/libexec/rb-ralph/lib/evidence.cjs" ] || fail "installed evidence helper is missing"
[ -x "$INSTALL_PREFIX/libexec/rb-ralph/lib/process-supervisor.cjs" ] || fail "installed process supervisor is missing"
[ -x "$INSTALL_PREFIX/libexec/rb-ralph/lib/operational-verifier.cjs" ] || fail "installed operational verifier is missing"
[ -f "$INSTALL_PREFIX/libexec/rb-ralph/VERSION" ] || fail "installed version marker is missing"
[ -x "$INSTALL_PREFIX/bin/rb-ralph-watch" ] || fail "installed dashboard launcher is missing"
ok "temporary-prefix installation keeps launcher and auxiliary resources together"
"$RALPH" --ver > "$TEMP_ROOT/source-version.out"
"$INSTALL_PREFIX/bin/rb-ralph" --version > "$TEMP_ROOT/installed-version.out"
assert_contains "$TEMP_ROOT/source-version.out" "RB Ralph 0.4.0" "source runner reports its package version"
assert_contains "$TEMP_ROOT/installed-version.out" "RB Ralph 0.4.0" "installed runner reports the same package version"
assert_contains "$TEMP_ROOT/install.out" "RB Ralph 0.4.0 installed" "installer reports the installed version"
SPACE_PROJECT="$(new_project 'project with spaces')"
(cd / && "$INSTALL_PREFIX/bin/rb-ralph" --project "$SPACE_PROJECT" --list) > "$TEMP_ROOT/spaces.out"
assert_contains "$TEMP_ROOT/spaces.out" "init-minimal-execution" "installed layout supports paths containing spaces"

# 5. Core discovery follows flag, environment, packaged installation, PATH, then an actionable error.
CORE_TRACE="$TEMP_ROOT/core-trace"
export CORE_TRACE
FLAG_CORE="$TEMP_ROOT/flag-core"
ENV_CORE="$TEMP_ROOT/env-core"
PACKAGED_CORE="$TEMP_ROOT/packaged-core"
PATH_CORE_DIR="$TEMP_ROOT/core-path"
mkdir -p "$PATH_CORE_DIR"
make_core_wrapper "$FLAG_CORE" flag
make_core_wrapper "$ENV_CORE" environment
make_core_wrapper "$PACKAGED_CORE" packaged
make_core_wrapper "$PATH_CORE_DIR/rb-harness" path
: > "$CORE_TRACE"
RB_RALPH_CORE_CLI="$ENV_CORE" "$RALPH" --core-cli "$FLAG_CORE" --project "$REAL_PROJECT" --list >/dev/null
assert_contains "$CORE_TRACE" "flag" "--core-cli has highest precedence"
: > "$CORE_TRACE"
RB_RALPH_CORE_CLI="$ENV_CORE" "$RALPH" --project "$REAL_PROJECT" --list >/dev/null
assert_contains "$CORE_TRACE" "environment" "RB_RALPH_CORE_CLI has second precedence"
PACKAGED_PREFIX="$TEMP_ROOT/packaged precedence"
"$INSTALL_ENTRY" --install --prefix "$PACKAGED_PREFIX" --core-cli "$PACKAGED_CORE" >/dev/null
: > "$CORE_TRACE"
PATH="$PATH_CORE_DIR:$PATH" "$PACKAGED_PREFIX/bin/rb-ralph" --project "$REAL_PROJECT" --list >/dev/null
assert_contains "$CORE_TRACE" "packaged" "installed core is preferred over PATH"
EMPTY_HOME="$TEMP_ROOT/empty-ralph-home"
mkdir -p "$EMPTY_HOME"
: > "$CORE_TRACE"
RB_RALPH_HOME="$EMPTY_HOME" PATH="$PATH_CORE_DIR:/usr/bin:/bin" "$RALPH" --project "$REAL_PROJECT" --list >/dev/null
assert_contains "$CORE_TRACE" "path" "rb-harness on PATH is the final discovery fallback"
expect_failure "$TEMP_ROOT/core-error.out" env RB_RALPH_HOME="$EMPTY_HOME" PATH=/usr/bin:/bin \
  "$RALPH" --project "$REAL_PROJECT" --list
assert_contains "$TEMP_ROOT/core-error.out" "Use --core-cli" "missing core reports actionable recovery options"

# 6. --provider configures the same built-in provider for both independent roles.
: > "$MOCK_STATE/roles.log"
PROVIDER_PROJECT="$(new_project provider-shared)"
run_role_project provider-shared "$PROVIDER_PROJECT" --provider codex >/dev/null
assert_contains "$MOCK_STATE/roles.log" "codex|agent" "--provider codex selects Codex executor"
assert_contains "$MOCK_STATE/roles.log" "codex|manager" "--provider codex selects Codex manager"
assert_contains "$MOCK_STATE/roles.log" "--dangerously-bypass-approvals-and-sandbox" \
  "Codex defaults to the real YOLO bypass"
assert_contains "$MOCK_STATE/roles.log" "permission=yolo|yolo=1" \
  "default permission contract is propagated to provider calls"

# 7. An agent-only provider is inherited, including its role model by default.
: > "$MOCK_STATE/roles.log"
INHERITED_PROVIDER_PROJECT="$(new_project provider-inherited)"
RB_RALPH_CODEX_AGENT_MODEL="executor-model" run_role_project provider-inherited \
  "$INHERITED_PROVIDER_PROJECT" --agent-provider codex >/dev/null
assert_contains "$MOCK_STATE/roles.log" "model=executor-model|generic_agent_model=executor-model|generic_manager_model=executor-model" \
  "agent-only provider and model are inherited by the manager"

# 8. Different providers are used only when explicitly requested.
: > "$MOCK_STATE/roles.log"
MIXED_PROJECT="$(new_project providers-mixed)"
run_role_project providers-mixed "$MIXED_PROJECT" --agent-provider claude --manager-provider codex >/dev/null
assert_contains "$MOCK_STATE/roles.log" "claude|agent" "explicit Claude executor is honored"
assert_contains "$MOCK_STATE/roles.log" "codex|manager" "explicit different Codex manager is honored"
assert_contains "$MOCK_STATE/roles.log" "--dangerously-skip-permissions" \
  "Claude defaults to the real YOLO bypass"

# Models are provider-neutral at the runner boundary. Shared selection applies
# to both roles; role-specific flags win independently of argument order.
: > "$MOCK_STATE/roles.log"
SHARED_MODEL_PROJECT="$(new_project model-shared)"
run_role_project model-shared "$SHARED_MODEL_PROJECT" \
  --provider claude --model sonnet >/dev/null
assert_contains "$MOCK_STATE/roles.log" "--model sonnet" \
  "shared model is forwarded by the Claude adapter"
assert_contains "$MOCK_STATE/roles.log" "generic_agent_model=sonnet|generic_manager_model=sonnet" \
  "shared model configures executor and manager"

: > "$MOCK_STATE/roles.log"
OPENCODE_MODEL_PROJECT="$(new_project opencode-models)"
run_role_project opencode-models "$OPENCODE_MODEL_PROJECT" --provider opencode \
  --agent-model deepseek/deepseek-chat \
  --manager-model openrouter/minimax/minimax-m2.1 >/dev/null
assert_contains "$MOCK_STATE/roles.log" "opencode|agent" \
  "OpenCode is available as a built-in executor"
assert_contains "$MOCK_STATE/roles.log" "--model deepseek/deepseek-chat" \
  "OpenCode executor receives its provider/model ID"
assert_contains "$MOCK_STATE/roles.log" "--model openrouter/minimax/minimax-m2.1" \
  "OpenCode manager receives a different model"
assert_contains "$MOCK_STATE/roles.log" "--auto" \
  "OpenCode follows the default YOLO policy"

: > "$MOCK_STATE/roles.log"
MIXED_MODEL_PROJECT="$(new_project mixed-role-models)"
run_role_project mixed-role-models "$MIXED_MODEL_PROJECT" \
  --agent-provider claude --agent-model opus \
  --manager-provider opencode --manager-model openrouter/moonshotai/kimi-k2.5 >/dev/null
assert_contains "$MOCK_STATE/roles.log" "claude|agent" \
  "mixed-model run uses Claude executor"
assert_contains "$MOCK_STATE/roles.log" "--model opus" \
  "mixed-model executor receives Opus"
assert_contains "$MOCK_STATE/roles.log" "opencode|manager" \
  "mixed-model run uses OpenCode manager"
assert_contains "$MOCK_STATE/roles.log" "--model openrouter/moonshotai/kimi-k2.5" \
  "mixed-model manager receives Kimi"

for model_order in before after; do
  : > "$MOCK_STATE/roles.log"
  MODEL_ORDER_PROJECT="$(new_project "model-order-$model_order")"
  if [ "$model_order" = before ]; then
    run_role_project "model-order-$model_order" "$MODEL_ORDER_PROJECT" \
      --agent-model haiku --model sonnet --provider claude >/dev/null
  else
    run_role_project "model-order-$model_order" "$MODEL_ORDER_PROJECT" \
      --model sonnet --provider claude --agent-model haiku >/dev/null
  fi
  assert_contains "$MOCK_STATE/roles.log" "generic_agent_model=haiku|generic_manager_model=sonnet" \
    "role model overrides shared model with flags ordered $model_order"
done

: > "$MOCK_STATE/roles.log"
CUSTOM_MODEL_PROJECT="$(new_project custom-model-contract)"
run_role_project custom-model-contract "$CUSTOM_MODEL_PROJECT" \
  --agent-cmd "$MOCK_DRIVER" --agent-model vendor/custom-executor >/dev/null
assert_contains "$MOCK_STATE/roles.log" "model=vendor/custom-executor" \
  "custom adapter receives the selected effective model"
assert_contains "$MOCK_STATE/roles.log" \
  "generic_agent_model=vendor/custom-executor|generic_manager_model=vendor/custom-executor" \
  "custom manager inherits the executor model"

# YOLO is the shared default; protected mode is explicit and reaches built-in
# and custom adapters through the provider-neutral environment contract.
: > "$MOCK_STATE/roles.log"
PROTECTED_PROJECT="$(new_project permission-protected)"
run_role_project permission-protected "$PROTECTED_PROJECT" --provider codex --protected >/dev/null
assert_contains "$MOCK_STATE/roles.log" "--sandbox workspace-write" \
  "protected Codex executor uses workspace-write"
assert_contains "$MOCK_STATE/roles.log" "--sandbox read-only" \
  "protected Codex manager uses read-only"
assert_not_contains "$MOCK_STATE/roles.log" "--dangerously-bypass-approvals-and-sandbox" \
  "protected Codex calls do not use YOLO bypass"
assert_contains "$MOCK_STATE/roles.log" "permission=protected|yolo=0" \
  "protected permission contract is propagated"

: > "$MOCK_STATE/roles.log"
CLAUDE_PROTECTED_PROJECT="$(new_project claude-permission-protected)"
run_role_project claude-permission-protected "$CLAUDE_PROTECTED_PROJECT" \
  --provider claude --protected >/dev/null
assert_contains "$MOCK_STATE/roles.log" "--permission-mode acceptEdits" \
  "protected Claude executor uses acceptEdits"
assert_contains "$MOCK_STATE/roles.log" "--permission-mode plan" \
  "protected Claude manager uses plan"
assert_not_contains "$MOCK_STATE/roles.log" "--dangerously-skip-permissions" \
  "protected Claude calls do not use YOLO bypass"

: > "$MOCK_STATE/roles.log"
CUSTOM_PROTECTED_PROJECT="$(new_project custom-permission-protected)"
run_role_project custom-permission-protected "$CUSTOM_PROTECTED_PROJECT" \
  --agent-cmd "$MOCK_DRIVER" --protected >/dev/null
assert_contains "$MOCK_STATE/roles.log" "custom|agent" \
  "protected custom executor is invoked"
assert_contains "$MOCK_STATE/roles.log" "permission=protected|yolo=0" \
  "custom adapters receive protected mode explicitly"

: > "$MOCK_STATE/roles.log"
CLI_YOLO_PROJECT="$(new_project cli-yolo-override)"
RB_RALPH_PERMISSION_MODE=protected run_role_project cli-yolo-override \
  "$CLI_YOLO_PROJECT" --provider codex --yolo >/dev/null
assert_contains "$MOCK_STATE/roles.log" "--dangerously-bypass-approvals-and-sandbox" \
  "explicit --yolo overrides the protected environment default"

# 9 and 10. Custom executor commands inherit by default and may be overridden explicitly.
: > "$MOCK_STATE/roles.log"
CUSTOM_INHERITED_PROJECT="$(new_project custom-inherited)"
run_role_project custom-inherited "$CUSTOM_INHERITED_PROJECT" --agent-cmd "$MOCK_DRIVER" >/dev/null
assert_contains "$MOCK_STATE/roles.log" "custom|agent" "custom executor command is invoked"
assert_contains "$MOCK_STATE/roles.log" "custom|manager" "custom executor command is inherited by manager"
: > "$MOCK_STATE/roles.log"
CUSTOM_MIXED_PROJECT="$(new_project custom-mixed)"
run_role_project custom-mixed "$CUSTOM_MIXED_PROJECT" \
  --agent-cmd "$TEMP_ROOT/custom-agent" --manager-cmd "$TEMP_ROOT/custom-manager" >/dev/null
assert_contains "$MOCK_STATE/roles.log" "custom-agent|agent" "explicit custom executor command is honored"
assert_contains "$MOCK_STATE/roles.log" "custom-manager|manager" "explicit custom manager command is honored"

# 11 and 12. Ambiguous role configuration and manager-only configuration fail closed.
CONFLICT_PROJECT="$(new_project role-conflict)"
expect_failure "$TEMP_ROOT/conflict.out" "$RALPH" --project "$CONFLICT_PROJECT" \
  --agent-provider codex --agent-cmd "$MOCK_DRIVER"
assert_contains "$TEMP_ROOT/conflict.out" "not both" "provider/cmd conflict for one role is rejected"
MANAGER_ONLY_PROJECT="$(new_project manager-only)"
expect_failure "$TEMP_ROOT/manager-only.out" "$RALPH" --project "$MANAGER_ONLY_PROJECT" \
  --manager-provider codex
assert_contains "$TEMP_ROOT/manager-only.out" "requires a primary executor" "manager without executor is rejected clearly"

# 13. Role-specific options override --provider independently of argument order.
: > "$MOCK_STATE/roles.log"
ORDER_A_PROJECT="$(new_project order-a)"
run_role_project order-a "$ORDER_A_PROJECT" --provider codex --agent-provider claude >/dev/null
ORDER_B_PROJECT="$(new_project order-b)"
run_role_project order-b "$ORDER_B_PROJECT" --agent-provider claude --provider codex >/dev/null
for tag in order-a order-b; do
  assert_contains "$MOCK_STATE/$tag-claude-agent.prompt" "RB_RALPH_ROLE: implementation-agent" \
    "$tag resolves Claude as executor"
  assert_contains "$MOCK_STATE/$tag-codex-manager.prompt" "RB_RALPH_ROLE: technical-manager" \
    "$tag resolves Codex as manager"
done

# 14. Empty depends_on preserves the phase title in dry-run and real execution.
TITLE_PROJECT="$(new_project empty-dependency)"
sed -i 's/Build the foundation/Fundação TypeScript/' "$TITLE_PROJECT/.rb/features/test/PHASES.md"
node "$CORE" manifest sync "$TITLE_PROJECT" >/dev/null
"$RALPH" --project "$TITLE_PROJECT" --dry-run > "$TEMP_ROOT/title-dry-run.out"
assert_contains "$TEMP_ROOT/title-dry-run.out" $'depends=none\ttitle=Fundação TypeScript' \
  "dry-run preserves title after an empty depends_on field"

# Evidence-specific adapters also exercise the real-loop TSV path.
cat > "$TEMP_ROOT/evidence-agent" <<'EVIDENCE_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
mkdir -p src
printf 'evidence implementation\n' > src/evidence.txt
printf 'executor-output-marker\n'
EVIDENCE_AGENT
cat > "$TEMP_ROOT/evidence-manager" <<'EVIDENCE_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
prompt="$MOCK_STATE/evidence-manager.prompt"
cat > "$prompt"
[ "$RB_RALPH_PHASE_TITLE" = "Fundação TypeScript" ]
[ "$RB_RALPH_AGENT_EXIT_CODE" = "0" ]
grep -Fq 'src/evidence.txt' "$RB_RALPH_CHANGED_PATHS_FILE"
grep -Fq 'executor-output-marker' "$RB_RALPH_AGENT_LOG"
grep -Fq './validate.sh' "$RB_RALPH_VALIDATION_LOG"
grep -Fq 'validation-output-marker' "$RB_RALPH_VALIDATION_LOG"
grep -Fq 'exit=0' "$RB_RALPH_VALIDATION_LOG"
grep -Fq 'manual: inspect generated evidence' "$RB_RALPH_VALIDATION_LOG"
grep -Fq 'VALIDATION_COMMANDS: 1' "$prompt"
grep -Fq 'MANUAL_VALIDATIONS: 1' "$prompt"
grep -Fq 'AC-T001-01' "$prompt"
printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: all evidence inspected'
EVIDENCE_MANAGER
chmod +x "$TEMP_ROOT/evidence-agent" "$TEMP_ROOT/evidence-manager"
sed -i 's#    - `npm test`#    - `./validate.sh`\n    - manual: inspect generated evidence#' \
  "$TITLE_PROJECT/.rb/features/test/PHASES.md"
cat > "$TITLE_PROJECT/validate.sh" <<'VALIDATE'
#!/usr/bin/env bash
printf 'validation-output-marker\n'
VALIDATE
chmod +x "$TITLE_PROJECT/validate.sh"
node "$CORE" manifest sync "$TITLE_PROJECT" >/dev/null
MOCK_RUN_TAG=evidence "$RALPH" --project "$TITLE_PROJECT" --max-attempts 1 \
  --agent-cmd "$TEMP_ROOT/evidence-agent" --manager-cmd "$TEMP_ROOT/evidence-manager" \
  > "$TEMP_ROOT/evidence.out"
assert_contains "$TEMP_ROOT/evidence.out" "P01 complete" "real execution preserves title and supplies complete manager evidence"

# 15. An executor failure cannot be converted to COMPLETE by an optimistic manager.
cat > "$TEMP_ROOT/failing-agent" <<'FAILING_AGENT'
#!/usr/bin/env bash
cat > /dev/null
printf 'executor failed intentionally\n'
exit 7
FAILING_AGENT
chmod +x "$TEMP_ROOT/failing-agent"
EXECUTOR_FAILURE_PROJECT="$(new_project executor-failure)"
expect_failure "$TEMP_ROOT/executor-failure.out" env MOCK_RUN_TAG=executor-failure \
  "$RALPH" --project "$EXECUTOR_FAILURE_PROJECT" --validation-mode manager --max-attempts 1 \
  --max-total-attempts 1 \
  --agent-cmd "$TEMP_ROOT/failing-agent" --manager-cmd "$MOCK_DRIVER"
assert_contains "$TEMP_ROOT/executor-failure.out" "implementation agent or isolated integration exited with 7" \
  "executor failure prevents COMPLETE"
EXECUTOR_FAILURE_RUN="$(basename "$(find "$EXECUTOR_FAILURE_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
"$PACKAGE_ROOT/bin/rb-ralph-watch" --project "$EXECUTOR_FAILURE_PROJECT" --run "$EXECUTOR_FAILURE_RUN" \
  --once --no-color > "$TEMP_ROOT/executor-failure-dashboard.out"
assert_contains "$TEMP_ROOT/executor-failure-dashboard.out" "G0 ✗  G1 ✓  G2 ⊘  G3 ✗" \
  "dashboard gates expose executor and manager failure"
assert_contains "$TEMP_ROOT/executor-failure-dashboard.out" "CIRCUIT BREAKER" \
  "dashboard labels the resumable safety pause"
assert_contains "$TEMP_ROOT/executor-failure-dashboard.out" "limite de segurança de 1 tentativa" \
  "dashboard renders the hard-cap reason"

# A direct manager blocker must remain explainable after the process exits.
cat > "$TEMP_ROOT/blocking-manager" <<'BLOCKING_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf '%s\n' \
  'RB_RALPH_DECISION: BLOCKED' \
  'RB_RALPH_REASON: external approval is required before changing production'
BLOCKING_MANAGER
chmod +x "$TEMP_ROOT/blocking-manager"
BLOCKED_PROJECT="$(new_project manager-blocked)"
expect_failure "$TEMP_ROOT/manager-blocked.out" env MOCK_RUN_TAG=manager-blocked \
  "$RALPH" --project "$BLOCKED_PROJECT" --validation-mode manager --max-attempts 1 \
  --agent-cmd "$TEMP_ROOT/custom-agent" --manager-cmd "$TEMP_ROOT/blocking-manager"
BLOCKED_RUN="$(basename "$(find "$BLOCKED_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
"$PACKAGE_ROOT/bin/rb-ralph-watch" --project "$BLOCKED_PROJECT" --run "$BLOCKED_RUN" \
  --once --no-color > "$TEMP_ROOT/manager-blocked-dashboard.out"
assert_contains "$TEMP_ROOT/manager-blocked-dashboard.out" "MOTIVO DO BLOQUEIO" \
  "dashboard identifies a manager blocker"
assert_contains "$TEMP_ROOT/manager-blocked-dashboard.out" \
  "external approval is required before changing production" \
  "dashboard explains the manager blocker"
assert_contains "$TEMP_ROOT/manager-blocked-dashboard.out" "events.tsv · P01 tentativa 1" \
  "dashboard points to the persisted blocker event"

# A resumed attempt must not render the prior run's blocker while the current
# phase is running, even though events.tsv intentionally remains append-only.
BLOCKED_LIVE="$BLOCKED_PROJECT/.rb/runs/$BLOCKED_RUN/dashboard-live.tsv"
sed -i \
  -e $'s/^META\tstatus\tfailed$/META\tstatus\trunning/' \
  -e $'s/^META\tactivity\t.*$/META\tactivity\tG3 · technical manager is reviewing evidence/' \
  -e $'s/^META\treason\t.*$/META\treason\t/' \
  -e $'s/^PHASE\tP01\tblocked\t/PHASE\tP01\trunning\t/' \
  "$BLOCKED_LIVE"
"$PACKAGE_ROOT/bin/rb-ralph-watch" --project "$BLOCKED_PROJECT" --run "$BLOCKED_RUN" \
  --once --no-color > "$TEMP_ROOT/manager-resumed-dashboard.out"
assert_not_contains "$TEMP_ROOT/manager-resumed-dashboard.out" "MOTIVO DO BLOQUEIO" \
  "dashboard hides a stale blocker during a resumed attempt"
assert_not_contains "$TEMP_ROOT/manager-resumed-dashboard.out" \
  "external approval is required before changing production" \
  "dashboard hides stale blocker content while G3 runs again"

# Provider failures retain actionable diagnostics in events and in the final
# dashboard instead of being replaced by a generic exhausted-attempts message.
cat > "$TEMP_ROOT/insufficient-balance-opencode" <<'BALANCE_OPENCODE'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf '\033[91mError: Insufficient balance. Manage your billing.\033[0m\n' >&2
exit 1
BALANCE_OPENCODE
chmod +x "$TEMP_ROOT/insufficient-balance-opencode"
BALANCE_PROJECT="$(new_project manager-billing-error)"
expect_failure "$TEMP_ROOT/manager-billing-error.out" env \
  MOCK_RUN_TAG=manager-billing-error \
  RB_RALPH_OPENCODE_BIN="$TEMP_ROOT/insufficient-balance-opencode" \
  "$RALPH" --project "$BALANCE_PROJECT" --validation-mode manager --max-attempts 1 \
  --agent-cmd "$TEMP_ROOT/custom-agent" \
  --manager-provider opencode --manager-model opencode/deepseek-v4-flash
BALANCE_RUN="$(basename "$(find "$BALANCE_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
BALANCE_EVENTS="$BALANCE_PROJECT/.rb/runs/$BALANCE_RUN/events.tsv"
assert_contains "$BALANCE_EVENTS" "saldo insuficiente no OpenCode Zen" \
  "manager billing failure identifies the affected OpenCode product"
assert_contains "$BALANCE_EVENTS" "opencode-go/deepseek-v4-flash" \
  "manager billing failure suggests the equivalent Go model"
assert_contains "$BALANCE_EVENTS" "logs/P01-attempt-1-manager.log" \
  "manager billing failure points to the complete provider log"
"$PACKAGE_ROOT/bin/rb-ralph-watch" --project "$BALANCE_PROJECT" --run "$BALANCE_RUN" \
  --once --no-color > "$TEMP_ROOT/manager-billing-dashboard.out"
assert_contains "$TEMP_ROOT/manager-billing-dashboard.out" "MOTIVO DO BLOQUEIO" \
  "final dashboard labels the external provider blocker"
assert_contains "$TEMP_ROOT/manager-billing-dashboard.out" "saldo insuficiente no OpenCode Zen" \
  "final dashboard preserves the actionable provider failure"
assert_not_contains "$BALANCE_EVENTS" $'\tMANAGER_RETRY\t' \
  "terminal billing errors do not consume executor or manager retries"

assert_contains "$PACKAGE_ROOT/lib/dashboard.cjs" \
  'process.stdout.write(`\u001b[H\u001b[2J${frame}`);' \
  "live dashboard clears the complete screen before every frame"

# 16. A deterministic validation failure also cannot be overridden by the manager.
VALIDATION_FAILURE_PROJECT="$(new_project validation-failure)"
sed -i 's#`npm test`#`bash -c "printf validation-failed; exit 9"`#' \
  "$VALIDATION_FAILURE_PROJECT/.rb/features/test/PHASES.md"
node "$CORE" manifest sync "$VALIDATION_FAILURE_PROJECT" >/dev/null
expect_failure "$TEMP_ROOT/validation-failure.out" env MOCK_RUN_TAG=validation-failure \
  "$RALPH" --project "$VALIDATION_FAILURE_PROJECT" --max-attempts 1 \
  --max-total-attempts 1 \
  --agent-cmd "$TEMP_ROOT/custom-agent" --manager-cmd "$MOCK_DRIVER"
assert_contains "$TEMP_ROOT/validation-failure.out" "deterministic validation failed" \
  "validation failure prevents COMPLETE"
VALIDATION_FAILURE_RUN="$(basename "$(find "$VALIDATION_FAILURE_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
"$PACKAGE_ROOT/bin/rb-ralph-watch" --project "$VALIDATION_FAILURE_PROJECT" --run "$VALIDATION_FAILURE_RUN" \
  --once --no-color > "$TEMP_ROOT/validation-failure-dashboard.out"
assert_contains "$TEMP_ROOT/validation-failure-dashboard.out" "G0 ✓  G1 ✓  G2 ✗  G3 ✗" \
  "dashboard gates expose deterministic validation failure"

# Progress may continue beyond the old fixed three-attempt ceiling.
cat > "$TEMP_ROOT/progressive-agent" <<'PROGRESSIVE_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
count_file="$MOCK_STATE/progressive-agent.count"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
mkdir -p src
printf 'implementation pass %s\n' "$count" > "src/progressive-$count.txt"
PROGRESSIVE_AGENT
cat > "$TEMP_ROOT/progressive-manager" <<'PROGRESSIVE_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
attempt="${RB_RALPH_ATTEMPT:?}"
if [ "$attempt" -lt 4 ]; then
  printf '%s\n' 'RB_RALPH_DECISION: RETRY' "RB_RALPH_REASON: remaining defect discovered in pass $attempt"
else
  printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: fourth progressive implementation satisfies the phase'
fi
PROGRESSIVE_MANAGER
chmod +x "$TEMP_ROOT/progressive-agent" "$TEMP_ROOT/progressive-manager"
PROGRESSIVE_PROJECT="$(new_project progressive-recovery)"
MOCK_STATE="$MOCK_STATE" "$RALPH" --project "$PROGRESSIVE_PROJECT" --validation-mode manager \
  --max-attempts 1 --max-strategy-resets 0 --max-total-attempts 5 \
  --agent-cmd "$TEMP_ROOT/progressive-agent" --manager-cmd "$TEMP_ROOT/progressive-manager" \
  > "$TEMP_ROOT/progressive-recovery.out"
[ "$(cat "$MOCK_STATE/progressive-agent.count")" = 4 ] \
  || fail "progressive implementation did not reach the fourth executor attempt"
ok "proven progress may continue beyond three executor attempts"
PROGRESSIVE_RUN="$(basename "$(find "$PROGRESSIVE_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
assert_contains "$PROGRESSIVE_PROJECT/.rb/runs/$PROGRESSIVE_RUN/events.tsv" $'P01\t4\tCOMPLETE\t' \
  "fourth progressive attempt can be accepted"
assert_contains "$PROGRESSIVE_PROJECT/.rb/runs/$PROGRESSIVE_RUN/prompts/P01-attempt-4-agent.txt" \
  'PREVIOUS_MANAGER_FEEDBACK: remaining defect discovered in pass 3' \
  "each implementation retry receives the latest manager feedback"

# No repository change plus RETRY trips the no-progress circuit breaker.
cat > "$TEMP_ROOT/stalled-agent" <<'STALLED_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
count_file="$MOCK_STATE/stalled-agent.count"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
printf '%s\n' "$((count + 1))" > "$count_file"
printf 'executor made no changes\n'
STALLED_AGENT
cat > "$TEMP_ROOT/stalled-manager" <<'STALLED_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf '%s\n' 'RB_RALPH_DECISION: RETRY' 'RB_RALPH_REASON: implementation is still unchanged'
STALLED_MANAGER
chmod +x "$TEMP_ROOT/stalled-agent" "$TEMP_ROOT/stalled-manager"
STALLED_PROJECT="$(new_project stalled-circuit)"
expect_failure "$TEMP_ROOT/stalled-circuit.out" env MOCK_STATE="$MOCK_STATE" \
  "$RALPH" --project "$STALLED_PROJECT" --validation-mode manager \
  --max-attempts 1 --max-strategy-resets 0 --max-total-attempts 5 \
  --agent-cmd "$TEMP_ROOT/stalled-agent" --manager-cmd "$TEMP_ROOT/stalled-manager"
[ "$(cat "$MOCK_STATE/stalled-agent.count")" = 1 ] \
  || fail "no-progress circuit breaker repeated the executor"
ok "no-progress circuit breaker prevents an infinite token loop"
STALLED_RUN="$(basename "$(find "$STALLED_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
assert_contains "$STALLED_PROJECT/.rb/runs/$STALLED_RUN/events.tsv" $'\tPAUSED\tcircuit breaker: sem progresso comprovável' \
  "stalled execution is paused with a resumable reason"

# A malformed manager response retries only G3 against preserved evidence.
cat > "$TEMP_ROOT/manager-retry-agent" <<'MANAGER_RETRY_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
count_file="$MOCK_STATE/manager-retry-agent.count"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
printf '%s\n' "$((count + 1))" > "$count_file"
mkdir -p src
printf 'manager retry evidence\n' > src/manager-retry.txt
MANAGER_RETRY_AGENT
cat > "$TEMP_ROOT/flaky-manager" <<'FLAKY_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
count_file="$MOCK_STATE/flaky-manager.count"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
if [ "$count" -eq 1 ]; then
  printf 'temporary malformed response\n'
else
  printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: same evidence accepted after protocol recovery'
fi
FLAKY_MANAGER
chmod +x "$TEMP_ROOT/manager-retry-agent" "$TEMP_ROOT/flaky-manager"
MANAGER_RETRY_PROJECT="$(new_project manager-retry-isolation)"
MOCK_STATE="$MOCK_STATE" "$RALPH" --project "$MANAGER_RETRY_PROJECT" --validation-mode manager \
  --manager-retries 2 --manager-retry-wait 0 \
  --agent-cmd "$TEMP_ROOT/manager-retry-agent" --manager-cmd "$TEMP_ROOT/flaky-manager" \
  > "$TEMP_ROOT/manager-retry-isolation.out"
[ "$(cat "$MOCK_STATE/manager-retry-agent.count")" = 1 ] \
  || fail "manager protocol retry repeated the executor"
[ "$(cat "$MOCK_STATE/flaky-manager.count")" = 2 ] \
  || fail "manager protocol retry did not perform exactly two review calls"
ok "manager recovery retries only the reviewer on preserved evidence"
MANAGER_RETRY_RUN="$(basename "$(find "$MANAGER_RETRY_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
assert_contains "$MANAGER_RETRY_PROJECT/.rb/runs/$MANAGER_RETRY_RUN/events.tsv" $'\tMANAGER_RETRY\t' \
  "isolated manager retries remain observable"

# On Linux, actual CPU/I/O progress prevents a false output-idle timeout even
# when a provider is temporarily silent. The wall-clock ceiling remains active.
if [ "$(uname -s)" = Linux ]; then
  printf 'supervisor input\n' > "$TEMP_ROOT/supervisor-input"
  cat > "$TEMP_ROOT/busy-silent-provider" <<'BUSY_SILENT_PROVIDER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
started="$SECONDS"
while [ "$((SECONDS - started))" -lt 2 ]; do :; done
printf 'busy provider completed\n'
BUSY_SILENT_PROVIDER
  chmod +x "$TEMP_ROOT/busy-silent-provider"
  node "$PACKAGE_ROOT/lib/process-supervisor.cjs" \
    --input "$TEMP_ROOT/supervisor-input" --output "$TEMP_ROOT/busy-silent.log" \
    --idle-timeout 1 --timeout 5 --grace 1 --label test-agent \
    -- "$TEMP_ROOT/busy-silent-provider"
  assert_contains "$TEMP_ROOT/busy-silent.log" 'busy provider completed' \
    "Linux CPU progress prevents a false provider inactivity timeout"
  assert_not_contains "$TEMP_ROOT/busy-silent.log" 'RB_RALPH_PROCESS_STATUS: TIMEOUT' \
    "busy provider remains bounded by activity rather than output alone"

  cat > "$TEMP_ROOT/orphaning-provider" <<'ORPHANING_PROVIDER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
sleep 30 > /dev/null 2>&1 &
printf '%s\n' "$!" > "$ORPHAN_PID_FILE"
sleep 1
printf 'provider parent completed\n'
ORPHANING_PROVIDER
  chmod +x "$TEMP_ROOT/orphaning-provider"
  ORPHAN_PID_FILE="$TEMP_ROOT/orphan.pid" \
    node "$PACKAGE_ROOT/lib/process-supervisor.cjs" \
      --input "$TEMP_ROOT/supervisor-input" --output "$TEMP_ROOT/orphaning.log" \
      --idle-timeout 5 --timeout 10 --grace 1 --label test-agent \
      -- "$TEMP_ROOT/orphaning-provider"
  orphan_pid="$(cat "$TEMP_ROOT/orphan.pid")"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$orphan_pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$orphan_pid" 2>/dev/null; then
    fail "normally completed provider left a background descendant running"
  fi
  ok "normal provider completion cleans up background descendants"
  assert_contains "$TEMP_ROOT/orphaning.log" 'RB_RALPH_PROCESS_CLEANUP:' \
    "normal descendant cleanup remains observable in the provider log"
fi

# Executor inactivity terminates the complete adapter process group, reaches the
# manager as structured evidence, and is recovered by a fresh executor call.
cat > "$TEMP_ROOT/idle-agent" <<'IDLE_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
count_file="$MOCK_STATE/idle-agent.count"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
if [ "$count" -eq 1 ]; then
  sleep 30 &
  printf '%s\n' "$!" > "$MOCK_STATE/idle-descendant.pid"
  printf 'provider entered a silent tool call\n'
  wait
fi
mkdir -p src
printf 'recovered after timeout\n' > src/idle-recovered.txt
IDLE_AGENT
cat > "$TEMP_ROOT/idle-aware-manager" <<'IDLE_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
prompt="$MOCK_STATE/idle-manager-attempt-${RB_RALPH_ATTEMPT:?}.prompt"
cat > "$prompt"
if [ "$RB_RALPH_AGENT_EXIT_CODE" = 124 ]; then
  grep -Fq 'AGENT_TIMED_OUT: 1' "$prompt"
  grep -Fq 'RB_RALPH_PROCESS_STATUS: TIMEOUT' "$RB_RALPH_AGENT_LOG"
  printf '%s\n' 'RB_RALPH_DECISION: BLOCKED' \
    'RB_RALPH_REASON: preserve partial files and avoid the silent cleanup command on the next attempt'
else
  printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: executor recovered and evidence is complete'
fi
IDLE_MANAGER
chmod +x "$TEMP_ROOT/idle-agent" "$TEMP_ROOT/idle-aware-manager"
IDLE_PROJECT="$(new_project executor-idle-recovery)"
MOCK_STATE="$MOCK_STATE" "$RALPH" --project "$IDLE_PROJECT" --validation-mode manager \
  --agent-idle-timeout 1 --agent-timeout 10 \
  --manager-idle-timeout 2 --manager-timeout 10 --manager-retry-wait 0 \
  --agent-cmd "$TEMP_ROOT/idle-agent" --manager-cmd "$TEMP_ROOT/idle-aware-manager" \
  > "$TEMP_ROOT/executor-idle-recovery.out"
[ "$(cat "$MOCK_STATE/idle-agent.count")" = 2 ] \
  || fail "executor inactivity was not recovered by exactly one fresh call"
idle_descendant="$(cat "$MOCK_STATE/idle-descendant.pid")"
if kill -0 "$idle_descendant" 2>/dev/null; then
  fail "executor inactivity left a descendant process running"
fi
ok "executor inactivity kills the adapter tree and resumes implementation"
IDLE_RUN="$(basename "$(find "$IDLE_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
assert_contains "$IDLE_PROJECT/.rb/runs/$IDLE_RUN/logs/P01-attempt-1-agent.log" \
  'RB_RALPH_TIMEOUT_KIND: idle' "executor log records the actionable inactivity timeout"
assert_contains "$IDLE_PROJECT/.rb/runs/$IDLE_RUN/events.tsv" \
  'avoid the silent cleanup command' "manager recovery strategy is persisted for the next executor"
assert_not_contains "$IDLE_PROJECT/.rb/runs/$IDLE_RUN/events.tsv" $'P01\t1\tBLOCKED\t' \
  "executor timeout cannot be left as a terminal manager blocker"
assert_contains "$IDLE_PROJECT/.rb/runs/$IDLE_RUN/prompts/P01-attempt-2-agent.txt" \
  'avoid the silent cleanup command' "fresh executor receives the manager timeout recovery strategy"

# A silent manager is supervised independently and retried over the same
# executor evidence without paying for another implementation call.
cat > "$TEMP_ROOT/manager-timeout-agent" <<'MANAGER_TIMEOUT_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
count_file="$MOCK_STATE/manager-timeout-agent.count"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
printf '%s\n' "$((count + 1))" > "$count_file"
mkdir -p src
printf 'single executor evidence\n' > src/manager-timeout.txt
MANAGER_TIMEOUT_AGENT
cat > "$TEMP_ROOT/manager-timeout-reviewer" <<'MANAGER_TIMEOUT_REVIEWER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
count_file="$MOCK_STATE/manager-timeout.count"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
if [ "$count" -eq 1 ]; then
  printf 'manager started reviewing\n'
  sleep 30
fi
printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: same executor evidence accepted after manager timeout'
MANAGER_TIMEOUT_REVIEWER
chmod +x "$TEMP_ROOT/manager-timeout-agent" "$TEMP_ROOT/manager-timeout-reviewer"
MANAGER_TIMEOUT_PROJECT="$(new_project manager-timeout-recovery)"
MOCK_STATE="$MOCK_STATE" "$RALPH" --project "$MANAGER_TIMEOUT_PROJECT" --validation-mode manager \
  --agent-idle-timeout 5 --agent-timeout 10 \
  --manager-idle-timeout 1 --manager-timeout 10 --manager-retries 2 --manager-retry-wait 0 \
  --agent-cmd "$TEMP_ROOT/manager-timeout-agent" --manager-cmd "$TEMP_ROOT/manager-timeout-reviewer" \
  > "$TEMP_ROOT/manager-timeout-recovery.out"
[ "$(cat "$MOCK_STATE/manager-timeout-agent.count")" = 1 ] \
  || fail "manager inactivity incorrectly repeated the executor"
[ "$(cat "$MOCK_STATE/manager-timeout.count")" = 2 ] \
  || fail "manager inactivity did not retry the review"
ok "manager inactivity retries only G3 over preserved evidence"
MANAGER_TIMEOUT_RUN="$(basename "$(find "$MANAGER_TIMEOUT_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
assert_contains "$MANAGER_TIMEOUT_PROJECT/.rb/runs/$MANAGER_TIMEOUT_RUN/logs/P01-attempt-1-manager.log" \
  'RB_RALPH_TIMEOUT_ROLE: manager' "manager timeout is recorded in its original evidence log"
assert_contains "$MANAGER_TIMEOUT_PROJECT/.rb/runs/$MANAGER_TIMEOUT_RUN/events.tsv" \
  'repetindo somente o gerente' "manager timeout recovery is observable without executor repetition"

# The hard cap is durable and a later command resumes with persisted feedback.
cat > "$TEMP_ROOT/capped-agent" <<'CAPPED_AGENT'
#!/usr/bin/env bash
set -euo pipefail
cat > "$MOCK_STATE/capped-last-agent.prompt"
count_file="$MOCK_STATE/capped-agent.count"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
mkdir -p src
printf 'capped pass %s\n' "$count" > "src/capped-$count.txt"
CAPPED_AGENT
cat > "$TEMP_ROOT/capped-manager" <<'CAPPED_MANAGER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
if [ "${CAPPED_MANAGER_COMPLETE:-0}" = 1 ]; then
  printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: resumed evidence accepted'
else
  printf '%s\n' 'RB_RALPH_DECISION: RETRY' "RB_RALPH_REASON: capped feedback from attempt ${RB_RALPH_ATTEMPT:?}"
fi
CAPPED_MANAGER
chmod +x "$TEMP_ROOT/capped-agent" "$TEMP_ROOT/capped-manager"
CAPPED_PROJECT="$(new_project hard-cap-resume)"
expect_failure "$TEMP_ROOT/hard-cap-first.out" env MOCK_STATE="$MOCK_STATE" \
  "$RALPH" --project "$CAPPED_PROJECT" --validation-mode manager \
  --max-attempts 3 --max-total-attempts 2 \
  --agent-cmd "$TEMP_ROOT/capped-agent" --manager-cmd "$TEMP_ROOT/capped-manager"
[ "$(cat "$MOCK_STATE/capped-agent.count")" = 2 ] \
  || fail "hard cap did not stop after exactly two executor attempts"
ok "absolute hard cap bounds one unattended invocation"
MOCK_STATE="$MOCK_STATE" CAPPED_MANAGER_COMPLETE=1 \
  "$RALPH" --project "$CAPPED_PROJECT" --validation-mode manager \
  --max-attempts 3 --max-total-attempts 2 \
  --agent-cmd "$TEMP_ROOT/capped-agent" --manager-cmd "$TEMP_ROOT/capped-manager" \
  > "$TEMP_ROOT/hard-cap-resume.out"
CAPPED_RUN="$(basename "$(find "$CAPPED_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
assert_contains "$CAPPED_PROJECT/.rb/runs/$CAPPED_RUN/events.tsv" $'P01\t3\tCOMPLETE\t' \
  "resumed execution continues with a durable attempt number"
assert_contains "$MOCK_STATE/capped-last-agent.prompt" \
  'PREVIOUS_MANAGER_FEEDBACK: capped feedback from attempt 2' \
  "resumed executor receives persisted manager feedback"

# 17 is covered by the evidence manager assertions above; verify persisted paths too.
CHANGES_FILE="$(find "$TITLE_PROJECT/.rb/runs" -name '*-changes.json' -type f -print -quit)"
VALIDATION_LOG="$(find "$TITLE_PROJECT/.rb/runs" -name '*-validation.log' -type f -print -quit)"
assert_contains "$CHANGES_FILE" '"src/evidence.txt"' "changed code is persisted as manager evidence"
assert_contains "$VALIDATION_LOG" "manual: inspect generated evidence" "pending manual validation is persisted as manager evidence"

# Live-state telemetry: Codex JSONL usage is aggregated and priced only from an explicit catalog.
cat > "$TEMP_ROOT/telemetry-codex" <<'TELEMETRY_CODEX'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
if [ "$RB_RALPH_ROLE" = "agent" ]; then
  mkdir -p src
  printf 'telemetry implementation\n' > src/telemetry.txt
  message='executor telemetry complete'
else
  message='RB_RALPH_DECISION: COMPLETE\nRB_RALPH_REASON: telemetry reviewed'
fi
printf '%s\n' \
  '{"type":"thread.started","thread_id":"test"}' \
  "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"$message\"}}" \
  '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":100}}'
TELEMETRY_CODEX
chmod +x "$TEMP_ROOT/telemetry-codex"
cat > "$TEMP_ROOT/pricing.json" <<'PRICING'
{
  "currency": "USD",
  "models": {
    "priced-model": {
      "inputPerMillion": 2,
      "cachedInputPerMillion": 0.5,
      "outputPerMillion": 10
    }
  }
}
PRICING
TELEMETRY_PROJECT="$(new_project telemetry-dashboard)"
RB_RALPH_CODEX_BIN="$TEMP_ROOT/telemetry-codex" \
RB_RALPH_CODEX_AGENT_MODEL=priced-model \
  "$RALPH" --project "$TELEMETRY_PROJECT" --validation-mode manager --max-attempts 1 \
  --agent-provider codex --pricing-file "$TEMP_ROOT/pricing.json" > "$TEMP_ROOT/telemetry-run.out"
TELEMETRY_RUN="$(basename "$(find "$TELEMETRY_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
RB_RALPH_WATCH_COLS=120 RB_RALPH_WATCH_LINES=50 \
  "$PACKAGE_ROOT/bin/rb-ralph-watch" --project "$TELEMETRY_PROJECT" --run "$TELEMETRY_RUN" \
  --once --no-color > "$TEMP_ROOT/dashboard.out"
assert_contains "$TEMP_ROOT/dashboard.out" "CHAMADAS 2  medidas 2  sem métrica 0" \
  "dashboard reports measured provider calls"
assert_contains "$TEMP_ROOT/dashboard.out" "TOKENS entrada 2,000  cache↙ 400" \
  "dashboard reports input and cache token statistics"
assert_contains "$TEMP_ROOT/dashboard.out" "saída 200  total 2,200" \
  "dashboard reports output and total token statistics"
assert_contains "$TEMP_ROOT/dashboard.out" "USD 0.005400 (configured-pricing)" \
  "dashboard labels costs estimated from explicit pricing"
assert_contains "$TEMP_ROOT/dashboard.out" "G0 ✓  G1 ✓  G2 ⊘  G3 ✓" \
  "dashboard exposes all executor, evidence, validation, and manager gates"
assert_contains "$TEMP_ROOT/dashboard.out" "ACESSO YOLO" \
  "dashboard makes unrestricted execution visible"
assert_contains "$TEMP_ROOT/dashboard.out" "codex[priced-model] executor / codex[priced-model] manager" \
  "dashboard identifies the effective model for each role"
assert_contains "$TEMP_ROOT/dashboard.out" "RALPH · capivara de plantão" \
  "wide dashboard renders the RB Ralph mascot"
assert_contains "$TEMP_ROOT/dashboard.out" "v0.4.0" \
  "dashboard identifies the running RB Ralph version"
assert_contains "$TEMP_ROOT/dashboard.out" "LOG RECENTE · GERENTE" \
  "dashboard shows the current role in a compact recent-log panel"
assert_contains "$TEMP_ROOT/dashboard.out" "telemetry reviewed" \
  "recent-log panel exposes normalized manager progress"
LOG_PANEL_LINE="$(grep -n -m 1 'LOG RECENTE' "$TEMP_ROOT/dashboard.out" | cut -d: -f1)"
FINAL_FOOTER_LINE="$(grep -n -m 1 'q fecha este painel' "$TEMP_ROOT/dashboard.out" | cut -d: -f1)"
if [ "$LOG_PANEL_LINE" -lt "$FINAL_FOOTER_LINE" ]; then
  ok "recent-log panel stays between the phase table and dashboard footer"
else
  fail "recent-log panel is not positioned before the dashboard footer"
fi
if [ "$((FINAL_FOOTER_LINE - LOG_PANEL_LINE))" -eq 7 ]; then
  ok "recent-log panel keeps a fixed four-line content height"
else
  fail "recent-log panel height changed unexpectedly"
fi

# Re-running the same failed plan must not mix the previous invocation's models
# into the live usage panel. Historical telemetry remains in a separate scope.
cat > "$TEMP_ROOT/failing-opencode" <<'FAILING_OPENCODE'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf 'simulated OpenCode failure\n' >&2
exit 1
FAILING_OPENCODE
chmod +x "$TEMP_ROOT/failing-opencode"
USAGE_SCOPE_PROJECT="$(new_project usage-invocation-scope)"
expect_failure "$TEMP_ROOT/usage-old-run.out" env \
  MOCK_RUN_TAG=usage-old-run \
  RB_RALPH_CODEX_BIN="$TEMP_ROOT/mock-codex" \
  RB_RALPH_OPENCODE_BIN="$TEMP_ROOT/failing-opencode" \
  "$RALPH" --project "$USAGE_SCOPE_PROJECT" --validation-mode manager --max-attempts 1 \
  --agent-provider codex --agent-model sol \
  --manager-provider opencode --manager-model deepseek-v4-flash
MOCK_RUN_TAG=usage-current-run RB_RALPH_CODEX_BIN="$TEMP_ROOT/mock-codex" \
  "$RALPH" --project "$USAGE_SCOPE_PROJECT" --validation-mode manager --max-attempts 1 \
  --provider codex --model gpt-5.6-luna > "$TEMP_ROOT/usage-current-run.out"
USAGE_SCOPE_RUN="$(basename "$(find "$USAGE_SCOPE_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
"$PACKAGE_ROOT/bin/rb-ralph-watch" --project "$USAGE_SCOPE_PROJECT" --run "$USAGE_SCOPE_RUN" \
  --once --no-color > "$TEMP_ROOT/usage-current-dashboard.out"
assert_contains "$TEMP_ROOT/usage-current-dashboard.out" \
  "codex[gpt-5.6-luna] executor / codex[gpt-5.6-luna] manager" \
  "repeated run dashboard reports the current role models"
assert_contains "$TEMP_ROOT/usage-current-dashboard.out" "codex/gpt-5.6-luna  2 chamada(s)" \
  "repeated run usage reports only current invocation calls"
assert_not_contains "$TEMP_ROOT/usage-current-dashboard.out" "codex/sol" \
  "repeated run usage excludes the previous executor model"
assert_not_contains "$TEMP_ROOT/usage-current-dashboard.out" "opencode/deepseek-v4-flash" \
  "repeated run usage excludes the previous manager model"
USAGE_INVOCATION_COUNT="$(find "$USAGE_SCOPE_PROJECT/.rb/runs/$USAGE_SCOPE_RUN/usage" \
  -mindepth 1 -maxdepth 1 -type d | wc -l)"
if [ "$USAGE_INVOCATION_COUNT" -eq 2 ]; then
  ok "repeated run preserves telemetry in two invocation scopes"
else
  fail "repeated run did not preserve two telemetry scopes (count=$USAGE_INVOCATION_COUNT)"
fi
"$PACKAGE_ROOT/bin/rb-ralph-watch" --project "$TELEMETRY_PROJECT" --run "$TELEMETRY_RUN" \
  --embedded --once --no-color > "$TEMP_ROOT/dashboard-final-frame.out"
assert_contains "$TEMP_ROOT/dashboard-final-frame.out" "Run finalizado · pressione Enter para fechar o painel" \
  "embedded dashboard keeps the final frame open until Enter"
RB_RALPH_WATCH_COLS=88 RB_RALPH_WATCH_LINES=50 \
  "$PACKAGE_ROOT/bin/rb-ralph-watch" --project "$TELEMETRY_PROJECT" --run "$TELEMETRY_RUN" \
  --once --no-color > "$TEMP_ROOT/dashboard-narrow.out"
NARROW_MAX_WIDTH="$(wc -L < "$TEMP_ROOT/dashboard-narrow.out")"
if [ "$NARROW_MAX_WIDTH" -le 90 ]; then
  ok "dashboard reflows without overflowing a narrow terminal"
else
  fail "dashboard overflows the configured narrow terminal width (width=$NARROW_MAX_WIDTH)"
fi
assert_not_contains "$TEMP_ROOT/dashboard-narrow.out" "capivara de plantão" \
  "narrow dashboard preserves space by using the compact brand"

cat > "$TEMP_ROOT/claude-raw.json" <<'CLAUDE_JSON'
{"result":"claude normalized output","total_cost_usd":0.123,"usage":{"input_tokens":3,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"output_tokens":4}}
CLAUDE_JSON
RB_RALPH_ROLE=manager RB_RALPH_PHASE_ID=P99 RB_RALPH_ATTEMPT=1 \
  node "$PACKAGE_ROOT/lib/provider-telemetry.cjs" claude "$TEMP_ROOT/claude-raw.json" \
  "$TEMP_ROOT/claude.usage.json" claude-test > "$TEMP_ROOT/claude-normalized.out"
assert_contains "$TEMP_ROOT/claude-normalized.out" "claude normalized output" \
  "Claude JSON result is normalized for the manager protocol"
assert_contains "$TEMP_ROOT/claude.usage.json" '"costSource": "provider"' \
  "provider-reported Claude cost is preserved without estimation"

# Final product acceptance is runtime-only, stack/platform neutral, and runs
# rb-operational/v1 in a secret-free disposable copy even in manager validation mode.
FINAL_AUDIT_PROJECT="$(new_project final-operational-audit)"
printf '%s\n' 'must-not-enter-clean-room' > "$FINAL_AUDIT_PROJECT/.env"
cat > "$FINAL_AUDIT_PROJECT/.rb/features/test/OPERATIONS.json" <<'OPERATIONS'
{
  "contract": "rb-operational/v1",
  "cleanRoom": { "exclude": [] },
  "environment": { "inherit": [], "set": {} },
  "scenarios": [
    {
      "id": "consumer-command",
      "title": "Exercise a command product without stack assumptions",
      "steps": [
        {
          "id": "clean-copy",
          "kind": "command",
          "command": {
            "argv": ["node", "-e", "const f=require('fs'); if(f.existsSync('.env')||!f.existsSync('src/final-audit.txt')) process.exit(7); console.log('clean-command-ok')"]
          },
          "expect": { "exitCode": 0, "stdoutIncludes": ["clean-command-ok"] }
        },
        {
          "id": "real-process-boundary",
          "kind": "process",
          "command": {
            "argv": ["node", "-e", "require('http').createServer((q,r)=>r.end('operational-ok')).listen(Number(process.env.RB_VERIFY_PORT), '127.0.0.1', ()=>console.log('ready'))"]
          },
          "ready": { "kind": "stdout", "includes": "ready" },
          "checks": [
            { "kind": "http", "url": "http://127.0.0.1:${RB_VERIFY_PORT}/", "status": 200, "bodyIncludes": ["operational-ok"] }
          ]
        }
      ]
    }
  ]
}
OPERATIONS
MOCK_RUN_TAG=final-audit RB_RALPH_FINAL_AUDIT=1 \
  "$RALPH" --project "$FINAL_AUDIT_PROJECT" --validation-mode manager --max-attempts 1 \
  --agent-cmd "$MOCK_DRIVER" > "$TEMP_ROOT/final-audit.out"
FINAL_AUDIT_RUN="$(basename "$(find "$FINAL_AUDIT_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
assert_contains "$FINAL_AUDIT_PROJECT/.rb/runs/$FINAL_AUDIT_RUN/events.tsv" $'RBF\t1\tCOMPLETE\t' \
  "final operational acceptance is persisted as runtime phase RBF"
assert_contains "$FINAL_AUDIT_PROJECT/.rb/runs/$FINAL_AUDIT_RUN/logs/RBF-attempt-1-validation.log" \
  'RB_OPERATIONAL_RESULT: PASS' "rb-operational/v1 runs successfully in the clean room"
assert_contains "$MOCK_STATE/final-audit-custom-agent.prompt" \
  'Do not assume HTTP, a browser, npm, containers, Linux' \
  "final executor prompt is stack and product-platform neutral"
assert_contains "$MOCK_STATE/final-audit-custom-manager.prompt" \
  'For desktop/mobile software' "final manager explicitly audits non-web product forms"
printf '\n' >> "$FINAL_AUDIT_PROJECT/.rb/features/test/OPERATIONS.json"
MOCK_RUN_TAG=final-audit-refresh RB_RALPH_FINAL_AUDIT=1 \
  "$RALPH" --project "$FINAL_AUDIT_PROJECT" --validation-mode manager --max-attempts 1 \
  --agent-cmd "$MOCK_DRIVER" > "$TEMP_ROOT/final-audit-refresh.out"
assert_contains "$FINAL_AUDIT_PROJECT/.rb/runs/$FINAL_AUDIT_RUN/events.tsv" $'RBF\t2\tCOMPLETE\t' \
  "changed operational contract invalidates only the prior final acceptance"

FINAL_FAILURE_PROJECT="$(new_project final-operational-failure)"
cat > "$FINAL_FAILURE_PROJECT/.rb/features/test/OPERATIONS.json" <<'OPERATIONS_FAIL'
{
  "contract": "rb-operational/v1",
  "scenarios": [{
    "id": "broken-consumer",
    "title": "Expose a product integration failure",
    "steps": [{
      "id": "fails",
      "kind": "command",
      "command": { "argv": ["node", "-e", "console.error('consumer boundary failed'); process.exit(9)"] }
    }]
  }]
}
OPERATIONS_FAIL
expect_failure "$TEMP_ROOT/final-failure.out" env MOCK_RUN_TAG=final-failure RB_RALPH_FINAL_AUDIT=1 \
  "$RALPH" --project "$FINAL_FAILURE_PROJECT" --validation-mode manager \
  --max-attempts 1 --max-total-attempts 1 --agent-cmd "$MOCK_DRIVER"
FINAL_FAILURE_RUN="$(basename "$(find "$FINAL_FAILURE_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
assert_contains "$FINAL_FAILURE_PROJECT/.rb/runs/$FINAL_FAILURE_RUN/events.tsv" $'RBF\t1\tRETRY\t' \
  "failed operational proof overrides an optimistic manager COMPLETE"
assert_not_contains "$FINAL_FAILURE_PROJECT/.rb/runs/$FINAL_FAILURE_RUN/events.tsv" $'RBF\t1\tCOMPLETE\t' \
  "failed operational proof cannot complete the final phase"

FINAL_DISABLED_PROJECT="$(new_project final-audit-disabled)"
MOCK_RUN_TAG=final-disabled RB_RALPH_FINAL_AUDIT=1 \
  "$RALPH" --project "$FINAL_DISABLED_PROJECT" --validation-mode manager \
  --no-final-audit --agent-cmd "$MOCK_DRIVER" > "$TEMP_ROOT/final-disabled.out"
FINAL_DISABLED_RUN="$(basename "$(find "$FINAL_DISABLED_PROJECT/.rb/runs" -mindepth 1 -maxdepth 1 -type d -print -quit)")"
assert_not_contains "$FINAL_DISABLED_PROJECT/.rb/runs/$FINAL_DISABLED_RUN/events.tsv" $'\tRBF\t' \
  "--no-final-audit explicitly opts out without changing PHASES.md"

# 18. Both safe inspection modes avoid execution state.
INSPECTION_PROJECT="$(new_project inspection-only)"
"$RALPH" --project "$INSPECTION_PROJECT" --list >/dev/null
assert_not_exists "$INSPECTION_PROJECT/.rb/runs" "--list creates no execution state"
"$RALPH" --project "$INSPECTION_PROJECT" --dry-run >/dev/null
assert_not_exists "$INSPECTION_PROJECT/.rb/runs" "--dry-run creates no execution state"

# The requested removal path is also verified against the exact temporary prefix.
"$INSTALL_ENTRY" --uninstall --prefix "$INSTALL_PREFIX" >/dev/null
assert_not_exists "$INSTALL_PREFIX/bin/rb-ralph" "self-installer removes its launcher"
assert_not_exists "$INSTALL_PREFIX/bin/rb-ralph-watch" "self-installer removes its dashboard launcher"
assert_not_exists "$INSTALL_PREFIX/libexec/rb-ralph" "self-installer removes its resource tree"

"$RALPH" --help > "$TEMP_ROOT/help.out"
assert_contains "$TEMP_ROOT/help.out" 'AUTONOMOUS CONTROL PLANE' "--help renders the RB Ralph ASCII wordmark"
assert_contains "$TEMP_ROOT/help.out" 'capivara de plantão' "--help introduces the Ralph mascot"
assert_contains "$TEMP_ROOT/help.out" './rb-ralph.sh --install' "--help explains installation"
assert_contains "$TEMP_ROOT/help.out" 'rb-ralph --project /path/to/project --list' "--help provides inspection commands"
assert_contains "$TEMP_ROOT/help.out" '--agent-provider claude --agent-model sonnet' "--help provides separate-role model command"
assert_contains "$TEMP_ROOT/help.out" '--agent-model deepseek/deepseek-chat' "--help provides an OpenCode model example"
assert_contains "$TEMP_ROOT/help.out" 'rb-ralph-watch --project /path/to/project' "--help explains the live dashboard command"
assert_contains "$TEMP_ROOT/help.out" '--protected' "--help explains the protected opt-in"
assert_contains "$TEMP_ROOT/help.out" 'defaults to YOLO' "--help warns about the unrestricted default"
assert_contains "$TEMP_ROOT/help.out" '--max-total-attempts N' "--help exposes the absolute executor safety cap"
assert_contains "$TEMP_ROOT/help.out" '--max-strategy-resets N' "--help exposes bounded strategy recovery"
assert_contains "$TEMP_ROOT/help.out" '--manager-retries <n>' "--help exposes same-evidence manager recovery"
assert_contains "$TEMP_ROOT/help.out" '--agent-idle-timeout N' "--help exposes executor inactivity recovery"
assert_contains "$TEMP_ROOT/help.out" '--manager-idle-timeout N' "--help exposes manager inactivity recovery"
assert_contains "$TEMP_ROOT/help.out" '--operations <path>' "--help exposes the operational contract override"
assert_contains "$TEMP_ROOT/help.out" '--no-final-audit' "--help documents the explicit final-audit opt-out"
assert_contains "$TEMP_ROOT/help.out" '--ver, --version' "--help exposes version inspection"

printf '1..%s\n' "$PASS"
