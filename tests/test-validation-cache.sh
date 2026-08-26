#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/lib/validation-cache.cjs"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

PASS=0
ok() { PASS=$((PASS + 1)); printf 'ok %s - %s\n' "$PASS" "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
assert_contains() { grep -Fq "$2" "$1" || fail "$3"; ok "$3"; }

cat > "$TEMP_ROOT/tasks.json" <<'JSON'
[
  {"id":"T001","done":false,"scope":"`src/a/`, `tests/a/`","dependsOn":[]},
  {"id":"T002","done":false,"scope":"`src/b/`, `tests/b/`","dependsOn":[]},
  {"id":"T003","done":false,"scope":"`src/c/**`","dependsOn":[]}
]
JSON
cat > "$TEMP_ROOT/validations.json" <<'JSON'
[
  {"taskId":"T001","kind":"command","value":"test-a"},
  {"taskId":"T002","kind":"command","value":"test-b"},
  {"taskId":"T003","kind":"command","value":"test-b"}
]
JSON
cat > "$TEMP_ROOT/changes-a.json" <<'JSON'
{"added":[],"modified":["src/a/button.css"],"deleted":[],"limitations":[]}
JSON

node "$HELPER" select "$TEMP_ROOT/tasks.json" "$TEMP_ROOT/validations.json" \
  "$TEMP_ROOT/changes-a.json" "$TEMP_ROOT/cache.json" > "$TEMP_ROOT/first.tsv"
assert_contains "$TEMP_ROOT/first.tsv" $'meta\timpact\taffected' "bounded scopes select affected mode"
[ "$(grep -c $'\tcommand\ttest-b\t' "$TEMP_ROOT/first.tsv")" -eq 1 ] \
  || fail "identical commands are deduplicated across tasks"
ok "identical commands are deduplicated across tasks"

key_a="$(awk -F '\t' '$3 == "test-a" { print $5 }' "$TEMP_ROOT/first.tsv")"
key_b="$(awk -F '\t' '$3 == "test-b" { print $5 }' "$TEMP_ROOT/first.tsv")"
node "$HELPER" record "$TEMP_ROOT/cache.json" "$key_a" T001 command test-a 0 first.log
node "$HELPER" record "$TEMP_ROOT/cache.json" "$key_b" T002,T003 command test-b 0 first.log
node "$HELPER" select "$TEMP_ROOT/tasks.json" "$TEMP_ROOT/validations.json" \
  "$TEMP_ROOT/changes-a.json" "$TEMP_ROOT/cache.json" > "$TEMP_ROOT/retry.tsv"
assert_contains "$TEMP_ROOT/retry.tsv" $'T001\tcommand\ttest-a\trun' "affected task validation is rerun"
assert_contains "$TEMP_ROOT/retry.tsv" $'T002,T003\tcommand\ttest-b\treuse' "unaffected successful validation is reused"

cat > "$TEMP_ROOT/changes-unknown.json" <<'JSON'
{"added":["outside/declared-scope.txt"],"modified":[],"deleted":[],"limitations":[]}
JSON
node "$HELPER" select "$TEMP_ROOT/tasks.json" "$TEMP_ROOT/validations.json" \
  "$TEMP_ROOT/changes-unknown.json" "$TEMP_ROOT/cache.json" > "$TEMP_ROOT/fallback.tsv"
assert_contains "$TEMP_ROOT/fallback.tsv" $'meta\timpact\tfull' "unknown impact falls back to full validation"
[ "$(grep -c $'\trun\t' "$TEMP_ROOT/fallback.tsv")" -eq 2 ] \
  || fail "full fallback invalidates every unique command"
ok "full fallback invalidates every unique command"

printf '1..%s\n' "$PASS"
