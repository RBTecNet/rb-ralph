#!/usr/bin/env node
"use strict";

// Bounded redaction: only values Ralph already possesses are replaced. This is
// intentionally not a heuristic secret detector.
const { createHash } = require("node:crypto");
const { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } = require("node:fs");
const { dirname, join, relative, resolve } = require("node:path");

function fail(message) { process.stderr.write(`ERROR: ${message}\n`); process.exit(2); }
function names(value) { return String(value || "").split(",").map((entry) => entry.trim()).filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)); }
function addValue(values, value) { if (typeof value === "string" && value.length >= 4) values.add(value); }

function knownValues(environmentNames, operationalPath) {
  const values = new Set();
  for (const name of names(environmentNames)) addValue(values, process.env[name]);
  for (const value of String(process.env.RB_RALPH_REDACT_CREDENTIALS || "").split("\u001c")) addValue(values, value);
  if (operationalPath && existsSync(operationalPath)) {
    const contract = JSON.parse(readFileSync(operationalPath, "utf8"));
    for (const name of contract.environment?.inherit || []) addValue(values, process.env[name]);
    for (const value of Object.values(contract.environment?.set || {})) addValue(values, String(value));
    for (const scenario of contract.scenarios || []) for (const step of scenario.steps || []) {
      for (const value of Object.values(step.command?.env || {})) addValue(values, String(value));
    }
  }
  return [...values].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactBuffer(buffer, values) {
  let text = buffer.toString("utf8");
  for (const value of values) text = text.split(value).join("<RB_RALPH_REDACTED>");
  return Buffer.from(text, "utf8");
}

function atomicWrite(path, data) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}

function redactFile(source, target, values) { atomicWrite(target, redactBuffer(readFileSync(source), values)); }

function redactTree(source, target, values) {
  const root = resolve(source);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const from = join(root, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      redactTree(from, to, values);
    } else if (entry.isFile()) {
      redactFile(from, to, values);
    } else {
      // Preserve the original shape for the control-plane verifier, which will
      // reject unsupported provider-submitted file types after this copy.
      cpSync(from, to, { dereference: false });
    }
  }
}

const [command, source, target, environmentNames, operationalPath] = process.argv.slice(2);
if (!source || !target || !["redact", "copy-tree"].includes(command)) {
  fail("Usage: evidence-sanitizer.cjs redact <source> <target> [env-names] [OPERATIONS.json] | copy-tree <source-dir> <target-dir> [env-names] [OPERATIONS.json]");
}
const values = knownValues(environmentNames, operationalPath);
if (command === "redact") redactFile(source, target, values);
else {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  redactTree(source, target, values);
}
