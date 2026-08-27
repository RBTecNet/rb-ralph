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
mkdir -p "$PROJECT/src/explain" "$PROJECT/tests/explain" "$PROJECT/.rb/init" \
  "$PROJECT/internal/policy" "$PROJECT/.rb/runs/noise" "$PROJECT/.rb-harness/runs/noise" \
  "$PROJECT/.git/objects" "$PROJECT/node_modules/pkg" "$PROJECT/vendor/pkg" \
  "$PROJECT/build" "$PROJECT/logs" "$WORK/state"
printf 'export const marker = "scope-source";\n' > "$PROJECT/src/explain/linux-user.ts"
printf 'import { marker } from "../../src/explain/linux-user";\n' > "$PROJECT/tests/explain/linux-user.test.ts"
printf '# PROJECT\n\nMarker: context-document.\n' > "$PROJECT/.rb/init/PROJECT.md"
cat > "$PROJECT/.rb/init/REQUIREMENTS.md" <<'REQUIREMENTS'
# Requirements

### RF-001 — Early unrelated requirement

early-rf-001-must-not-displace-covered-sections

### RF-014 — Covered fourteen

exact-rf-014

### RF-015 — Covered fifteen

exact-rf-015

### RF-016 — Covered sixteen

exact-rf-016

### RF-017 — Covered seventeen

exact-rf-017

### RF-026 — Covered twenty-six

exact-rf-026
REQUIREMENTS
printf 'export function DecidePolicy() { return true; }\n' > "$PROJECT/internal/policy/policy.ts"
printf 'export const untouched = 1;\n' > "$PROJECT/src/unrelated.ts"
printf 'control noise\n' > "$PROJECT/.rb/runs/noise/generation.log"
printf 'harness noise\n' > "$PROJECT/.rb-harness/runs/noise/bundle.json"
printf 'git noise\n' > "$PROJECT/.git/objects/noise"
printf 'dependency noise\n' > "$PROJECT/node_modules/pkg/index.js"
printf 'vendor noise\n' > "$PROJECT/vendor/pkg/index.go"
printf 'binary\0noise' > "$PROJECT/build/product.bin"
printf 'execution noise\n' > "$PROJECT/logs/provider.log"

cat > "$WORK/state/tasks.json" <<'JSON'
[
  { "id": "T023", "title": "Produce policy", "scope": "`internal/policy/`", "done": true, "dependsOn": [] },
  { "id": "T001", "scope": "`src/explain/linux-user.ts`, `tests/explain/linux-user.test.ts`", "done": false },
  { "id": "T002", "scope": "`src/explain/missing.ts`", "done": false },
  {
    "id": "T041",
    "scope": "`src/tui/`",
    "covers": "RF-014, RF-015, RF-016, RF-017, RF-026",
    "dependsOn": ["T023"],
    "done": false
  },
  { "id": "T099", "scope": "`.rb-harness/allowed.txt`", "done": false }
]
JSON

cat > "$WORK/state/changes.json" <<'JSON'
{ "schema": "rb-ralph-changes/v1", "added": ["src/explain/linux-user.ts", "package-lock.json"], "modified": [] }
JSON

cat > "$WORK/state/before.json" <<'JSON'
{ "schema": "rb-ralph-evidence/v1", "files": {
  "src/explain/linux-user.ts": "hash", "src/unrelated.ts": "hash",
  ".rb/init/PROJECT.md": "hash", ".rb/runs/noise/generation.log": "hash",
  ".rb-harness/runs/noise/bundle.json": "hash", ".git/objects/noise": "hash",
  "node_modules/pkg/index.js": "hash", "vendor/pkg/index.go": "hash",
  "build/product.bin": "hash", "logs/provider.log": "hash" } }
JSON

cat > "$WORK/state/task.txt" <<'TXT'
**Context:**
- `.rb/init/PROJECT.md`
- `.rb/init/REQUIREMENTS.md`

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
refute "keeps .rb-harness out of the project tree listing" "$tree_block" ".rb-harness/"
refute "keeps .git out of the project tree listing" "$tree_block" ".git/"
refute "keeps dependency trees out of the project tree listing" "$tree_block" "node_modules/"
refute "keeps vendor trees out of the project tree listing" "$tree_block" "vendor/"
refute "keeps build binaries out of the project tree listing" "$tree_block" "build/product.bin"
refute "keeps provider logs out of the project tree listing" "$tree_block" "logs/provider.log"

t041="$(node "$HELPER" --root "$PROJECT" --tasks "$WORK/state/tasks.json" --task T041 \
  --before "$WORK/state/before.json" --phase-file "$WORK/state/task.txt" --max-bytes 12000)"
check "T041 receives RF-014 by exact traceability" "$t041" "exact-rf-014"
check "T041 receives RF-015 by exact traceability" "$t041" "exact-rf-015"
check "T041 receives RF-016 by exact traceability" "$t041" "exact-rf-016"
check "T041 receives RF-017 by exact traceability" "$t041" "exact-rf-017"
check "T041 receives RF-026 by exact traceability" "$t041" "exact-rf-026"
check "dependency map names the producing task" "$t041" "T023 — Produce policy"
check "dependency map lists existing scope files" "$t041" "internal/policy/policy.ts"
check "dependency map extracts deterministic public names" "$t041" "DecidePolicy"
refute "dependency map does not dump dependency implementations" "$t041" "return true"

printf 'explicitly authorized control-plane path\n' > "$PROJECT/.rb-harness/allowed.txt"
authorized="$(node "$HELPER" --root "$PROJECT" --tasks "$WORK/state/tasks.json" --task T099)"
check "explicit task scope can authorize a normally filtered path" "$authorized" "explicitly authorized control-plane path"

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
