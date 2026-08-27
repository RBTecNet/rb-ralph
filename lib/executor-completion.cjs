#!/usr/bin/env node
"use strict";

// The executor's final response is advisory, but its invocation outcome must
// have one canonical interpretation regardless of adapter/provider type.
const { readFileSync, writeFileSync } = require("node:fs");

const CONTRACT = "rb-ralph-executor-completion/v1";

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(2);
}

function terminalCompletion(source) {
  const lines = source.split(/\r?\n/).filter((line) => line.trim() !== "");
  const last = lines.at(-1) || "";
  const match = /^RB_RALPH_EXECUTOR_RESULT: (\{.*\})$/.exec(last);
  if (!match) return false;
  try {
    const value = JSON.parse(match[1]);
    return value && value.contract === CONTRACT && value.status === "completed"
      && Object.keys(value).every((key) => key === "contract" || key === "status");
  } catch {
    return false;
  }
}

function classify(logPath, rawExitCode, changedCount) {
  const source = readFileSync(logPath, "utf8");
  const exitCode = Number(rawExitCode);
  let status;
  let reason;
  if (/^RB_RALPH_PROCESS_STATUS: TIMEOUT$/m.test(source)) {
    status = "timeout";
    reason = "process supervisor recorded timeout";
  } else if (exitCode === 75 || /^RB_RALPH_PROVIDER_STATUS: RATE_LIMIT$/m.test(source)) {
    status = "rate_limited";
    reason = "provider rate limit";
  } else if (!Number.isInteger(exitCode) || exitCode !== 0) {
    status = "failed";
    reason = `executor exit code ${rawExitCode}`;
  } else if (terminalCompletion(source)) {
    status = "completed";
    reason = "terminal structured adapter result";
  } else if (Number(changedCount) > 0) {
    // A successful call with a product delta is a completed invocation, not
    // accepted work. G1/G2/G3 still independently decide acceptance.
    status = "completed";
    reason = "successful invocation with observable product delta";
  } else {
    status = "incomplete";
    reason = "clean exit without a terminal structured completion result or product delta";
  }
  return { contract: CONTRACT, status, reason, exitCode, changedPaths: Number(changedCount) || 0 };
}

const [command, logPath, exitCode, changedCount, outputPath] = process.argv.slice(2);
if (command !== "classify" || !logPath || exitCode === undefined || changedCount === undefined) {
  fail("Usage: executor-completion.cjs classify <agent.log> <exit-code> <changed-path-count> [output.json]");
}
const result = classify(logPath, exitCode, changedCount);
const encoded = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) writeFileSync(outputPath, encoded, { mode: 0o600 });
else process.stdout.write(encoded);
