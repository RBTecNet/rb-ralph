#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");

function read(path) {
  return readFileSync(path, "utf8");
}

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

const [changedPath, validationPath, agentPath, outputPath] = process.argv.slice(2);
if (!changedPath || !validationPath || !agentPath || !outputPath) {
  throw new Error("Usage: evidence-index.cjs <changes.json> <validation.log> <agent.log> <output.json>");
}
const changedSource = read(changedPath);
const validationSource = read(validationPath);
const agentSource = read(agentPath);
const changed = JSON.parse(changedSource);
const paths = ["added", "modified", "deleted"].flatMap((kind) =>
  (changed[kind] ?? []).map((path) => ({ kind, path })),
);
const validations = [];
let current = null;
for (const line of validationSource.split(/\r?\n/)) {
  const command = /^\[([^\]]+)\] command: (.*)$/.exec(line);
  if (command) {
    current = { taskId: command[1], command: command[2], exitCode: null, durationSeconds: null };
    validations.push(current);
    continue;
  }
  const exit = /^\[([^\]]+)\] exit=(\d+)(?: duration_seconds=(\d+))?$/.exec(line);
  if (exit) {
    const row = [...validations].reverse().find((entry) => entry.taskId === exit[1] && entry.exitCode === null);
    if (row) {
      row.exitCode = Number(exit[2]);
      row.durationSeconds = exit[3] ? Number(exit[3]) : null;
    }
  }
}
const result = {
  schema: "rb-ralph-evidence-index/v1",
  changedPaths: { total: paths.length, entries: paths.slice(0, 200), omitted: Math.max(0, paths.length - 200) },
  executor: {
    path: agentPath,
    bytes: Buffer.byteLength(agentSource),
    sha256: digest(agentSource),
    exitMarkers: agentSource.split(/\r?\n/).filter((line) =>
      /^(?:RB_RALPH_EXECUTOR_STATUS|RB_RALPH_PROCESS_STATUS|RB_RALPH_TIMEOUT_KIND|RB_RALPH_PROVIDER_STATUS):/.test(line),
    ).slice(-20),
  },
  validation: {
    path: validationPath,
    bytes: Buffer.byteLength(validationSource),
    sha256: digest(validationSource),
    commands: validations,
    manual: validationSource.split(/\r?\n/).filter((line) => /^\[[^\]]+\] (?:manual|human):/.test(line)).slice(0, 100),
  },
  changedPathsEvidence: { path: changedPath, bytes: Buffer.byteLength(changedSource), sha256: digest(changedSource) },
  rawEvidencePolicy: "Open a full raw log only for a concrete unresolved matrix row; cite its path and bounded excerpt.",
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
