#!/usr/bin/env bash
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=adapter-utils.sh
source "$ADAPTER_DIR/adapter-utils.sh"

PROVIDER="${RB_RALPH_PROVIDER:-}"
ROLE="${RB_RALPH_ROLE:-}"
PROJECT_ROOT="${RB_RALPH_PROJECT_ROOT:-}"
MODEL="${RB_RALPH_MODEL:-}"
EFFORT="${RB_RALPH_EFFORT:-}"
PERMISSION_MODE="${RB_RALPH_PERMISSION_MODE:-yolo}"
CORE_CJS="$ADAPTER_DIR/../core/rb-harness.cjs"
CORE_EXECUTABLE="$ADAPTER_DIR/../core/rb-harness"
SELECTED_CORE="${RB_RALPH_DIRECT_API_CORE:-}"

case "$PROVIDER" in
  openai|anthropic|gemini|deepseek|minimax|openrouter) ;;
  *) printf 'ERROR: RB_RALPH_PROVIDER must select a direct API provider\n' >&2; exit 1 ;;
esac
case "$ROLE" in
  agent) API_ROLE="ralph-agent" ;;
  manager) API_ROLE="ralph-manager" ;;
  *) printf 'ERROR: RB_RALPH_ROLE must be agent or manager\n' >&2; exit 1 ;;
esac
[ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT" ] || {
  printf 'ERROR: RB_RALPH_PROJECT_ROOT must name an existing directory\n' >&2
  exit 1
}
[ -n "$MODEL" ] || {
  printf 'ERROR: direct API provider %s requires an explicit model ID\n' "$PROVIDER" >&2
  exit 1
}

ARGS=(
  _provider-run
  --provider "$PROVIDER"
  --model "$MODEL"
  --role "$API_ROLE"
  --project "$PROJECT_ROOT"
  --permission "$PERMISSION_MODE"
)
[ -z "$EFFORT" ] || ARGS+=(--effort "$EFFORT")
[ -z "${RB_RALPH_CREDENTIAL:-}" ] || ARGS+=(--credential "$RB_RALPH_CREDENTIAL")
[ -z "${RB_RALPH_ARTIFACTS_DIR:-}" ] || ARGS+=(--artifacts-dir "$RB_RALPH_ARTIFACTS_DIR")
[ -z "${RB_RALPH_AGENT_EVIDENCE_DIR:-}" ] || ARGS+=(--evidence-dir "$RB_RALPH_AGENT_EVIDENCE_DIR")

if [ -n "$SELECTED_CORE" ]; then
  if [[ "$SELECTED_CORE" == *.js || "$SELECTED_CORE" == *.cjs || "$SELECTED_CORE" == *.mjs ]]; then
    [ -f "$SELECTED_CORE" ] || { printf 'ERROR: selected RB Harness direct API runtime does not exist: %s\n' "$SELECTED_CORE" >&2; exit 1; }
    rb_run_provider "$PROVIDER" node "$SELECTED_CORE" "${ARGS[@]}"
  else
    [ -x "$SELECTED_CORE" ] || { printf 'ERROR: selected RB Harness direct API runtime is not executable: %s\n' "$SELECTED_CORE" >&2; exit 1; }
    rb_run_provider "$PROVIDER" "$SELECTED_CORE" "${ARGS[@]}"
  fi
elif [ -f "$CORE_CJS" ]; then
  rb_run_provider "$PROVIDER" node "$CORE_CJS" "${ARGS[@]}"
elif [ -x "$CORE_EXECUTABLE" ]; then
  rb_run_provider "$PROVIDER" "$CORE_EXECUTABLE" "${ARGS[@]}"
else
  printf 'ERROR: RB Harness direct API runtime is unavailable; reinstall the complete RB Ralph package\n' >&2
  exit 1
fi
