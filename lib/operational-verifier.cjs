#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_EXCLUDES = [
  // A clean room starts from source authority, not the caller's already
  // provisioned machine. A scenario that needs these must recreate them with
  // its declared commands; copying them would make a false operational pass.
  '.git', '.rb/runs', '.env', '.env.local', '.env.production', '.env.development',
  'node_modules', 'vendor', 'dist', 'build', 'target', '.next', 'coverage', '.cache',
  '.pytest_cache', '.mypy_cache', '.gradle', '.terraform', '.venv', 'venv',
];

function validateCanonically(contractPath) {
  const core = process.env.RB_RALPH_OPERATIONAL_CORE
    || path.resolve(__dirname, '..', 'core', 'rb-harness.cjs');
  if (!fs.existsSync(core)) fail(`canonical rb-operational/v1 validator is unavailable: ${core}`);
  const result = spawnSync(process.execPath, [core, 'operations', 'validate', contractPath], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) fail(`canonical rb-operational/v1 validation failed: ${(result.stderr || result.stdout || 'invalid contract').trim()}`);
}

function fail(message) {
  const error = new Error(message);
  error.operational = true;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
}

function validateCommand(command, label) {
  if (!isObject(command) || !Array.isArray(command.argv) || command.argv.length === 0) {
    fail(`${label}.argv must be a non-empty array`);
  }
  command.argv.forEach((item, index) => assertString(item, `${label}.argv[${index}]`));
  if (command.cwd !== undefined) assertString(command.cwd, `${label}.cwd`);
  if (command.env !== undefined && !isObject(command.env)) fail(`${label}.env must be an object`);
  for (const [name, value] of Object.entries(command.env || {})) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) fail(`${label}.env.${name} must be a scalar`);
  }
}

function validateProbe(probe, label) {
  if (!isObject(probe)) fail(`${label} must be an object`);
  const kinds = ['http', 'tcp', 'file', 'stdout'];
  if (!kinds.includes(probe.kind)) fail(`${label}.kind must be one of: ${kinds.join(', ')}`);
  if (probe.kind === 'http') {
    assertString(probe.url, `${label}.url`);
    if (probe.headers !== undefined && !isObject(probe.headers)) fail(`${label}.headers must be an object`);
  }
  if (probe.kind === 'tcp') {
    assertString(probe.host, `${label}.host`);
    if (!Number.isInteger(probe.port) && typeof probe.port !== 'string') fail(`${label}.port must be an integer or interpolated string`);
  }
  if (probe.kind === 'file') assertString(probe.path, `${label}.path`);
  if (probe.kind === 'stdout') assertString(probe.includes, `${label}.includes`);
}

function validateContract(contract) {
  if (!isObject(contract)) fail('contract root must be an object');
  if (contract.contract !== 'rb-operational/v1') fail('contract must be rb-operational/v1');
  if (contract.cleanRoom !== undefined && !isObject(contract.cleanRoom)) fail('cleanRoom must be an object');
  if (contract.cleanRoom?.exclude !== undefined && (!Array.isArray(contract.cleanRoom.exclude) || contract.cleanRoom.exclude.some((entry) => typeof entry !== 'string' || entry.trim() === ''))) {
    fail('cleanRoom.exclude must be an array of non-empty strings');
  }
  if (contract.environment !== undefined && !isObject(contract.environment)) fail('environment must be an object');
  if (contract.environment?.inherit !== undefined && (!Array.isArray(contract.environment.inherit) || contract.environment.inherit.some((entry) => typeof entry !== 'string'))) {
    fail('environment.inherit must be an array of strings');
  }
  if (contract.environment?.set !== undefined && !isObject(contract.environment.set)) fail('environment.set must be an object');
  for (const [name, value] of Object.entries(contract.environment?.set || {})) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) fail(`environment.set.${name} must be a scalar`);
  }
  if (!Array.isArray(contract.scenarios) || contract.scenarios.length === 0) {
    fail('scenarios must be a non-empty array');
  }
  const ids = new Set();
  for (const [scenarioIndex, scenario] of contract.scenarios.entries()) {
    const label = `scenarios[${scenarioIndex}]`;
    if (!isObject(scenario)) fail(`${label} must be an object`);
    assertString(scenario.id, `${label}.id`);
    if (ids.has(scenario.id)) fail(`duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    assertString(scenario.title, `${label}.title`);
    if (scenario.platforms !== undefined && (!Array.isArray(scenario.platforms) || scenario.platforms.some((item) => !['linux', 'darwin', 'win32'].includes(item)))) {
      fail(`${label}.platforms must contain only linux, darwin, or win32`);
    }
    if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) fail(`${label}.steps must be a non-empty array`);
    for (const [stepIndex, step] of scenario.steps.entries()) {
      const stepLabel = `${label}.steps[${stepIndex}]`;
      if (!isObject(step)) fail(`${stepLabel} must be an object`);
      assertString(step.id, `${stepLabel}.id`);
      if (!['command', 'process', 'http', 'tcp', 'file'].includes(step.kind)) {
        fail(`${stepLabel}.kind must be command, process, http, tcp, or file`);
      }
      if (step.kind === 'command') {
        validateCommand(step.command, `${stepLabel}.command`);
        if (step.expect !== undefined && !isObject(step.expect)) fail(`${stepLabel}.expect must be an object`);
        if (step.expect?.exitCode !== undefined && !Number.isInteger(step.expect.exitCode)) fail(`${stepLabel}.expect.exitCode must be an integer`);
        for (const name of ['stdoutIncludes', 'stderrIncludes']) {
          if (step.expect?.[name] !== undefined && (!Array.isArray(step.expect[name]) || step.expect[name].some((entry) => typeof entry !== 'string'))) {
            fail(`${stepLabel}.expect.${name} must be an array of strings`);
          }
        }
      }
      if (step.kind === 'process') {
        validateCommand(step.command, `${stepLabel}.command`);
        validateProbe(step.ready, `${stepLabel}.ready`);
        if (step.checks !== undefined) {
          if (!Array.isArray(step.checks)) fail(`${stepLabel}.checks must be an array`);
          step.checks.forEach((probe, index) => validateProbe(probe, `${stepLabel}.checks[${index}]`));
        }
      }
      if (['http', 'tcp', 'file'].includes(step.kind)) validateProbe(step, stepLabel);
    }
  }
  return contract;
}

function interpolate(value, variables) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => {
    if (!(name in variables)) fail(`unknown operational variable ${match}`);
    return String(variables[name]);
  });
}

function cleanRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '').replace(/\/$/, '');
}

function resolveInside(root, relative, label) {
  const target = path.resolve(root, relative || '.');
  const relation = path.relative(root, target);
  if (relation.startsWith('..') || path.isAbsolute(relation)) fail(`${label} escapes the clean-room root: ${relative}`);
  return target;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function baseEnvironment(contractEnvironment, variables) {
  const allow = ['PATH', 'USER', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'CI'];
  const environment = {};
  for (const name of allow) if (process.env[name] !== undefined) environment[name] = process.env[name];
  const configuration = isObject(contractEnvironment) ? contractEnvironment : {};
  for (const name of configuration.inherit || []) {
    assertString(name, 'environment.inherit entry');
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(configuration.set || {})) {
    environment[name] = interpolate(String(value), variables);
  }
  environment.RB_VERIFY_ROOT = variables.RB_VERIFY_ROOT;
  environment.RB_VERIFY_PORT = String(variables.RB_VERIFY_PORT);
  return environment;
}

function commandOptions(command, root, baseEnv, variables) {
  const argv = command.argv.map((item) => interpolate(item, variables));
  const cwd = resolveInside(root, interpolate(command.cwd || '.', variables), 'command.cwd');
  const env = { ...baseEnv };
  for (const [name, value] of Object.entries(command.env || {})) env[name] = interpolate(String(value), variables);
  return { executable: argv[0], args: argv.slice(1), cwd, env };
}

function appendLimited(current, chunk) {
  const combined = current + chunk.toString('utf8');
  return combined.length > OUTPUT_LIMIT ? combined.slice(combined.length - OUTPUT_LIMIT) : combined;
}

async function runCommand(command, root, baseEnv, variables, timeoutSeconds = 900) {
  const options = commandOptions(command, root, baseEnv, variables);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const timer = timeoutSeconds > 0 ? setTimeout(() => {
      timedOut = true;
      signalProcess(child, 'SIGTERM');
      setTimeout(() => signalProcess(child, 'SIGKILL'), 2000).unref();
    }, timeoutSeconds * 1000) : null;
    child.stdout.on('data', (chunk) => { stdout = appendLimited(stdout, chunk); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk); process.stderr.write(chunk); });
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}\n`, timedOut });
    });
    child.once('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function assertExpectation(result, expect, label) {
  const expected = isObject(expect) ? expect : {};
  const exitCode = expected.exitCode === undefined ? 0 : expected.exitCode;
  if (result.timedOut) fail(`${label} timed out`);
  if (result.exitCode !== exitCode) fail(`${label} exited ${result.exitCode}; expected ${exitCode}`);
  for (const text of expected.stdoutIncludes || []) {
    if (!result.stdout.includes(text)) fail(`${label} stdout did not include ${JSON.stringify(text)}`);
  }
  for (const text of expected.stderrIncludes || []) {
    if (!result.stderr.includes(text)) fail(`${label} stderr did not include ${JSON.stringify(text)}`);
  }
}

async function httpProbe(probe, variables) {
  const url = new URL(interpolate(probe.url, variables));
  const transport = url.protocol === 'https:' ? https : http;
  const timeout = (probe.timeoutSeconds || 10) * 1000;
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(Object.entries(probe.headers || {}).map(([name, value]) => [name, interpolate(String(value), variables)]));
    const request = transport.request(url, { method: probe.method || 'GET', timeout, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body = appendLimited(body, chunk); });
      response.on('end', () => {
        const expectedStatus = probe.status === undefined ? 200 : probe.status;
        if (response.statusCode !== expectedStatus) return reject(new Error(`HTTP ${response.statusCode}; expected ${expectedStatus}`));
        for (const text of probe.bodyIncludes || []) {
          if (!body.includes(text)) return reject(new Error(`HTTP body did not include ${JSON.stringify(text)}`));
        }
        resolve(`HTTP ${response.statusCode}`);
      });
    });
    request.once('timeout', () => request.destroy(new Error('HTTP probe timed out')));
    request.once('error', reject);
    if (probe.body !== undefined) request.write(interpolate(String(probe.body), variables));
    request.end();
  });
}

async function tcpProbe(probe, variables) {
  const host = interpolate(probe.host, variables);
  const port = Number(interpolate(String(probe.port), variables));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid TCP port: ${probe.port}`);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout((probe.timeoutSeconds || 10) * 1000);
    socket.once('connect', () => { socket.destroy(); resolve(`TCP ${host}:${port}`); });
    socket.once('timeout', () => socket.destroy(new Error('TCP probe timed out')));
    socket.once('error', reject);
  });
}

async function fileProbe(probe, root, variables) {
  const target = resolveInside(root, interpolate(probe.path, variables), 'file.path');
  const exists = fs.existsSync(target);
  const expected = probe.exists === undefined ? true : Boolean(probe.exists);
  if (exists !== expected) fail(`file ${probe.path} exists=${exists}; expected ${expected}`);
  if (exists && probe.includes !== undefined) {
    const content = await fsp.readFile(target, 'utf8');
    if (!content.includes(interpolate(probe.includes, variables))) fail(`file ${probe.path} lacks expected content`);
  }
  return `file ${probe.path} exists=${exists}`;
}

async function executeProbe(probe, context) {
  if (probe.kind === 'http') return httpProbe(probe, context.variables);
  if (probe.kind === 'tcp') return tcpProbe(probe, context.variables);
  if (probe.kind === 'file') return fileProbe(probe, context.root, context.variables);
  if (probe.kind === 'stdout') {
    const expected = interpolate(probe.includes, context.variables);
    if (!context.output.includes(expected)) fail(`process output did not include ${JSON.stringify(expected)}`);
    return `stdout includes ${JSON.stringify(expected)}`;
  }
  fail(`unsupported probe kind: ${probe.kind}`);
}

async function waitForProbe(probe, context, timeoutSeconds, childState) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError;
  while (Date.now() < deadline) {
    if (childState.closed) fail(`process exited before readiness (exit=${childState.exitCode}, signal=${childState.signal || 'none'})`);
    try {
      return await executeProbe(probe, context);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  fail(`process readiness timed out: ${lastError?.message || 'probe did not pass'}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      signalProcess(child, 'SIGKILL');
      resolve();
    }, 3000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    signalProcess(child, 'SIGTERM');
  });
}

function signalProcess(child, signal) {
  if (!child.pid) return;
  if (process.platform === 'win32' && signal === 'SIGKILL') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.unref();
      return;
    } catch {}
  }
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child.kill(signal); } catch {}
}

async function runProcessStep(step, context) {
  const options = commandOptions(step.command, context.root, context.baseEnv, context.variables);
  let output = '';
  const state = { closed: false, exitCode: null, signal: null };
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (chunk) => { output = appendLimited(output, chunk); process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { output = appendLimited(output, chunk); process.stderr.write(chunk); });
  child.once('error', (error) => { output = appendLimited(output, `${error.message}\n`); });
  child.once('close', (exitCode, signal) => { state.closed = true; state.exitCode = exitCode; state.signal = signal; });
  try {
    const probeContext = { ...context, get output() { return output; } };
    const readyResult = await waitForProbe(step.ready, probeContext, step.readyTimeoutSeconds || 30, state);
    console.log(`[ready] ${readyResult}`);
    for (const probe of step.checks || []) console.log(`[check] ${await executeProbe(probe, probeContext)}`);
  } finally {
    await stopProcess(child);
  }
}

function excluded(relative, exclusions) {
  const normalized = cleanRelative(relative);
  const name = path.posix.basename(normalized);
  if ((name === '.env' || name.startsWith('.env.')) && !['.env.example', '.env.sample', '.env.template'].includes(name)) return true;
  return exclusions.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

async function createCleanRoom(projectRoot, contract) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'rb-ralph-verify-'));
  const root = path.join(temporary, 'project');
  const configured = contract.cleanRoom?.exclude || [];
  const exclusions = [...new Set([...DEFAULT_EXCLUDES, ...configured].map(cleanRelative))];
  await fsp.cp(projectRoot, root, {
    recursive: true,
    dereference: false,
    filter(source) {
      const relative = path.relative(projectRoot, source);
      if (relative !== '' && excluded(relative, exclusions)) return false;
      if (relative !== '' && fs.lstatSync(source).isSymbolicLink()) {
        const link = fs.readlinkSync(source);
        if (path.isAbsolute(link)) fail(`clean-room copy rejects absolute symlink: ${cleanRelative(relative)}`);
        const target = path.resolve(path.dirname(source), link);
        const targetRelation = path.relative(projectRoot, target);
        if (targetRelation.startsWith('..') || path.isAbsolute(targetRelation)) {
          fail(`clean-room copy rejects external symlink: ${cleanRelative(relative)}`);
        }
      }
      return true;
    },
  });
  return { temporary, root, exclusions };
}

async function runContract(contractPath, projectRoot) {
  const contract = validateContract(JSON.parse(await fsp.readFile(contractPath, 'utf8')));
  const sourceRoot = path.resolve(projectRoot);
  const { temporary, root, exclusions } = await createCleanRoom(sourceRoot, contract);
  const cleanHome = path.join(temporary, 'home');
  await fsp.mkdir(cleanHome, { recursive: true });
  const variables = {
    RB_VERIFY_ROOT: root,
    RB_VERIFY_PORT: await availablePort(),
  };
  const baseEnv = baseEnvironment(contract.environment, variables);
  baseEnv.HOME = cleanHome;
  baseEnv.USERPROFILE = cleanHome;
  baseEnv.XDG_CACHE_HOME = path.join(cleanHome, '.cache');
  baseEnv.XDG_CONFIG_HOME = path.join(cleanHome, '.config');
  const context = { root, variables, baseEnv };
  let executed = 0;
  let skipped = 0;
  console.log(`RB_OPERATIONAL_CONTRACT: ${contractPath}`);
  console.log(`RB_OPERATIONAL_CLEAN_ROOT: ${root}`);
  console.log(`RB_OPERATIONAL_EXCLUDES: ${exclusions.join(', ')}`);
  try {
    for (const scenario of contract.scenarios) {
      if (scenario.platforms && !scenario.platforms.includes(process.platform)) {
        skipped += 1;
        console.log(`\n[SKIP] ${scenario.id} ${scenario.title} (platform=${process.platform})`);
        continue;
      }
      executed += 1;
      console.log(`\n[SCENARIO] ${scenario.id} ${scenario.title}`);
      for (const step of scenario.steps) {
        console.log(`[STEP] ${step.id} kind=${step.kind}`);
        if (step.kind === 'command') {
          const result = await runCommand(step.command, root, baseEnv, variables, step.timeoutSeconds ?? 900);
          assertExpectation(result, step.expect, `${scenario.id}/${step.id}`);
        } else if (step.kind === 'process') {
          await runProcessStep(step, context);
        } else {
          console.log(`[check] ${await executeProbe(step, context)}`);
        }
        console.log(`[PASS] ${scenario.id}/${step.id}`);
      }
    }
    if (executed === 0) fail(`no operational scenario applies to platform ${process.platform}`);
    console.log(`\nRB_OPERATIONAL_RESULT: PASS scenarios=${executed} skipped=${skipped}`);
  } finally {
    if (process.env.RB_RALPH_KEEP_VERIFY_ROOT === '1') {
      console.log(`RB_OPERATIONAL_CLEAN_ROOT_PRESERVED: ${root}`);
    } else {
      await fsp.rm(temporary, { recursive: true, force: true });
    }
  }
}

async function main() {
  const [command, contractPath, projectRoot] = process.argv.slice(2);
  if (!['validate', 'run'].includes(command) || !contractPath) {
    console.error('Usage: operational-verifier.cjs validate <OPERATIONS.json> | run <OPERATIONS.json> <project-root>');
    process.exit(64);
  }
  const absoluteContract = path.resolve(contractPath);
  // The formal RB Harness validator owns every schema/unknown-property rule.
  // validateContract below is only the executor's typed reader after this gate.
  validateCanonically(absoluteContract);
  const contract = validateContract(JSON.parse(await fsp.readFile(absoluteContract, 'utf8')));
  if (command === 'validate') {
    console.log(`RB_OPERATIONAL_RESULT: VALID scenarios=${contract.scenarios.length}`);
    return;
  }
  if (!projectRoot) fail('project-root is required for run');
  await runContract(absoluteContract, path.resolve(projectRoot));
}

main().catch((error) => {
  console.error(`RB_OPERATIONAL_RESULT: FAIL ${error.message}`);
  if (!error.operational && process.env.RB_RALPH_DEBUG === '1') console.error(error.stack);
  process.exit(1);
});
