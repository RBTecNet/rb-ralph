#!/usr/bin/env bash
set -euo pipefail
export RB_RALPH_CUSTOM_MANAGER_CAPABILITY=observational-v1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT="$ROOT/lib/manager-audit.cjs"
CACHE="$ROOT/lib/validation-cache.cjs"
RALPH="$ROOT/bin/rb-ralph"
CLI="$ROOT/core/rb-harness.cjs"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); printf 'ok %s - %s\n' "$PASS" "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
expect_reject() { "$@" >/dev/null 2>&1 && fail "$2" || ok "$2"; }

cat > "$TEMP_ROOT/PHASES.md" <<'EOF'
## Phase 1: Evidence
**Phase ID:** P01
- [ ] T001 — Preserve proof
  - **Acceptance criteria:**
    - AC-T001-01: Proof is valid.
EOF

cat > "$TEMP_ROOT/multiple.log" <<'EOF'
RB_RALPH_AUDIT_STATUS: COMPLETE
RB_RALPH_CRITERION: T001 | PASS | source
RB_RALPH_CRITERION: AC-T001-01 | PASS | validation
RB_RALPH_DECISION: COMPLETE
RB_RALPH_DECISION: RETRY
RB_RALPH_REASON: contradictory decision
EOF
if node "$AUDIT" validate "$TEMP_ROOT/PHASES.md" "$TEMP_ROOT/multiple.log" >/dev/null 2>&1; then fail "multiple manager decisions were accepted"; fi
ok "multiple manager decisions are rejected by the canonical parser"

cat > "$TEMP_ROOT/na.log" <<'EOF'
RB_RALPH_AUDIT_STATUS: COMPLETE
RB_RALPH_CRITERION: T001 | NOT_APPLICABLE | no proof
RB_RALPH_CRITERION: AC-T001-01 | NOT_APPLICABLE | no proof
RB_RALPH_DECISION: COMPLETE
RB_RALPH_REASON: bypass
EOF
if node "$AUDIT" validate "$TEMP_ROOT/PHASES.md" "$TEMP_ROOT/na.log" >/dev/null 2>&1; then fail "all NOT_APPLICABLE completed"; fi
ok "declared criteria cannot use NOT_APPLICABLE as a COMPLETE escape"

cat > "$TEMP_ROOT/retry.log" <<'EOF'
RB_RALPH_AUDIT_STATUS: COMPLETE
RB_RALPH_CRITERION: T001 | PASS | source
RB_RALPH_CRITERION: AC-T001-01 | FAIL | canonical failure
RB_RALPH_FINDING: AC-T001-01 | src/proof | valid proof | missing proof | validation.log
RB_RALPH_DECISION: RETRY
RB_RALPH_REASON: repair proof
EOF
node "$AUDIT" validate "$TEMP_ROOT/PHASES.md" "$TEMP_ROOT/retry.log" > "$TEMP_ROOT/retry.json"
printf '%s\n' $'finding_id\tphase_id\topened_attempt\tstatus\treason\topened_evidence_sha256\tresolved_attempt\tresolved_evidence_sha256\tfinding_key\tcriteria\tlatest_reason\tlatest_evidence_sha256\tlast_seen_attempt' > "$TEMP_ROOT/findings.tsv"
node "$AUDIT" reconcile "$TEMP_ROOT/findings.tsv" "$TEMP_ROOT/retry.json" P01 1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/dev/null
finding_id="$(awk -F '\t' 'NR == 2 { print $1 }' "$TEMP_ROOT/findings.tsv")"
cat > "$TEMP_ROOT/complete-omits.log" <<'EOF'
RB_RALPH_AUDIT_STATUS: COMPLETE
RB_RALPH_CRITERION: T001 | PASS | source
RB_RALPH_CRITERION: AC-T001-01 | PASS | fresh validation
RB_RALPH_DECISION: COMPLETE
RB_RALPH_REASON: omitted old finding
EOF
node "$AUDIT" validate "$TEMP_ROOT/PHASES.md" "$TEMP_ROOT/complete-omits.log" > "$TEMP_ROOT/complete-omits.json"
node "$AUDIT" reconcile "$TEMP_ROOT/findings.tsv" "$TEMP_ROOT/complete-omits.json" P01 2 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb >/dev/null
awk -F '\t' -v id="$finding_id" '$1 == id && $4 == "open" { found=1 } END { exit(found ? 0 : 1) }' "$TEMP_ROOT/findings.tsv" || fail "omitted finding closed"
ok "finding omission does not close a stable open finding"

cat > "$TEMP_ROOT/complete-resolves.log" <<EOF
RB_RALPH_AUDIT_STATUS: COMPLETE
RB_RALPH_CRITERION: T001 | PASS | source
RB_RALPH_CRITERION: AC-T001-01 | PASS | fresh validation
RB_RALPH_FINDING_RESOLUTION: $finding_id | validation.log at new sealed state
RB_RALPH_DECISION: COMPLETE
RB_RALPH_REASON: proof repaired
EOF
node "$AUDIT" validate "$TEMP_ROOT/PHASES.md" "$TEMP_ROOT/complete-resolves.log" > "$TEMP_ROOT/complete-resolves.json"
node "$AUDIT" reconcile "$TEMP_ROOT/findings.tsv" "$TEMP_ROOT/complete-resolves.json" P01 3 cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc >/dev/null
awk -F '\t' -v id="$finding_id" '$1 == id && $4 == "resolved" && $8 ~ /^c+$/ { found=1 } END { exit(found ? 0 : 1) }' "$TEMP_ROOT/findings.tsv" || fail "specific new proof did not close finding"
ok "a named finding resolution with new canonical evidence closes it"

cat > "$TEMP_ROOT/tasks.json" <<'EOF'
[{"id":"T001","done":false,"scope":"`src/`","dependsOn":[]},{"id":"T002","done":false,"scope":"`tests/`","dependsOn":[]}]
EOF
cat > "$TEMP_ROOT/validations.json" <<'EOF'
[{"taskId":"T001","kind":"command","value":"test"},{"taskId":"T002","kind":"command","value":"other"}]
EOF
printf '%s\n' '{"added":[],"modified":["src/a.js"],"deleted":[],"limitations":[]}' > "$TEMP_ROOT/changes.json"
node "$CACHE" select "$TEMP_ROOT/tasks.json" "$TEMP_ROOT/validations.json" "$TEMP_ROOT/changes.json" "$TEMP_ROOT/cache.json" seal-one > "$TEMP_ROOT/select.tsv"
cache_key="$(awk -F '\t' '$3 == "other" { print $5 }' "$TEMP_ROOT/select.tsv")"
node "$CACHE" record "$TEMP_ROOT/cache.json" "$cache_key" T002 command other 0 proof.log seal-one
node "$CACHE" select "$TEMP_ROOT/tasks.json" "$TEMP_ROOT/validations.json" "$TEMP_ROOT/changes.json" "$TEMP_ROOT/cache.json" seal-one > "$TEMP_ROOT/reuse.tsv"
grep -Fq $'T002\tcommand\tother\treuse' "$TEMP_ROOT/reuse.tsv" || fail "safe cache reuse was lost"
ok "green cache evidence is reusable for the same sealed state"
node "$CACHE" select "$TEMP_ROOT/tasks.json" "$TEMP_ROOT/validations.json" "$TEMP_ROOT/changes.json" "$TEMP_ROOT/cache.json" seal-two > "$TEMP_ROOT/stale.tsv"
grep -Fq $'T002\tcommand\tother\trun' "$TEMP_ROOT/stale.tsv" || fail "stale cache was reused"
ok "a changed validation state seal rejects stale green cache evidence"

# Exercise the real G2 path: the executor replaces a declared validation
# script with a green no-op.  The command is rerun, but the same attempt still
# cannot become COMPLETE; the next attempt must supply fresh state and an
# explicit resolution of the orchestrator finding.
PROJECT="$TEMP_ROOT/infrastructure-project"
mkdir -p "$PROJECT/.rb/init"
node "$CLI" project init "$PROJECT" --name evidence --id evidence >/dev/null
cp "$ROOT/tests/fixtures/execution/valid/minimal/PHASES.md" "$PROJECT/.rb/init/PHASES.md"
sed -i 's#`src/`, `tests/`#`src/`, `tests/`#; s#`npm test`#`bash tests/validate.sh`#' "$PROJECT/.rb/init/PHASES.md"
node "$CLI" manifest sync "$PROJECT" >/dev/null
cat > "$TEMP_ROOT/infrastructure-agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
count_file="${TEST_EVIDENCE_STATE:?}/agent-count"
count=0; [ ! -f "$count_file" ] || count="$(cat "$count_file")"; count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
if [ "$count" -eq 1 ]; then mkdir -p tests; printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > tests/validate.sh; chmod +x tests/validate.sh; fi
printf '%s\n' 'RB_RALPH_EXECUTOR_RESULT: {"contract":"rb-ralph-executor-completion/v1","status":"completed"}'
EOF
cat > "$TEMP_ROOT/infrastructure-manager" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf '%s\n' 'RB_RALPH_AUDIT_STATUS: COMPLETE' 'RB_RALPH_CRITERION: T001 | PASS | current source' 'RB_RALPH_CRITERION: AC-T001-01 | PASS | canonical validation'
if [ "${RB_RALPH_ATTEMPT:?}" -gt 1 ]; then printf '%s\n' 'RB_RALPH_FINDING_RESOLUTION: F-P01-A001 | rerun validation at the current sealed product state'; fi
printf '%s\n' 'RB_RALPH_DECISION: COMPLETE' 'RB_RALPH_REASON: manager review complete'
EOF
chmod +x "$TEMP_ROOT/infrastructure-agent" "$TEMP_ROOT/infrastructure-manager"
mkdir -p "$TEMP_ROOT/evidence-state"
TEST_EVIDENCE_STATE="$TEMP_ROOT/evidence-state" RB_RALPH_EXECUTION_UNIT=task RB_RALPH_FINAL_AUDIT=0 \
  "$RALPH" --project "$PROJECT" --validation-mode run --manager-audit exhaustive --manager-retries 0 \
  --agent-cmd "$TEMP_ROOT/infrastructure-agent" --manager-cmd "$TEMP_ROOT/infrastructure-manager" > "$TEMP_ROOT/infrastructure.out"
events="$(find "$PROJECT/.rb/runs" -name events.tsv -print -quit)"
grep -Fq $'P01\t1\tRETRY\tvalidation mechanism changed' "$events" || fail "changed validation infrastructure completed in the same attempt"
find "$PROJECT/.rb/runs" -name '*validation.log' -type f -exec grep -Fq 'validation_mechanism_changed=1' {} + \
  || fail "G2 did not record changed validation infrastructure"
[ "$(cat "$TEMP_ROOT/evidence-state/agent-count")" = 2 ] || fail "changed validation infrastructure did not require a fresh attempt"
ok "real G2 rejects same-attempt green proof after validation infrastructure changes"

printf '1..%s\n' "$PASS"
