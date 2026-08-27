#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { summarize } = require("./agent-activity.cjs");

const CONTRACT = "rb-ralph-context-efficiency/v1";
const HIGH_INPUT_TOKENS = 500_000;
const MANY_COMMANDS = 20;
const LARGE_LOG_BYTES = 256 * 1024;

function readJson(target, fallback) {
  try { return JSON.parse(fs.readFileSync(target, "utf8")); } catch { return fallback; }
}

function statBytes(target) {
  try { return fs.statSync(target).size; } catch { return 0; }
}

function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function derivedUncached(usage) {
  if (!usage?.measured) return null;
  const input = finite(usage.inputTokens);
  const cached = finite(usage.cachedInputTokens);
  return usage.inputIncludesCached === false ? input : Math.max(0, input - cached);
}

function warnings(record) {
  const values = [];
  if (record.measured && record.providerInputTokens >= HIGH_INPUT_TOKENS) {
    values.push("high-cumulative-input");
  }
  if (record.commandCount !== null && record.commandCount >= MANY_COMMANDS && !record.editCount) {
    values.push("many-commands-without-edits");
  }
  if (record.providerLogBytes >= LARGE_LOG_BYTES) values.push("large-provider-log");
  return values;
}

function makeRecord(promptPath, logPath, usagePath) {
  const usage = readJson(usagePath, {});
  const activity = summarize(logPath);
  const measured = usage.schema === "rb-ralph-usage/v1" && usage.measured === true;
  const promptBytes = statBytes(promptPath);
  const record = {
    contract: CONTRACT,
    callId: path.basename(logPath, path.extname(logPath)),
    provider: usage.provider ?? "unknown",
    model: usage.model ?? "unknown",
    effort: usage.effort ?? "default",
    role: usage.role ?? "unknown",
    phaseId: usage.phaseId ?? "unknown",
    taskId: usage.taskId ?? null,
    attempt: finite(usage.attempt),
    measured,
    promptBytes,
    estimatedInitialPromptTokens: Math.ceil(promptBytes / 4),
    providerInputTokens: measured ? finite(usage.inputTokens) : null,
    cachedInputTokens: measured ? finite(usage.cachedInputTokens) : null,
    derivedUncachedInputTokens: derivedUncached(usage),
    outputTokens: measured ? finite(usage.outputTokens) : null,
    totalTokens: measured ? finite(usage.totalTokens) : null,
    commandCount: activity.measured ? activity.commands : null,
    editCount: activity.measured ? activity.edits : null,
    messageCount: activity.measured ? activity.messages : null,
    structuredEventCount: activity.measured ? activity.events : null,
    providerLogBytes: statBytes(logPath),
    contextCompactionObserved: usage.contextCompactionObserved === true
      || activity.contextCompactionObserved === true,
    usageSource: usage.usageSource ?? "unavailable",
  };
  record.warnings = warnings(record);
  return record;
}

function clean(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ");
}

function summary(directory) {
  const records = [];
  for (const name of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!name.isFile() || !name.name.endsWith(".json")) continue;
    const value = readJson(path.join(directory, name.name), null);
    if (value?.contract === CONTRACT) records.push(value);
  }
  const measured = records.filter((record) => record.measured);
  const total = (field) => records.reduce((sum, record) => sum + finite(record[field]), 0);
  const rows = [
    `EFFICIENCY\tcalls\t${records.length}`,
    `EFFICIENCY\tmeasuredCalls\t${measured.length}`,
    `EFFICIENCY\tpromptBytes\t${total("promptBytes")}`,
    `EFFICIENCY\tproviderInputTokens\t${total("providerInputTokens")}`,
    `EFFICIENCY\tcachedInputTokens\t${total("cachedInputTokens")}`,
    `EFFICIENCY\tderivedUncachedInputTokens\t${total("derivedUncachedInputTokens")}`,
    `EFFICIENCY\toutputTokens\t${total("outputTokens")}`,
    `EFFICIENCY\tcommandCount\t${total("commandCount")}`,
    `EFFICIENCY\teditCount\t${total("editCount")}`,
    `EFFICIENCY\tproviderLogBytes\t${total("providerLogBytes")}`,
    `EFFICIENCY\tcontextCompactionCalls\t${records.filter((record) => record.contextCompactionObserved).length}`,
  ];
  for (const record of records) {
    rows.push([
      "CALL", clean(record.callId), clean(record.phaseId), clean(record.taskId || "phase"),
      record.attempt, clean(record.role), clean(record.provider), clean(record.model),
      record.measured, record.promptBytes, record.providerInputTokens ?? "unmeasured",
      record.cachedInputTokens ?? "unmeasured", record.derivedUncachedInputTokens ?? "unmeasured",
      record.outputTokens ?? "unmeasured", record.commandCount ?? "unmeasured",
      record.editCount ?? "unmeasured", record.messageCount ?? "unmeasured",
      record.providerLogBytes, record.contextCompactionObserved, record.warnings.join(","),
    ].join("\t"));
  }
  const phases = new Map();
  for (const record of records) {
    const phase = phases.get(record.phaseId) ?? { calls: 0, input: 0, commands: 0, logBytes: 0 };
    phase.calls += 1;
    phase.input += finite(record.providerInputTokens);
    phase.commands += finite(record.commandCount);
    phase.logBytes += finite(record.providerLogBytes);
    phases.set(record.phaseId, phase);
  }
  for (const [phaseId, phase] of phases) {
    rows.push(["PHASE", clean(phaseId), phase.calls, phase.input, phase.commands, phase.logBytes].join("\t"));
    const repeated = records.filter((record) => record.phaseId === phaseId
      && finite(record.commandCount) >= MANY_COMMANDS && finite(record.providerLogBytes) >= LARGE_LOG_BYTES);
    if (repeated.length >= 2) rows.push(`WARNING\t${clean(phaseId)}\trepeated-neighbour-amplification\t${repeated.length}`);
  }
  return `${rows.join("\n")}\n`;
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "record" && args.length === 4) {
    atomicWrite(args[3], `${JSON.stringify(makeRecord(args[0], args[1], args[2]), null, 2)}\n`);
  } else if (command === "summary" && args.length === 2) {
    const source = fs.existsSync(args[0]) ? summary(args[0]) : "EFFICIENCY\tcalls\t0\n";
    atomicWrite(args[1], source);
  } else {
    throw new Error("Usage: context-efficiency.cjs record <prompt> <provider-log> <usage-json> <output-json> | summary <directory> <output-tsv>");
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

module.exports = { CONTRACT, makeRecord, summary, derivedUncached };
