#!/usr/bin/env bash
# The task table follows the unit being worked on.
#
# Reported from a real run: on a small terminal the panel showed only the first
# phases, all of them finished, while the task actually executing sat below the
# cut. The anchor searched the *rendered* text for the phase ID, but every row
# begins with a coloured box border, so the match never succeeded, findIndex
# returned -1, and the window pinned itself to the top of the table forever.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rb-ralph-dashboard-focus.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
failures=0

report() {
  local label="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then printf 'PASS %s\n' "$label"
  else printf 'FAIL %s%s\n' "$label" "${detail:+ ($detail)}"; failures=$((failures + 1)); fi
}

cat > "$WORK/focus.cjs" <<'NODE'
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[2], "utf8");
const body = src.slice(src.indexOf("function focusWindow"), src.indexOf("function tableRow"));
if (!body.includes("focusWindow")) { console.log("MISSING"); process.exit(0); }
const focusWindow = new Function(`${body}; return focusWindow;`)();

function build(perPhase, donePhases, runningPhaseIndex, runningTaskIndex) {
  const rows = [];
  perPhase.forEach((count, index) => {
    const id = `P${String(index + 1).padStart(2, "0")}`;
    const done = index < donePhases;
    rows.push({ kind: "phase", id, state: done ? "complete" : index === runningPhaseIndex ? "running" : "pending" });
    for (let t = 0; t < count; t += 1) {
      const taskId = `T${String(rows.filter((r) => r.kind === "task").length + 1).padStart(3, "0")}`;
      const state = done ? "complete" : (index === runningPhaseIndex && t === runningTaskIndex) ? "running" : "pending";
      rows.push({ kind: "task", id: taskId, phase: id, state });
    }
  });
  return rows;
}

const cases = [];
// The reported shape: 8 phases, 18 tasks, P01-P03 done, P04 running.
const rows = build([5, 1, 3, 4, 2, 1, 1, 1], 3, 3, 1);
for (const room of [4, 6, 9, 12, 26, 40]) {
  const w = focusWindow(rows, { meta: { phase: "P04" } }, room);
  const shown = rows.slice(w.start, w.start + room);
  cases.push({
    room,
    running: shown.some((r) => r.kind === "task" && r.state === "running"),
    phase: shown.some((r) => r.kind === "phase" && r.id === "P04"),
    accounted: w.hiddenAbove + shown.length + w.hiddenBelow === rows.length,
    startInRange: w.start >= 0 && w.start <= Math.max(0, rows.length - room),
  });
}
// A phase whose tasks are all pending still focuses the phase itself.
const pendingOnly = build([2, 2], 0, 1, -1);
const pw = focusWindow(pendingOnly, { meta: { phase: "P02" } }, 2);
cases.push({ room: "pending-only", phase: pendingOnly.slice(pw.start, pw.start + 2).some((r) => r.kind === "phase" && r.id === "P02") });
// The final phase must reach the bottom of the table, never past it.
const last = build([3, 3, 3], 2, 2, 2);
const lw = focusWindow(last, { meta: { phase: "P03" } }, 4);
cases.push({ room: "last-phase", running: last.slice(lw.start, lw.start + 4).some((r) => r.state === "running"), hiddenBelow: lw.hiddenBelow });
console.log(JSON.stringify(cases));
NODE

result="$(node "$WORK/focus.cjs" "$ROOT/lib/dashboard.cjs")"
if [ "$result" = "MISSING" ]; then
  printf 'FAIL focusWindow is not defined in lib/dashboard.cjs\n'
  exit 1
fi

report "running task stays visible at every terminal size" \
  "$(node -e 'const c=JSON.parse(process.argv[1]);console.log(c.filter(x=>typeof x.room==="number").every(x=>x.running)?1:0)' "$result")"
report "the enclosing phase heading stays visible" \
  "$(node -e 'const c=JSON.parse(process.argv[1]);console.log(c.filter(x=>typeof x.room==="number").every(x=>x.phase)?1:0)' "$result")"
report "every row is either shown or reported as hidden" \
  "$(node -e 'const c=JSON.parse(process.argv[1]);console.log(c.filter(x=>typeof x.room==="number").every(x=>x.accounted)?1:0)' "$result")"
report "the window never starts past the end of the table" \
  "$(node -e 'const c=JSON.parse(process.argv[1]);console.log(c.filter(x=>typeof x.room==="number").every(x=>x.startInRange)?1:0)' "$result")"
report "a phase with no running task still focuses its own row" \
  "$(node -e 'const c=JSON.parse(process.argv[1]);console.log(c.find(x=>x.room==="pending-only").phase?1:0)' "$result")"
report "the last phase reaches the bottom without overshooting" \
  "$(node -e 'const c=JSON.parse(process.argv[1]);const x=c.find(y=>y.room==="last-phase");console.log(x.running&&x.hiddenBelow===0?1:0)' "$result")"

# The defect itself: the anchor must not be recovered from rendered text.
if grep -q 'trimStart().startsWith(state.meta.phase' "$ROOT/lib/dashboard.cjs"; then
  report "the anchor no longer parses rendered rows" 0 "still matching on rendered text"
else
  report "the anchor no longer parses rendered rows" 1
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'test-dashboard-focus: all checks passed\n'
else
  printf 'test-dashboard-focus: %s check(s) failed\n' "$failures"
  exit 1
fi
