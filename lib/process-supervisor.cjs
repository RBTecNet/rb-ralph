#!/usr/bin/env node
"use strict";

const {
  createReadStream, createWriteStream, mkdirSync, readdirSync, readFileSync,
  renameSync, writeFileSync,
} = require("node:fs");
const { spawn } = require("node:child_process");
const { dirname } = require("node:path");
const { classify } = require("./agent-activity.cjs");

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(2);
}

const options = {
  input: "",
  output: "",
  idleTimeout: 0,
  firstOutputTimeout: 0,
  timeout: 0,
  grace: 5,
  label: "provider",
  status: "",
  softCommandLimit: 0,
  softOutputBytes: 0,
  hardCommandLimit: 0,
  hardOutputBytes: 0,
};
const args = process.argv.slice(2);
let separator = args.indexOf("--");
if (separator < 0 || separator === args.length - 1) {
  fail("process-supervisor requires -- <command> [arguments]");
}
const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
for (let index = 0; index < separator; index += 1) {
  const name = args[index];
  const value = args[++index];
  if (value === undefined) fail(`${name} requires a value`);
  if (name === "--input") options.input = value;
  else if (name === "--output") options.output = value;
  else if (name === "--idle-timeout") options.idleTimeout = Number(value);
  else if (name === "--first-output-timeout") options.firstOutputTimeout = Number(value);
  else if (name === "--timeout") options.timeout = Number(value);
  else if (name === "--grace") options.grace = Number(value);
  else if (name === "--label") options.label = value;
  else if (name === "--status") options.status = value;
  else if (name === "--soft-command-limit") options.softCommandLimit = Number(value);
  else if (name === "--soft-output-bytes") options.softOutputBytes = Number(value);
  else if (name === "--hard-command-limit") options.hardCommandLimit = Number(value);
  else if (name === "--hard-output-bytes") options.hardOutputBytes = Number(value);
  else fail(`unknown process-supervisor option: ${name}`);
}

if (!options.input || !options.output) fail("--input and --output are required");
for (const [name, value] of [
  ["--idle-timeout", options.idleTimeout],
  ["--first-output-timeout", options.firstOutputTimeout],
  ["--timeout", options.timeout],
  ["--grace", options.grace],
  ["--soft-command-limit", options.softCommandLimit],
  ["--soft-output-bytes", options.softOutputBytes],
  ["--hard-command-limit", options.hardCommandLimit],
  ["--hard-output-bytes", options.hardOutputBytes],
]) {
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
}

const startedAt = Date.now();
let lastActivityAt = startedAt;
let lastOutputAt = startedAt;
let lastProcessActivityAt = 0;
let firstOutputAt = 0;
let outputBytes = 0;
let commandCount = 0;
let editCount = 0;
let messageCount = 0;
let structuredEventCount = 0;
let lastEditAt = 0;
let lastHeartbeatAt = 0;
let lastProcessMetrics = "";
let timedOut = null;
let forwardedSignal = null;
let forceTimer = null;
let limitPause = null;
const liveWarnings = new Set();
const lineBuffers = { stdout: "", stderr: "" };
const output = createWriteStream(options.output, { flags: "w", mode: 0o600 });
const child = spawn(command, commandArgs, {
  cwd: process.cwd(),
  env: process.env,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
});

function publishStatus(state = "running", extra = {}) {
  if (!options.status) return;
  const now = Date.now();
  const value = {
    schema: "rb-ralph-provider-live/v1",
    role: options.label,
    pid: child.pid ?? null,
    state,
    startedAt,
    elapsedSeconds: Math.floor((now - startedAt) / 1000),
    firstOutputAt: firstOutputAt || null,
    firstOutputLatencySeconds: firstOutputAt ? Math.floor((firstOutputAt - startedAt) / 1000) : null,
    outputBytes,
    commandCount,
    editCount,
    messageCount,
    structuredEventCount,
    lastEditAt: lastEditAt || null,
    secondsSinceEdit: lastEditAt ? Math.floor((now - lastEditAt) / 1000) : null,
    warnings: [...liveWarnings],
    contextLimit: limitPause,
    secondsSinceOutput: Math.floor((now - lastOutputAt) / 1000),
    secondsSinceProcessActivity: lastProcessActivityAt
      ? Math.floor((now - lastProcessActivityAt) / 1000) : null,
    firstOutputTimeoutSeconds: options.firstOutputTimeout,
    idleTimeoutSeconds: options.idleTimeout,
    wallTimeoutSeconds: options.timeout,
    ...extra,
  };
  mkdirSync(dirname(options.status), { recursive: true });
  const temporary = `${options.status}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, options.status);
}

function observeStructured(chunk, stream) {
  if (!lineBuffers[stream]) lineBuffers[stream] = "";
  const lines = `${lineBuffers[stream]}${chunk.toString("utf8")}`.split(/\r?\n/);
  lineBuffers[stream] = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    structuredEventCount += 1;
    const kind = classify(event);
    if (kind === "command") commandCount += 1;
    else if (kind === "edit") { editCount += 1; lastEditAt = Date.now(); }
    else if (kind === "message") messageCount += 1;
  }
}

function checkContextLimits() {
  if (options.softCommandLimit > 0 && commandCount >= options.softCommandLimit) {
    liveWarnings.add(`soft command limit reached (${commandCount}/${options.softCommandLimit})`);
  }
  if (options.softOutputBytes > 0 && outputBytes >= options.softOutputBytes) {
    liveWarnings.add(`soft output limit reached (${outputBytes}/${options.softOutputBytes} bytes)`);
  }
  if (limitPause) return;
  if (options.hardCommandLimit > 0 && commandCount >= options.hardCommandLimit) {
    limitPause = { kind: "commands", observed: commandCount, limit: options.hardCommandLimit };
  } else if (options.hardOutputBytes > 0 && outputBytes >= options.hardOutputBytes) {
    limitPause = { kind: "output-bytes", observed: outputBytes, limit: options.hardOutputBytes };
  }
  if (limitPause) {
    output.write(
      `\nRB_RALPH_PROCESS_STATUS: CONTEXT_LIMIT_PAUSE\n`
      + `RB_RALPH_CONTEXT_LIMIT_KIND: ${limitPause.kind}\n`
      + `RB_RALPH_CONTEXT_LIMIT_OBSERVED: ${limitPause.observed}\n`
      + `RB_RALPH_CONTEXT_LIMIT_CONFIGURED: ${limitPause.limit}\n`
      + "RB_RALPH_CONTEXT_LIMIT_ACTION: process tree paused recoverably; changes and evidence preserved\n",
    );
    publishStatus("paused", { pauseKind: "context-limit" });
    stopTree();
  }
}

function append(chunk, stream = "supervisor") {
  const now = Date.now();
  lastActivityAt = lastOutputAt = now;
  if (!firstOutputAt) firstOutputAt = now;
  outputBytes += Buffer.byteLength(chunk);
  output.write(chunk);
  if (stream === "stdout" || stream === "stderr") observeStructured(chunk, stream);
  checkContextLimits();
  publishStatus(limitPause ? "paused" : "running", limitPause ? { pauseKind: "context-limit" } : {});
}

publishStatus("started");

const tracked = new Map();

function processInfo(pid, includeIo = false) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = raw.lastIndexOf(")");
    const fields = raw.slice(end + 2).trim().split(/\s+/);
    const info = {
      pid,
      ppid: Number(fields[1]),
      cpu: Number(fields[11]) + Number(fields[12]),
      startTime: fields[19],
      io: 0,
    };
    if (includeIo) {
      const io = readFileSync(`/proc/${pid}/io`, "utf8");
      for (const line of io.split(/\n/)) {
        const match = /^(?:rchar|wchar|read_bytes|write_bytes):\s+(\d+)$/.exec(line);
        if (match) info.io += Number(match[1]);
      }
    }
    return info;
  } catch {
    return null;
  }
}

function discoverProcesses() {
  if (process.platform !== "linux" || !child.pid) return null;
  const processes = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const info = processInfo(Number(name));
    if (info) processes.set(info.pid, info);
  }
  const root = processes.get(child.pid);
  if (root && !tracked.has(root.pid)) tracked.set(root.pid, root.startTime);
  let changed = true;
  while (changed) {
    changed = false;
    for (const info of processes.values()) {
      if (!tracked.has(info.pid) && tracked.has(info.ppid)) {
        tracked.set(info.pid, info.startTime);
        changed = true;
      }
    }
  }
  let cpu = 0;
  let io = 0;
  let alive = 0;
  for (const [pid, startTime] of tracked) {
    const info = processInfo(pid, true);
    if (!info || info.startTime !== startTime) continue;
    cpu += info.cpu;
    io += info.io;
    alive += 1;
  }
  return `${alive}:${cpu}:${io}`;
}

function trackedAlive(excludeRoot = false) {
  const alive = [];
  for (const [pid, startTime] of tracked) {
    if (excludeRoot && pid === child.pid) continue;
    const info = processInfo(pid);
    if (info?.startTime === startTime) alive.push(pid);
  }
  return alive;
}

function signalTracked(signal, excludeRoot = false) {
  for (const pid of trackedAlive(excludeRoot).reverse()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

function processGroupAlive() {
  if (process.platform === "win32" || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalTree(signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (process.platform === "linux") signalTracked(signal);
}

function stopTree(signal = "SIGTERM") {
  signalTree(signal);
  if (signal === "SIGKILL") return;
  clearTimeout(forceTimer);
  forceTimer = setTimeout(() => signalTree("SIGKILL"), options.grace * 1000);
  forceTimer.unref();
}

child.stdout.on("data", (chunk) => append(chunk, "stdout"));
child.stderr.on("data", (chunk) => append(chunk, "stderr"));
child.stdin.on("error", (error) => {
  if (error.code !== "EPIPE") append(`\nRB_RALPH_SUPERVISOR_WARNING: stdin ${error.message}\n`);
});
child.on("error", (error) => {
  append(`\nRB_RALPH_PROCESS_STATUS: SPAWN_ERROR\nRB_RALPH_PROCESS_ERROR: ${error.message}\n`);
  publishStatus("spawn-error", { errorCode: error.code ?? "UNKNOWN" });
});

const input = createReadStream(options.input);
input.on("error", (error) => {
  append(`\nRB_RALPH_PROCESS_STATUS: INPUT_ERROR\nRB_RALPH_PROCESS_ERROR: ${error.message}\n`);
  stopTree();
});
input.pipe(child.stdin);

const timer = setInterval(() => {
  const now = Date.now();
  const processMetrics = discoverProcesses();
  if (processMetrics && lastProcessMetrics && processMetrics !== lastProcessMetrics) {
    lastActivityAt = now;
    lastProcessActivityAt = now;
    if (now - lastOutputAt >= 15000 && now - lastHeartbeatAt >= 15000) {
      const silentSeconds = Math.floor((now - lastOutputAt) / 1000);
      output.write(`\nRB_RALPH_PROCESS_ACTIVITY: ${options.label} active by cpu/io; provider output silent for ${silentSeconds}s\n`);
      lastHeartbeatAt = now;
    }
  }
  if (processMetrics) lastProcessMetrics = processMetrics;
  const elapsedSeconds = Math.floor((now - startedAt) / 1000);
  const idleSeconds = Math.floor((now - lastActivityAt) / 1000);
  if (!limitPause && !timedOut && !firstOutputAt && options.firstOutputTimeout > 0
      && elapsedSeconds >= options.firstOutputTimeout) {
    timedOut = { kind: "first-output", limit: options.firstOutputTimeout, elapsedSeconds, idleSeconds };
  } else if (!timedOut && options.timeout > 0 && elapsedSeconds >= options.timeout) {
    timedOut = { kind: "wall", limit: options.timeout, elapsedSeconds, idleSeconds };
  } else if (!timedOut && options.idleTimeout > 0 && idleSeconds >= options.idleTimeout) {
    timedOut = { kind: "idle", limit: options.idleTimeout, elapsedSeconds, idleSeconds };
  }
  publishStatus(limitPause ? "paused" : timedOut ? "timeout" : "running", timedOut ? { timeoutKind: timedOut.kind } : {});
  if (!timedOut) return;
  output.write(
    `\nRB_RALPH_PROCESS_STATUS: TIMEOUT\n`
    + `RB_RALPH_TIMEOUT_KIND: ${timedOut.kind}\n`
    + `RB_RALPH_TIMEOUT_ROLE: ${options.label}\n`
    + `RB_RALPH_TIMEOUT_LIMIT_SECONDS: ${timedOut.limit}\n`
    + `RB_RALPH_TIMEOUT_ELAPSED_SECONDS: ${timedOut.elapsedSeconds}\n`
    + `RB_RALPH_TIMEOUT_IDLE_SECONDS: ${timedOut.idleSeconds}\n`
    + "RB_RALPH_TIMEOUT_ACTION: process tree terminated; evidence is resumable\n",
  );
  clearInterval(timer);
  stopTree();
}, 500);
timer.unref();

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    stopTree(signal);
  });
}

child.on("close", (code, signal) => {
  clearInterval(timer);
  clearTimeout(forceTimer);
  input.destroy();
  observeStructured("\n", "stdout");
  observeStructured("\n", "stderr");
  discoverProcesses();
  const finalize = () => output.end(() => {
    publishStatus(limitPause ? "paused" : timedOut ? "timeout" : code === 0 ? "complete" : "failed", {
      exitCode: Number.isInteger(code) ? code : null,
      signal: signal ?? null,
      timeoutKind: timedOut?.kind ?? null,
    });
    if (limitPause) process.exitCode = 125;
    else if (timedOut) process.exitCode = 124;
    else if (forwardedSignal) process.exitCode = 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[forwardedSignal] ?? 1);
    else if (Number.isInteger(code)) process.exitCode = code;
    else process.exitCode = signal ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 1) : 1;
  });
  const remainingTracked = process.platform === "linux" ? trackedAlive(true) : [];
  const remainingGroup = processGroupAlive();
  if (!remainingGroup && remainingTracked.length === 0) {
    finalize();
    return;
  }
  output.write(`\nRB_RALPH_PROCESS_CLEANUP: terminating ${Math.max(remainingTracked.length, 1)} remaining descendant(s)\n`);
  signalTree("SIGTERM");
  const deadline = Date.now() + options.grace * 1000;
  const cleanupTimer = setInterval(() => {
    const remaining = trackedAlive(true);
    const groupAlive = processGroupAlive();
    if ((remaining.length || groupAlive) && Date.now() < deadline) return;
    clearInterval(cleanupTimer);
    if (remaining.length || groupAlive) signalTree("SIGKILL");
    finalize();
  }, 100);
});
