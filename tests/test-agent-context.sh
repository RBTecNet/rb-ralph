#!/usr/bin/env bash
# Pre-loaded executor and manager context.
#
# Measured motivation: on a real run the executor prompt was 3.7 KB and the
# agent then spent 445k-1520k input tokens per task, 82% of its shell commands
# rediscovering the scope, the tree, and the plan the prompt already carried.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/lib/agent-context.cjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rb-ralph-agent-context.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
failures=0

check() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf 'PASS %s\n' "$label"
  else
    printf 'FAIL %s (missing: %s)\n' "$label" "$needle"
    failures=$((failures + 1))
  fi
}

refute() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf 'FAIL %s (unexpected: %s)\n' "$label" "$needle"
    failures=$((failures + 1))
  else
    printf 'PASS %s\n' "$label"
  fi
}

PROJECT="$WORK/project"
mkdir -p "$PROJECT/src/explain" "$PROJECT/tests/explain" "$PROJECT/.rb/init" "$WORK/state"
printf 'export const marker = "scope-source";\n' > "$PROJECT/src/explain/linux-user.ts"
printf 'import { marker } from "../../src/explain/linux-user";\n' > "$PROJECT/tests/explain/linux-user.test.ts"
printf '# PROJECT\n\nMarker: context-document.\n' > "$PROJECT/.rb/init/PROJECT.md"
printf 'export const untouched = 1;\n' > "$PROJECT/src/unrelated.ts"

cat > "$WORK/state/tasks.json" <<'JSON'
[
  { "id": "T001", "scope": "`src/explain/linux-user.ts`, `tests/explain/linux-user.test.ts`", "done": false },
  { "id": "T002", "scope": "`src/explain/missing.ts`", "done": false }
]
JSON

cat > "$WORK/state/changes.json" <<'JSON'
{ "schema": "rb-ralph-changes/v1", "added": ["src/explain/linux-user.ts", "package-lock.json"], "modified": [] }
JSON

cat > "$WORK/state/before.json" <<'JSON'
{ "schema": "rb-ralph-evidence/v1", "files": {
  "src/explain/linux-user.ts": "hash", "src/unrelated.ts": "hash", ".rb/init/PROJECT.md": "hash" } }
JSON

cat > "$WORK/state/task.txt" <<'TXT'
**Context:**
- `.rb/init/PROJECT.md`

- [ ] T001 — Implement it
TXT

context="$(node "$HELPER" --root "$PROJECT" --tasks "$WORK/state/tasks.json" --task T001 \
  --changes "$WORK/state/changes.json" --before "$WORK/state/before.json" --phase-file "$WORK/state/task.txt")"

check "declares itself as resolved state, not new authority" "$context" "not new authority"
check "ships the declared scope source" "$context" "scope-source"
check "ships the declared scope test" "$context" "tests/explain/linux-user.test.ts"
check "names the scope it resolved" "$context" "Declared scope of T001"
check "lists what earlier tasks changed" "$context" "CHANGED EARLIER IN THIS PHASE"
check "ships the project tree from the snapshot" "$context" "src/unrelated.ts"
check "ships the phase context document" "$context" "context-document"
tree_block="$(printf '%s' "$context" | sed -n '/PROJECT FILES/,/^---/p')"
refute "keeps .rb out of the project tree listing" "$tree_block" ".rb/"

missing="$(node "$HELPER" --root "$PROJECT" --tasks "$WORK/state/tasks.json" --task T002)"
check "tells the agent which scope paths it must create" "$missing" "do not exist yet"

bounded="$(node "$HELPER" --root "$PROJECT" --tasks "$WORK/state/tasks.json" --task T001 \
  --before "$WORK/state/before.json" --max-bytes 200)"
check "declares what the byte budget left out" "$bounded" "context budget reached"

manager="$(node "$HELPER" --mode manager --root "$PROJECT" --changes "$WORK/state/changes.json")"
check "manager receives the changed source" "$manager" "scope-source"
check "manager knows where the bytes came from" "$manager" "at this attempt's boundary"
refute "manager is not handed a lockfile" "$manager" "package-lock.json"

empty="$(node "$HELPER" --root "$PROJECT" --tasks "$WORK/state/tasks.json" --task T404 2>/dev/null || true)"
if [ -z "$empty" ]; then printf 'PASS unknown task yields no context instead of failing\n'
else printf 'FAIL unknown task should yield nothing\n'; failures=$((failures + 1)); fi

broken="$(node "$HELPER" --root "$PROJECT" --tasks /nonexistent/tasks.json --task T001 2>/dev/null || true)"
if [ -z "$broken" ]; then printf 'PASS unreadable input degrades to no context\n'
else printf 'FAIL unreadable input must not invent context\n'; failures=$((failures + 1)); fi

escape="$(node "$HELPER" --mode manager --root "$PROJECT" --changes <(printf '{"added":["../../../etc/passwd"]}') 2>/dev/null || true)"
if [ -z "$escape" ]; then printf 'PASS a path escaping the project is refused\n'
else printf 'FAIL escaping path must never be read\n'; failures=$((failures + 1)); fi

# The installer copies a fixed list, so a new helper is silently left out and the
# launcher only fails later, at the call site. This caught exactly that.
for helper in "$ROOT"/lib/*.cjs; do
  name="$(basename "$helper")"
  if grep -q "lib/$name" "$ROOT/install.sh"; then
    printf 'PASS install.sh installs %s\n' "$name"
  else
    printf 'FAIL install.sh does not install %s\n' "$name"
    failures=$((failures + 1))
  fi
done

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'test-agent-context: all checks passed\n'
else
  printf 'test-agent-context: %s check(s) failed\n' "$failures"
  exit 1
fi
