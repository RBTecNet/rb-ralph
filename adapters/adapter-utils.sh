#!/usr/bin/env bash

rb_provider_completed() {
  local provider="$1" output="$2"
  case "$provider" in
    codex)
      grep -Eq '^[[:space:]]*\{[[:space:]]*"type"[[:space:]]*:[[:space:]]*"turn\.completed"' "$output"
      ;;
    *) return 1 ;;
  esac
}

rb_output_is_rate_limited() {
  local provider="$1" output="$2"
  rb_provider_completed "$provider" "$output" && return 1
  tail -n 80 "$output" | grep -Eiq \
    '(^|[^0-9])429([^0-9]|$)|too many requests|quota (has been )?exceeded|usage limit (has been )?(reached|exceeded)|rate[ -]?limit(ed| has been exceeded| exceeded| reached)|requests per (minute|day)|tokens per minute'
}

rb_run_provider() {
  local provider="$1"
  shift
  local output provider_rc retry_after
  output="$(mktemp)"

  set +e
  "$@" 2>&1 | tee "$output"
  provider_rc="${PIPESTATUS[0]}"
  set -e

  if [ "$provider_rc" -ne 0 ] && rb_output_is_rate_limited "$provider" "$output"; then
    printf 'RB_RALPH_PROVIDER_STATUS: RATE_LIMIT\n'
    retry_after="$(sed -nE 's/.*[Rr]etry (after|in) ([0-9]+) ?(seconds|second|secs|sec|s).*/\2/p' "$output" | tail -n 1)"
    if [ -n "$retry_after" ]; then
      printf 'RB_RALPH_RETRY_AFTER: %s\n' "$retry_after"
    fi
    rm -f "$output"
    return 75
  fi

  rm -f "$output"
  return "$provider_rc"
}

rb_run_provider_telemetry() {
  local helper="$1" provider="$2" model="$3" effort="$4" telemetry_file="$5"
  shift 5
  local output provider_rc retry_after normalized
  output="$(mktemp)"
  normalized="$(mktemp)"

  set +e
  "$@" 2>&1 | tee "$output"
  provider_rc="${PIPESTATUS[0]}"
  set -e

  if node "$helper" "$provider" "$output" "$telemetry_file" "${model:-unknown}" "${effort:-default}" > "$normalized" 2>&1; then
    cat "$normalized"
  else
    cat "$output"
    printf 'WARNING: RB Ralph could not normalize %s usage telemetry\n' "$provider" >&2
  fi

  if [ "$provider_rc" -ne 0 ] && rb_output_is_rate_limited "$provider" "$output"; then
    printf 'RB_RALPH_PROVIDER_STATUS: RATE_LIMIT\n'
    retry_after="$(sed -nE 's/.*[Rr]etry (after|in) ([0-9]+) ?(seconds|second|secs|sec|s).*/\2/p' "$output" | tail -n 1)"
    if [ -n "$retry_after" ]; then
      printf 'RB_RALPH_RETRY_AFTER: %s\n' "$retry_after"
    fi
    rm -f "$output" "$normalized"
    return 75
  fi

  rm -f "$output" "$normalized"
  return "$provider_rc"
}
