#!/usr/bin/env node
"use strict";

/**
 * Count what a provider call actually did, not just what it spent.
 *
 * Token totals alone hide the shape of a call. One observed task reported
 * 1.52M input tokens against neighbours at ~500k, and only reading its raw log
 * revealed the difference: 34 shell commands instead of ~20. Without that
 * count an operator cannot tell a genuinely large task from an agent stuck in
 * a rediscovery loop, which is the failure this exists to make visible.
 *
 * Deliberately outside `rb-ralph-usage/v1`: that contract is versioned and
 * consumed by other tools, so activity is reported on its own channel rather
 * than by growing a shape someone else parses.
 *
 * Provider formats differ, so recognition is explicit and partial by design. A
 * log this cannot read is reported as unmeasured — never as zero, which would
 * read as "the agent ran no commands".
 */

const fs = require("node:fs");

const CONTRACT = "rb-ralph-activity/v1";

/** Event shapes that mean "the agent ran a tool", per known provider stream. */
function classify(event) {
  if (!event || typeof event !== "object") return undefined;
  // Codex: {"type":"item.completed","item":{"type":"command_execution"}}
  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const kind = event.item.item_type || event.item.type;
    if (kind === "command_execution") return "command";
    if (kind === "file_change") return "edit";
    if (kind === "agent_message") return "message";
    return undefined;
  }
  // Claude / OpenCode stream-json: assistant turns carrying tool_use blocks.
  if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
    return event.message.content.some((part) => part && part.type === "tool_use") ? "command" : "message";
  }
  if (event.type === "tool_use" || event.type === "tool.start" || event.type === "tool_call") return "command";
  return undefined;
}

function summarize(logPath) {
  let source;
  try {
    source = fs.readFileSync(logPath, "utf8");
  } catch {
    return { contract: CONTRACT, measured: false, reason: "log unavailable" };
  }
  const counts = { command: 0, edit: 0, message: 0 };
  let recognized = 0;
  let parsed = 0;
  let compactionObserved = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    parsed += 1;
    const eventType = String(event.type ?? event.event ?? "");
    if (/compact/i.test(eventType) || event.context_compaction === true || event.compacted === true) {
      compactionObserved = true;
    }
    const kind = classify(event);
    if (!kind) continue;
    recognized += 1;
    counts[kind] += 1;
  }
  if (!parsed) return { contract: CONTRACT, measured: false, reason: "provider log carries no structured events" };
  if (!recognized) return { contract: CONTRACT, measured: false, reason: "structured events are not a recognized provider shape" };
  return {
    contract: CONTRACT,
    measured: true,
    commands: counts.command,
    edits: counts.edit,
    messages: counts.message,
    events: parsed,
    providerLogBytes: Buffer.byteLength(source),
    contextCompactionObserved: compactionObserved,
  };
}

/** One TSV row for the run summary; unmeasured stays visibly unmeasured. */
function row(label, activity) {
  return activity.measured
    ? `ACTIVITY\t${label}\t${activity.commands}\t${activity.edits}\t${activity.messages}\t${activity.events}\t${activity.providerLogBytes}\t${activity.contextCompactionObserved}\n`
    : `ACTIVITY\t${label}\tunmeasured\tunmeasured\tunmeasured\t${activity.reason.replace(/\s+/g, " ")}\n`;
}

if (require.main === module) {
  const [logPath, label, target] = process.argv.slice(2);
  if (!logPath || !label) {
    process.stderr.write("usage: agent-activity.cjs <agent-log> <label> [append-target]\n");
    process.exit(64);
  }
  const line = row(label, summarize(logPath));
  try {
    if (target) fs.appendFileSync(target, line);
    else process.stdout.write(line);
  } catch {
    // Observability must never fail a run.
  }
}

module.exports = { summarize, row, classify, CONTRACT };
