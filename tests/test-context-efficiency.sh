#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/lib/context-efficiency.cjs"
SUPERVISOR="$ROOT/lib/process-supervisor.cjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rb-ralph-context-efficiency.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
failures=0

check() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$file"; then printf 'PASS %s\n' "$label"
  else printf 'FAIL %s (missing: %s)\n' "$label" "$needle"; failures=$((failures + 1)); fi
}

printf '%040000d' 0 > "$WORK/prompt.txt"
cat > "$WORK/provider.log" <<'LOG'
{"type":"thread.started","thread_id":"fresh-thread"}
{"type":"item.completed","item":{"type":"command_execution","command":"rg symbol","exit_code":0}}
{"type":"item.completed","item":{"type":"file_change"}}
{"type":"item.completed","item":{"type":"agent_message","text":"done"}}
{"type":"context.compacted"}
{"type":"turn.completed","usage":{"input_tokens":3311642,"cached_input_tokens":3187456,"output_tokens":27243,"total_tokens":3338885}}
LOG
cat > "$WORK/usage.json" <<'JSON'
{
  "schema": "rb-ralph-usage/v1",
  "provider": "codex",
  "model": "gpt-test",
  "effort": "high",
  "role": "agent",
  "phaseId": "P08",
  "taskId": "T041",
  "attempt": 1,
  "measured": true,
  "inputTokens": 3311642,
  "cachedInputTokens": 3187456,
  "outputTokens": 27243,
  "totalTokens": 3338885,
  "inputIncludesCached": true,
  "usageSource": "provider-final-event",
  "contextCompactionObserved": true
}
JSON

node "$HELPER" record "$WORK/prompt.txt" "$WORK/provider.log" "$WORK/usage.json" "$WORK/records/P08-T041.json"
node "$HELPER" summary "$WORK/records" "$WORK/summary.tsv"
check "record publishes the additive efficiency contract" "$WORK/records/P08-T041.json" '"contract": "rb-ralph-context-efficiency/v1"'
check "record distinguishes the initial prompt bytes" "$WORK/records/P08-T041.json" '"promptBytes": 40000'
check "record preserves cumulative provider input" "$WORK/records/P08-T041.json" '"providerInputTokens": 3311642'
check "record derives uncached input without double counting cache" "$WORK/records/P08-T041.json" '"derivedUncachedInputTokens": 124186'
check "record combines commands, edits, messages, and events" "$WORK/records/P08-T041.json" '"commandCount": 1'
check "record exposes provider log bytes" "$WORK/records/P08-T041.json" '"providerLogBytes":'
check "record exposes provider compaction" "$WORK/records/P08-T041.json" '"contextCompactionObserved": true'
check "summary exposes per-call operational ranking input" "$WORK/summary.tsv" $'CALL\tprovider\tP08\tT041'

cat > "$WORK/tasks.json" <<'TASKS'
[
  {"id":"T001","done":false,"scope":"`src/shared/`","dependsOn":[]},
  {"id":"T002","done":false,"scope":"`src/consumer/`","dependsOn":["T001"]}
]
TASKS
cat > "$WORK/retry-audit.json" <<'AUDIT'
{
  "expected":[
    {"id":"T001","kind":"task","parent":""},
    {"id":"T002","kind":"task","parent":""},
    {"id":"AC-T002-01","kind":"criterion","parent":"T002"}
  ],
  "rows":[{"id":"AC-T002-01","status":"FAIL"}],
  "findings":[{"criteria":"AC-T002-01","boundary":"src/shared/policy.ts"}]
}
AUDIT
node "$ROOT/lib/manager-audit.cjs" retry-selection "$WORK/tasks.json" "$WORK/retry-audit.json" > "$WORK/retry-selection.json"
check "dependent finding selects the cited task" "$WORK/retry-selection.json" '"T002"'
if grep -qF -- '"T001"' "$WORK/retry-selection.json"; then
  printf 'FAIL manager boundary prose expanded retry authority to T001\n'
  failures=$((failures + 1))
else
  printf 'PASS manager boundary prose cannot expand retry authority to T001\n'
fi

cat > "$WORK/unmapped-audit.json" <<'AUDIT'
{"expected":[],"rows":[{"id":"RF-999","status":"FAIL"}],"findings":[{"criteria":"RF-999","boundary":"unknown boundary"}]}
AUDIT
unmapped_rc=0
node "$ROOT/lib/manager-audit.cjs" retry-selection "$WORK/tasks.json" "$WORK/unmapped-audit.json" > "$WORK/unmapped-selection.json" || unmapped_rc=$?
if [ "$unmapped_rc" -eq 3 ]; then printf 'PASS unmapped finding requests an explicit conservative fallback\n'
else printf 'FAIL unmapped finding exit=%s, expected 3\n' "$unmapped_rc"; failures=$((failures + 1)); fi
check "unmapped finding is never guessed as a task" "$WORK/unmapped-selection.json" '"fallback": true'

cat > "$WORK/unknown-finding-manager.log" <<'MANAGER'
RB_RALPH_AUDIT_STATUS: COMPLETE
RB_RALPH_CRITERION: T001 | FAIL | current task evidence fails
RB_RALPH_CRITERION: AC-T001-01 | FAIL | current criterion evidence fails
RB_RALPH_FINDING: T001,AC-T001-01,T999 | src/ | declared behavior | observed failure | canonical evidence
RB_RALPH_DECISION: RETRY
RB_RALPH_REASON: retry
MANAGER
unknown_finding_rc=0
node "$ROOT/lib/manager-audit.cjs" validate \
  "$ROOT/tests/fixtures/execution/valid/minimal/PHASES.md" \
  "$WORK/unknown-finding-manager.log" > "$WORK/unknown-finding-audit.json" || unknown_finding_rc=$?
if [ "$unknown_finding_rc" -eq 3 ]; then printf 'PASS unknown finding IDs are rejected as implementation authority\n'
else printf 'FAIL unknown finding ID exit=%s, expected 3\n' "$unknown_finding_rc"; failures=$((failures + 1)); fi
check "unknown finding ID is reported explicitly" "$WORK/unknown-finding-audit.json" 'unknown finding criteria: T999'

printf '\n' > "$WORK/input.txt"
cat > "$WORK/provider" <<'PROVIDER'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"rg one","exit_code":0}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"complete"}}'
PROVIDER
chmod +x "$WORK/provider"
node "$SUPERVISOR" --input "$WORK/input.txt" --output "$WORK/soft.log" --status "$WORK/soft.json" \
  --idle-timeout 0 --first-output-timeout 0 --timeout 0 --grace 1 \
  --soft-command-limit 1 --soft-output-bytes 1 --hard-command-limit 0 --hard-output-bytes 0 \
  --label executor -- "$WORK/provider"
check "soft limit preserves the raw structured stream" "$WORK/soft.log" '"type":"item.completed"'
check "soft limit publishes a warning without failing" "$WORK/soft.json" 'soft command limit reached'
check "live status publishes command counters" "$WORK/soft.json" '"commandCount":1'

hard_rc=0
node "$SUPERVISOR" --input "$WORK/input.txt" --output "$WORK/hard.log" --status "$WORK/hard.json" \
  --idle-timeout 0 --first-output-timeout 0 --timeout 0 --grace 1 \
  --soft-command-limit 0 --soft-output-bytes 0 --hard-command-limit 1 --hard-output-bytes 0 \
  --label executor -- "$WORK/provider" || hard_rc=$?
if [ "$hard_rc" -eq 125 ]; then printf 'PASS hard limit uses the recoverable pause exit\n'
else printf 'FAIL hard limit exit=%s, expected 125\n' "$hard_rc"; failures=$((failures + 1)); fi
check "hard limit records a recoverable pause marker" "$WORK/hard.log" 'RB_RALPH_PROCESS_STATUS: CONTEXT_LIMIT_PAUSE'
check "hard limit status is paused" "$WORK/hard.json" '"state":"paused"'

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'test-context-efficiency: all checks passed\n'
else
  printf 'test-context-efficiency: %s check(s) failed\n' "$failures"
  exit 1
fi
