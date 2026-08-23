#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONTRACT = "rb-ralph-profiles/v1";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROVIDERS = new Set(["codex", "claude", "opencode", "openai", "anthropic", "gemini", "deepseek", "minimax", "openrouter"]);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const BUILT_INS = Object.freeze({
  balanced: {
    description: "Fresh task calls, exhaustive manager audit, final audit, dashboard, and YOLO permissions.",
    execution: {
      unit: "task",
      managerAudit: "exhaustive",
      finalAudit: true,
      dashboard: true,
      permissionMode: "yolo",
    },
  },
  fast: {
    description: "One fresh call per phase with exhaustive review, final audit, dashboard, and YOLO permissions.",
    execution: {
      unit: "phase",
      managerAudit: "exhaustive",
      finalAudit: true,
      dashboard: true,
      permissionMode: "yolo",
    },
  },
  strict: {
    description: "Fresh task calls, exhaustive review, final audit, dashboard, and protected provider permissions.",
    execution: {
      unit: "task",
      managerAudit: "exhaustive",
      finalAudit: true,
      dashboard: true,
      permissionMode: "protected",
    },
  },
});

const NUMERIC_OPTIONS = Object.freeze({
  maxAttempts: ["--max-attempts", false],
  maxTotalAttempts: ["--max-total-attempts", true],
  maxStrategyResets: ["--max-strategy-resets", true],
  managerRetries: ["--manager-retries", true],
  managerRetryWait: ["--manager-retry-wait", true],
  agentTimeout: ["--agent-timeout", true],
  agentIdleTimeout: ["--agent-idle-timeout", true],
  agentFirstOutputTimeout: ["--agent-first-output-timeout", true],
  managerTimeout: ["--manager-timeout", true],
  managerIdleTimeout: ["--manager-idle-timeout", true],
  managerFirstOutputTimeout: ["--manager-first-output-timeout", true],
  validationTimeout: ["--validation-timeout", true],
  parallel: ["--parallel", false],
});

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function profilesPath() {
  if (process.env.RB_RALPH_PROFILES_FILE) {
    return path.resolve(process.env.RB_RALPH_PROFILES_FILE);
  }
  const configHome = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "rb-ralph", "profiles.json");
}

function cleanText(value, label, max = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(`${label} must be a non-empty string no longer than ${max} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} must not contain control characters`);
  }
  return value;
}

function cleanOptionalText(value, label, max = 1024) {
  if (value === undefined) return undefined;
  return cleanText(value, label, max);
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not supported`);
  }
}

function validateRole(value, label) {
  if (value === undefined) return undefined;
  exactKeys(value, new Set(["provider", "command", "model", "effort", "credential"]), label);
  const role = {};
  if (value.provider !== undefined) {
    cleanText(value.provider, `${label}.provider`, 32);
    if (!PROVIDERS.has(value.provider)) fail(`${label}.provider is not supported`);
    role.provider = value.provider;
  }
  role.command = cleanOptionalText(value.command, `${label}.command`, 4096);
  role.model = cleanOptionalText(value.model, `${label}.model`, 512);
  role.effort = cleanOptionalText(value.effort, `${label}.effort`, 128);
  role.credential = cleanOptionalText(value.credential, `${label}.credential`, 256);
  if (role.credential && !["openai", "anthropic", "gemini", "deepseek", "minimax", "openrouter"].includes(role.provider)) {
    fail(`${label}.credential is valid only with a direct API provider`);
  }
  if (role.provider && role.command) fail(`${label} cannot define provider and command together`);
  return Object.fromEntries(Object.entries(role).filter(([, item]) => item !== undefined));
}

function validateInteger(value, label, allowZero) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return value;
}

function validateExecution(value) {
  if (value === undefined) return undefined;
  const allowed = new Set([
    "unit", "managerAudit", "validationMode", "finalAudit", "dashboard",
    "permissionMode", "isolation", ...Object.keys(NUMERIC_OPTIONS),
  ]);
  exactKeys(value, allowed, "profile.execution");
  const execution = {};
  if (value.unit !== undefined) {
    if (!["task", "phase"].includes(value.unit)) fail("profile.execution.unit must be task or phase");
    execution.unit = value.unit;
  }
  if (value.managerAudit !== undefined) {
    if (!["exhaustive", "legacy"].includes(value.managerAudit)) fail("profile.execution.managerAudit must be exhaustive or legacy");
    execution.managerAudit = value.managerAudit;
  }
  if (value.validationMode !== undefined) {
    if (!["run", "manager"].includes(value.validationMode)) fail("profile.execution.validationMode must be run or manager");
    execution.validationMode = value.validationMode;
  }
  for (const key of ["finalAudit", "dashboard"]) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") fail(`profile.execution.${key} must be boolean`);
      execution[key] = value[key];
    }
  }
  if (value.permissionMode !== undefined) {
    if (!["yolo", "protected"].includes(value.permissionMode)) fail("profile.execution.permissionMode must be yolo or protected");
    execution.permissionMode = value.permissionMode;
  }
  if (value.isolation !== undefined) {
    if (!["shared", "worktree"].includes(value.isolation)) fail("profile.execution.isolation must be shared or worktree");
    execution.isolation = value.isolation;
  }
  for (const [key, [, allowZero]] of Object.entries(NUMERIC_OPTIONS)) {
    if (value[key] !== undefined) execution[key] = validateInteger(value[key], `profile.execution.${key}`, allowZero);
  }
  if ((execution.parallel ?? 1) > 1 && execution.isolation !== "worktree") {
    fail("profile.execution.parallel greater than 1 requires isolation=worktree");
  }
  return execution;
}

function validateProfile(raw) {
  exactKeys(raw, new Set(["description", "agent", "manager", "execution"]), "profile");
  const profile = {};
  profile.description = cleanOptionalText(raw.description, "profile.description", 240);
  profile.agent = validateRole(raw.agent, "profile.agent");
  profile.manager = validateRole(raw.manager, "profile.manager");
  profile.execution = validateExecution(raw.execution);
  if (profile.manager && Object.keys(profile.manager).length > 0 &&
      (!profile.agent || (!profile.agent.provider && !profile.agent.command))) {
    fail("a manager configuration requires an executor provider or command in the same profile");
  }
  const compact = Object.fromEntries(Object.entries(profile).filter(([, value]) =>
    value !== undefined && (typeof value !== "object" || Object.keys(value).length > 0)));
  if (Object.keys(compact).length === 0) fail("profile must configure at least one reusable option");
  return compact;
}

function validateName(name) {
  if (!NAME_PATTERN.test(name || "")) {
    fail("profile name must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return name;
}

function loadStore() {
  const file = profilesPath();
  if (!fs.existsSync(file)) return { contract: CONTRACT, profiles: Object.create(null) };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`profiles file must be a regular file, not a symlink: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`profiles file is not valid JSON: ${error.message}`);
  }
  exactKeys(parsed, new Set(["contract", "profiles"]), "profiles file");
  if (parsed.contract !== CONTRACT) fail(`unsupported profiles contract: ${parsed.contract || "missing"}`);
  if (!parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
    fail("profiles file profiles must be an object");
  }
  const profiles = Object.create(null);
  for (const [name, value] of Object.entries(parsed.profiles)) {
    validateName(name);
    if (owns(BUILT_INS, name)) fail(`user profile cannot shadow built-in profile '${name}'`);
    profiles[name] = validateProfile(value);
  }
  return { contract: CONTRACT, profiles };
}

function saveStore(store) {
  const file = profilesPath();
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail(`profiles directory must be a real directory: ${directory}`);
  }
  try { fs.chmodSync(directory, 0o700); } catch (_) { /* best effort on non-POSIX */ }
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`refusing to replace non-regular profiles file: ${file}`);
  }
  const temporary = path.join(directory, `.profiles.json.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(store, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on non-POSIX */ }
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* already renamed or never created */ }
  }
}

function findProfile(name) {
  validateName(name);
  if (owns(BUILT_INS, name)) return { origin: "built-in", profile: validateProfile(BUILT_INS[name]) };
  const store = loadStore();
  if (!owns(store.profiles, name)) fail(`profile not found: ${name}`);
  return { origin: "user", profile: store.profiles[name] };
}

function profileArgs(profile) {
  const args = [];
  const roleArgs = (role, prefix) => {
    if (!role) return;
    if (role.provider) args.push(`--${prefix}-provider`, role.provider);
    if (role.command) args.push(`--${prefix}-cmd`, role.command);
    if (role.model) args.push(`--${prefix}-model`, role.model);
    if (role.effort) args.push(`--${prefix}-effort`, role.effort);
    if (role.credential) args.push(`--${prefix}-credential`, role.credential);
  };
  roleArgs(profile.agent, "agent");
  roleArgs(profile.manager, "manager");
  const execution = profile.execution || {};
  if (execution.unit) args.push("--execution-unit", execution.unit);
  if (execution.managerAudit) args.push("--manager-audit", execution.managerAudit);
  if (execution.validationMode) args.push("--validation-mode", execution.validationMode);
  if (execution.finalAudit !== undefined) args.push(execution.finalAudit ? "--final-audit" : "--no-final-audit");
  if (execution.dashboard !== undefined) args.push(execution.dashboard ? "--dashboard" : "--no-dashboard");
  if (execution.permissionMode) args.push(execution.permissionMode === "yolo" ? "--yolo" : "--protected");
  if (execution.isolation) args.push("--isolation", execution.isolation);
  for (const [key, [flag]] of Object.entries(NUMERIC_OPTIONS)) {
    if (execution[key] !== undefined) args.push(flag, String(execution[key]));
  }
  return args;
}

function argsToProfile(args) {
  const profile = { agent: {}, manager: {}, execution: {} };
  const valueFlags = new Map([
    ["--agent-provider", ["agent", "provider"]], ["--agent-cmd", ["agent", "command"]],
    ["--agent-model", ["agent", "model"]], ["--agent-effort", ["agent", "effort"]],
    ["--agent-credential", ["agent", "credential"]],
    ["--manager-provider", ["manager", "provider"]], ["--manager-cmd", ["manager", "command"]],
    ["--manager-model", ["manager", "model"]], ["--manager-effort", ["manager", "effort"]],
    ["--manager-credential", ["manager", "credential"]],
    ["--execution-unit", ["execution", "unit"]], ["--manager-audit", ["execution", "managerAudit"]],
    ["--validation-mode", ["execution", "validationMode"]], ["--isolation", ["execution", "isolation"]],
  ]);
  for (const [key, [flag]] of Object.entries(NUMERIC_OPTIONS)) valueFlags.set(flag, ["execution", key, "integer"]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (valueFlags.has(flag)) {
      if (index + 1 >= args.length) fail(`${flag} requires a value`);
      const [section, key, kind] = valueFlags.get(flag);
      const value = args[++index];
      profile[section][key] = kind === "integer" ? Number(value) : value;
      continue;
    }
    if (flag === "--final-audit") profile.execution.finalAudit = true;
    else if (flag === "--no-final-audit") profile.execution.finalAudit = false;
    else if (flag === "--dashboard" || flag === "--tui") profile.execution.dashboard = true;
    else if (flag === "--no-dashboard") profile.execution.dashboard = false;
    else if (flag === "--yolo") profile.execution.permissionMode = "yolo";
    else if (flag === "--protected") profile.execution.permissionMode = "protected";
    else fail(`option cannot be stored in a reusable profile: ${flag}`);
  }
  return validateProfile(profile);
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function printArgs(args) {
  for (const argument of args) {
    if (/[\r\n]/.test(argument)) fail("profile argument contains a line break");
    process.stdout.write(`${argument}\n`);
  }
}

function commandList() {
  process.stdout.write("name\torigin\tdescription\n");
  for (const [name, profile] of Object.entries(BUILT_INS)) {
    process.stdout.write(`${name}\tbuilt-in\t${profile.description}\n`);
  }
  const store = loadStore();
  for (const name of Object.keys(store.profiles).sort()) {
    process.stdout.write(`${name}\tuser\t${store.profiles[name].description || "Custom reusable profile."}\n`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "path") {
  process.stdout.write(`${profilesPath()}\n`);
} else if (command === "list") {
  commandList();
} else if (command === "show") {
  const { origin, profile } = findProfile(rest[0]);
  process.stdout.write(`${JSON.stringify({ contract: CONTRACT, name: rest[0], origin, ...profile }, null, 2)}\n`);
} else if (command === "args") {
  printArgs(profileArgs(findProfile(rest[0]).profile));
} else if (command === "save") {
  const name = validateName(rest[0]);
  if (owns(BUILT_INS, name)) fail(`built-in profile '${name}' is immutable`);
  let parsed;
  try { parsed = JSON.parse(readStdin()); } catch (error) { fail(`profile input is not valid JSON: ${error.message}`); }
  const profile = validateProfile(parsed);
  const store = loadStore();
  store.profiles[name] = profile;
  saveStore(store);
  process.stdout.write(`Saved profile '${name}' in ${profilesPath()}\n`);
} else if (command === "save-args") {
  const name = validateName(rest[0]);
  if (owns(BUILT_INS, name)) fail(`built-in profile '${name}' is immutable`);
  const args = readStdin().split(/\r?\n/).filter(Boolean);
  const store = loadStore();
  store.profiles[name] = argsToProfile(args);
  saveStore(store);
  process.stdout.write(`Saved profile '${name}' in ${profilesPath()}\n`);
} else if (command === "delete") {
  const name = validateName(rest[0]);
  if (owns(BUILT_INS, name)) fail(`built-in profile '${name}' is immutable`);
  const store = loadStore();
  if (!owns(store.profiles, name)) fail(`profile not found: ${name}`);
  delete store.profiles[name];
  saveStore(store);
  process.stdout.write(`Deleted profile '${name}'\n`);
} else {
  fail("usage: profiles.cjs path|list|show <name>|args <name>|save <name>|save-args <name>|delete <name>");
}
