#!/usr/bin/env bash
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=adapter-utils.sh
source "$ADAPTER_DIR/adapter-utils.sh"

CLAUDE_BIN="${RB_RALPH_CLAUDE_BIN:-claude}"
ROLE="${RB_RALPH_ROLE:-}"
PROJECT_ROOT="${RB_RALPH_PROJECT_ROOT:-}"
RB_PERMISSION_MODE="${RB_RALPH_PERMISSION_MODE:-yolo}"

[ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT" ] || {
  printf 'ERROR: RB_RALPH_PROJECT_ROOT must name an existing directory\n' >&2
  exit 1
}
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || {
  printf 'ERROR: Claude CLI not found: %s\n' "$CLAUDE_BIN" >&2
  exit 1
}

case "$ROLE" in
  agent)
    PERMISSION_MODE="${RB_RALPH_CLAUDE_AGENT_PERMISSION_MODE:-$(if [ "$RB_PERMISSION_MODE" = yolo ]; then printf bypassPermissions; else printf acceptEdits; fi)}"
    MODEL="${RB_RALPH_MODEL:-${RB_RALPH_CLAUDE_AGENT_MODEL:-${RB_RALPH_CLAUDE_MODEL:-}}}"
    EFFORT="${RB_RALPH_EFFORT:-${RB_RALPH_CLAUDE_AGENT_EFFORT:-${RB_RALPH_CLAUDE_EFFORT:-}}}"
    ;;
  manager)
    PERMISSION_MODE="${RB_RALPH_CLAUDE_MANAGER_PERMISSION_MODE:-$(if [ "$RB_PERMISSION_MODE" = yolo ]; then printf bypassPermissions; else printf plan; fi)}"
    MODEL="${RB_RALPH_MODEL:-${RB_RALPH_CLAUDE_MANAGER_MODEL:-${RB_RALPH_CLAUDE_MODEL:-}}}"
    EFFORT="${RB_RALPH_EFFORT:-${RB_RALPH_CLAUDE_MANAGER_EFFORT:-${RB_RALPH_CLAUDE_EFFORT:-}}}"
    ;;
  *)
    printf 'ERROR: RB_RALPH_ROLE must be agent or manager\n' >&2
    exit 1
    ;;
esac

[ -z "$EFFORT" ] || [[ "$EFFORT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  printf 'ERROR: unsupported Claude effort token: %s\n' "$EFFORT" >&2
  exit 1
}

case "$RB_PERMISSION_MODE" in
  yolo|protected) ;;
  *)
    printf 'ERROR: RB_RALPH_PERMISSION_MODE must be yolo or protected\n' >&2
    exit 1
    ;;
esac

case "$PERMISSION_MODE" in
  default|manual|acceptEdits|plan|auto|dontAsk|bypassPermissions) ;;
  *)
    printf 'ERROR: unsupported Claude permission mode: %s\n' "$PERMISSION_MODE" >&2
    exit 1
    ;;
esac

ARGS=(
  -p
  --output-format "$(if [ -n "${RB_RALPH_TELEMETRY_FILE:-}" ]; then printf json; else printf text; fi)"
  --permission-mode "$PERMISSION_MODE"
  --no-session-persistence
)
if [ "$PERMISSION_MODE" = "bypassPermissions" ]; then
  ARGS+=(--dangerously-skip-permissions)
fi
if [ -n "$MODEL" ]; then
  ARGS+=(--model "$MODEL")
fi
if [ -n "$EFFORT" ]; then
  ARGS+=(--effort "$EFFORT")
fi
if [ -n "${RB_RALPH_CLAUDE_MAX_TURNS:-}" ]; then
  [[ "$RB_RALPH_CLAUDE_MAX_TURNS" =~ ^[1-9][0-9]*$ ]] || {
    printf 'ERROR: RB_RALPH_CLAUDE_MAX_TURNS must be a positive integer\n' >&2
    exit 1
  }
  ARGS+=(--max-turns "$RB_RALPH_CLAUDE_MAX_TURNS")
fi
if [ -n "${RB_RALPH_CLAUDE_MAX_BUDGET_USD:-}" ]; then
  ARGS+=(--max-budget-usd "$RB_RALPH_CLAUDE_MAX_BUDGET_USD")
fi

cd "$PROJECT_ROOT"
unset CLAUDECODE
if [ -n "${RB_RALPH_TELEMETRY_FILE:-}" ]; then
  TELEMETRY_HELPER="$ADAPTER_DIR/../lib/provider-telemetry.cjs"
  [ -f "$TELEMETRY_HELPER" ] || {
    printf 'ERROR: RB Ralph telemetry helper not found: %s\n' "$TELEMETRY_HELPER" >&2
    exit 1
  }
  rb_run_provider_telemetry "$TELEMETRY_HELPER" claude "$MODEL" "$EFFORT" \
    "$RB_RALPH_TELEMETRY_FILE" "$CLAUDE_BIN" "${ARGS[@]}"
else
  rb_run_provider "$CLAUDE_BIN" "${ARGS[@]}"
fi
