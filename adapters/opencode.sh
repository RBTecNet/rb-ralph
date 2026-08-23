#!/usr/bin/env bash
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=adapter-utils.sh
source "$ADAPTER_DIR/adapter-utils.sh"

OPENCODE_BIN="${RB_RALPH_OPENCODE_BIN:-opencode}"
ROLE="${RB_RALPH_ROLE:-}"
PROJECT_ROOT="${RB_RALPH_PROJECT_ROOT:-}"
RB_PERMISSION_MODE="${RB_RALPH_PERMISSION_MODE:-yolo}"

[ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT" ] || {
  printf 'ERROR: RB_RALPH_PROJECT_ROOT must name an existing directory\n' >&2
  exit 1
}
command -v "$OPENCODE_BIN" >/dev/null 2>&1 || {
  printf 'ERROR: OpenCode CLI not found: %s\n' "$OPENCODE_BIN" >&2
  exit 1
}

case "$ROLE" in
  agent)
    MODEL="${RB_RALPH_MODEL:-${RB_RALPH_OPENCODE_AGENT_MODEL:-${RB_RALPH_OPENCODE_MODEL:-}}}"
    EFFORT="${RB_RALPH_EFFORT:-${RB_RALPH_OPENCODE_AGENT_EFFORT:-${RB_RALPH_OPENCODE_EFFORT:-}}}"
    ROLE_PERMISSION="${RB_RALPH_OPENCODE_AGENT_PERMISSION:-}"
    ;;
  manager)
    MODEL="${RB_RALPH_MODEL:-${RB_RALPH_OPENCODE_MANAGER_MODEL:-${RB_RALPH_OPENCODE_MODEL:-}}}"
    EFFORT="${RB_RALPH_EFFORT:-${RB_RALPH_OPENCODE_MANAGER_EFFORT:-${RB_RALPH_OPENCODE_EFFORT:-}}}"
    ROLE_PERMISSION="${RB_RALPH_OPENCODE_MANAGER_PERMISSION:-}"
    ;;
  *)
    printf 'ERROR: RB_RALPH_ROLE must be agent or manager\n' >&2
    exit 1
    ;;
esac

[ -z "$EFFORT" ] || [[ "$EFFORT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  printf 'ERROR: unsupported OpenCode effort token: %s\n' "$EFFORT" >&2
  exit 1
}

case "$RB_PERMISSION_MODE" in
  yolo|protected) ;;
  *)
    printf 'ERROR: RB_RALPH_PERMISSION_MODE must be yolo or protected\n' >&2
    exit 1
    ;;
esac

ARGS=(run --dir "$PROJECT_ROOT")
if [ -n "$MODEL" ]; then
  ARGS+=(--model "$MODEL")
fi
if [ -n "$EFFORT" ]; then
  ARGS+=(--variant "$EFFORT")
fi

if [ "$RB_PERMISSION_MODE" = "yolo" ]; then
  ARGS+=(--auto)
  export OPENCODE_PERMISSION="${ROLE_PERMISSION:-\"allow\"}"
elif [ -n "$ROLE_PERMISSION" ]; then
  export OPENCODE_PERMISSION="$ROLE_PERMISSION"
elif [ "$ROLE" = "manager" ]; then
  # Keep the technical manager observational when protection is requested.
  export OPENCODE_PERMISSION='{"edit":"deny","bash":"deny","task":"deny","external_directory":"deny"}'
fi

cd "$PROJECT_ROOT"
rb_run_provider "$OPENCODE_BIN" "${ARGS[@]}"
