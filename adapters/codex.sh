#!/usr/bin/env bash
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=adapter-utils.sh
source "$ADAPTER_DIR/adapter-utils.sh"

CODEX_BIN="${RB_RALPH_CODEX_BIN:-codex}"
ROLE="${RB_RALPH_ROLE:-}"
PROJECT_ROOT="${RB_RALPH_PROJECT_ROOT:-}"
RB_PERMISSION_MODE="${RB_RALPH_PERMISSION_MODE:-yolo}"
SANDBOX_EXPLICIT=0

[ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT" ] || {
  printf 'ERROR: RB_RALPH_PROJECT_ROOT must name an existing directory\n' >&2
  exit 1
}
command -v "$CODEX_BIN" >/dev/null 2>&1 || {
  printf 'ERROR: Codex CLI not found: %s\n' "$CODEX_BIN" >&2
  exit 1
}

case "$ROLE" in
  agent)
    SANDBOX="${RB_RALPH_CODEX_AGENT_SANDBOX:-workspace-write}"
    [ -z "${RB_RALPH_CODEX_AGENT_SANDBOX+x}" ] || SANDBOX_EXPLICIT=1
    MODEL="${RB_RALPH_MODEL:-${RB_RALPH_CODEX_AGENT_MODEL:-${RB_RALPH_CODEX_MODEL:-}}}"
    EFFORT="${RB_RALPH_EFFORT:-${RB_RALPH_CODEX_AGENT_EFFORT:-${RB_RALPH_CODEX_EFFORT:-}}}"
    ;;
  manager)
    SANDBOX="${RB_RALPH_CODEX_MANAGER_SANDBOX:-read-only}"
    [ -z "${RB_RALPH_CODEX_MANAGER_SANDBOX+x}" ] || SANDBOX_EXPLICIT=1
    MODEL="${RB_RALPH_MODEL:-${RB_RALPH_CODEX_MANAGER_MODEL:-${RB_RALPH_CODEX_MODEL:-}}}"
    EFFORT="${RB_RALPH_EFFORT:-${RB_RALPH_CODEX_MANAGER_EFFORT:-${RB_RALPH_CODEX_EFFORT:-}}}"
    ;;
  *)
    printf 'ERROR: RB_RALPH_ROLE must be agent or manager\n' >&2
    exit 1
    ;;
esac

[ -z "$EFFORT" ] || [[ "$EFFORT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  printf 'ERROR: unsupported Codex effort token: %s\n' "$EFFORT" >&2
  exit 1
}

case "$RB_PERMISSION_MODE" in
  yolo|protected) ;;
  *)
    printf 'ERROR: RB_RALPH_PERMISSION_MODE must be yolo or protected\n' >&2
    exit 1
    ;;
esac

case "$SANDBOX" in
  read-only|workspace-write|danger-full-access) ;;
  *)
    printf 'ERROR: unsupported Codex sandbox: %s\n' "$SANDBOX" >&2
    exit 1
    ;;
esac

ARGS=(
  exec
  --cd "$PROJECT_ROOT"
  --skip-git-repo-check
  --ephemeral
  --color never
)
if [ "$RB_PERMISSION_MODE" = "yolo" ] && [ "$SANDBOX_EXPLICIT" -eq 0 ]; then
  ARGS+=(--dangerously-bypass-approvals-and-sandbox)
else
  ARGS+=(--sandbox "$SANDBOX")
fi
if [ -n "$MODEL" ]; then
  ARGS+=(--model "$MODEL")
fi
if [ -n "$EFFORT" ]; then
  ARGS+=(-c "model_reasoning_effort=\"$EFFORT\"")
fi
if [ -n "${RB_RALPH_TELEMETRY_FILE:-}" ]; then
  ARGS+=(--json)
fi
ARGS+=(-)

if [ -n "${RB_RALPH_TELEMETRY_FILE:-}" ]; then
  TELEMETRY_HELPER="$ADAPTER_DIR/../lib/provider-telemetry.cjs"
  [ -f "$TELEMETRY_HELPER" ] || {
    printf 'ERROR: RB Ralph telemetry helper not found: %s\n' "$TELEMETRY_HELPER" >&2
    exit 1
  }
  rb_run_provider_telemetry "$TELEMETRY_HELPER" codex "$MODEL" "$EFFORT" \
    "$RB_RALPH_TELEMETRY_FILE" "$CODEX_BIN" "${ARGS[@]}"
else
  rb_run_provider "$CODEX_BIN" "${ARGS[@]}"
fi
