#!/usr/bin/env node
"use strict";

// Bounded, non-secret execution identity.  This deliberately records only
// deterministic runners and explicitly named environment inputs; model and
// provider provenance belongs in telemetry, not deterministic proof identity.
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

const CONTRACT = "rb-ralph-execution-identity/v1";

function fail(message) { process.stderr.write(`ERROR: ${message}\n`); process.exit(2); }
function digest(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function writeJson(file, value) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function namedEnvironment(names) {
  return [...new Set(names.filter(Boolean))].sort().map((name) => ({
    name,
    // Presence and a digest are enough to invalidate evidence without placing
    // credentials/tokens in state, logs, prompts, or the run directory.
    present: Object.prototype.hasOwnProperty.call(process.env, name),
    valueDigest: Object.prototype.hasOwnProperty.call(process.env, name) ? digest(process.env[name]) : null,
  }));
}

function toolIdentity(name) {
  if (!name || /[^A-Za-z0-9._+/-]/.test(name)) return null;
  try {
    const output = execFileSync(name, ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return { name, versionDigest: digest(output.slice(0, 4096)) };
  } catch {
    return { name, versionDigest: "unavailable" };
  }
}

function external(output, options) {
  const environment = (options.env || "").split(",").map((entry) => entry.trim()).filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry));
  const tools = (options.tools || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const value = {
    contract: CONTRACT,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    ralphVersion: options.ralphVersion || "unknown",
    runtime: toolIdentity("bash"),
    tools: [...new Set(tools)].sort().map(toolIdentity).filter(Boolean),
    inheritedEnvironment: namedEnvironment(environment),
  };
  value.digest = digest(JSON.stringify(value));
  writeJson(output, value);
  process.stdout.write(`${value.digest}\n`);
}

function operational(output, externalFile, contractPath) {
  const externalIdentity = readJson(externalFile);
  const contract = readJson(contractPath);
  const environment = [
    ...(contract.environment?.inherit || []),
    ...Object.keys(contract.environment?.set || {}),
  ].filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry));
  const value = {
    contract: CONTRACT,
    externalDigest: externalIdentity.digest,
    operationalEnvironment: namedEnvironment(environment),
    // The contract itself is separately persisted; include a digest so its
    // declared clean room and selected environment cannot drift under reuse.
    contractDigest: digest(readFileSync(contractPath)),
  };
  value.digest = digest(JSON.stringify(value));
  writeJson(output, value);
  process.stdout.write(`${value.digest}\n`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "external" && args.length >= 1 && args.length <= 4) {
  external(args[0], { ralphVersion: args[1], env: args[2], tools: args[3] });
} else if (command === "operational" && args.length === 3) {
  operational(...args);
} else {
  fail("Usage: execution-identity.cjs external <output> [ralph-version] [comma-env-names] [comma-tools] | operational <output> <external.json> <OPERATIONS.json>");
}
