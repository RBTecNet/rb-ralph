#!/usr/bin/env node
"use strict";

const { createReadStream, createWriteStream, readdirSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(2);
}

const options = {
  input: "",
  output: "",
  idleTimeout: 0,
  timeout: 0,
  grace: 5,
  label: "provider",
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
  else if (name === "--timeout") options.timeout = Number(value);
  else if (name === "--grace") options.grace = Number(value);
  else if (name === "--label") options.label = value;
  else fail(`unknown process-supervisor option: ${name}`);
}

if (!options.input || !options.output) fail("--input and --output are required");
for (const [name, value] of [
  ["--idle-timeout", options.idleTimeout],
  ["--timeout", options.timeout],
  ["--grace", options.grace],
]) {
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
}

const startedAt = Date.now();
let lastActivityAt = startedAt;
let lastOutputAt = startedAt;
let lastHeartbeatAt = 0;
let lastProcessMetrics = "";
let timedOut = null;
let forwardedSignal = null;
let forceTimer = null;
const output = createWriteStream(options.output, { flags: "w", mode: 0o600 });
const child = spawn(command, commandArgs, {
  cwd: process.cwd(),
  env: process.env,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
});

function append(chunk) {
  lastActivityAt = lastOutputAt = Date.now();
  output.write(chunk);
}

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

child.stdout.on("data", append);
child.stderr.on("data", append);
child.stdin.on("error", (error) => {
  if (error.code !== "EPIPE") append(`\nRB_RALPH_SUPERVISOR_WARNING: stdin ${error.message}\n`);
});
child.on("error", (error) => {
  append(`\nRB_RALPH_PROCESS_STATUS: SPAWN_ERROR\nRB_RALPH_PROCESS_ERROR: ${error.message}\n`);
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
    if (now - lastOutputAt >= 15000 && now - lastHeartbeatAt >= 15000) {
      const silentSeconds = Math.floor((now - lastOutputAt) / 1000);
      output.write(`\nRB_RALPH_PROCESS_ACTIVITY: ${options.label} active by cpu/io; provider output silent for ${silentSeconds}s\n`);
      lastHeartbeatAt = now;
    }
  }
  if (processMetrics) lastProcessMetrics = processMetrics;
  const elapsedSeconds = Math.floor((now - startedAt) / 1000);
  const idleSeconds = Math.floor((now - lastActivityAt) / 1000);
  if (!timedOut && options.timeout > 0 && elapsedSeconds >= options.timeout) {
    timedOut = { kind: "wall", limit: options.timeout, elapsedSeconds, idleSeconds };
  } else if (!timedOut && options.idleTimeout > 0 && idleSeconds >= options.idleTimeout) {
    timedOut = { kind: "idle", limit: options.idleTimeout, elapsedSeconds, idleSeconds };
  }
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
  discoverProcesses();
  const finalize = () => output.end(() => {
    if (timedOut) process.exitCode = 124;
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
