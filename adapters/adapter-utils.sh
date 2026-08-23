#!/usr/bin/env bash

rb_run_provider() {
  local output provider_rc retry_after
  output="$(mktemp)"

  set +e
  "$@" 2>&1 | tee "$output"
  provider_rc="${PIPESTATUS[0]}"
  set -e

  if [ "$provider_rc" -ne 0 ] && grep -Eiq \
    'rate[ -]?limit|usage limit|too many requests|quota exceeded|requests per (minute|day)|tokens per minute' \
    "$output"; then
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

  if [ "$provider_rc" -ne 0 ] && grep -Eiq \
    'rate[ -]?limit|usage limit|too many requests|quota exceeded|requests per (minute|day)|tokens per minute' \
    "$output"; then
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
