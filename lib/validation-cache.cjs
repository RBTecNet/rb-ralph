#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { existsSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { mkdirSync } = require("node:fs");

const CONTRACT = "rb-ralph-validation-cache/v1";

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(2);
}

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function cleanPath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function scopeTokens(scope) {
  const tokens = [...String(scope).matchAll(/`([^`]+)`/g)]
    .map((match) => cleanPath(match[1].trim()))
    .filter(Boolean);
  if (!tokens.length) return [];
  return tokens.flatMap((token) => token.split(/\s*,\s*/)).filter(Boolean);
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function tokenMatches(token, path) {
  const normalized = cleanPath(token);
  if (!normalized || normalized === "." || normalized === "*") return true;
  if (/[?*]/.test(normalized)) {
    const pattern = escapeRegex(normalized)
      .replace(/\\\*\\\*/g, ".*")
      .replace(/\\\*/g, "[^/]*")
      .replace(/\\\?/g, "[^/]");
    return new RegExp(`^${pattern}(?:/.*)?$`).test(path);
  }
  const prefix = normalized.replace(/\/$/, "");
  return path === prefix || path.startsWith(`${prefix}/`);
}

function key(kind, value) {
  return createHash("sha256").update(`${kind}\0${value}`).digest("hex");
}

function loadCache(path) {
  const value = readJson(path, { contract: CONTRACT, entries: {} });
  if (value.contract !== CONTRACT || !value.entries || typeof value.entries !== "object") {
    return { contract: CONTRACT, entries: {} };
  }
  return value;
}

function writeCache(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function affectedTasks(tasks, changes) {
  const paths = ["added", "modified", "deleted"].flatMap((kind) => changes[kind] ?? []).map(cleanPath);
  const pending = tasks.filter((task) => !task.done);
  if (!paths.length || (changes.limitations ?? []).length) {
    return { ids: new Set(pending.map((task) => task.id)), fallback: true, reason: !paths.length ? "no changed paths could prove a bounded impact" : "changed-path evidence is incomplete" };
  }
  const tokens = new Map();
  for (const task of pending) {
    const parsed = scopeTokens(task.scope);
    if (!parsed.length) {
      return { ids: new Set(pending.map((entry) => entry.id)), fallback: true, reason: `task ${task.id} has no machine-bounded backtick scope` };
    }
    tokens.set(task.id, parsed);
  }
  const ids = new Set();
  for (const path of paths) {
    const matches = pending.filter((task) => tokens.get(task.id).some((token) => tokenMatches(token, path)));
    if (!matches.length) {
      return { ids: new Set(pending.map((entry) => entry.id)), fallback: true, reason: `changed path ${path} is outside every declared task scope` };
    }
    for (const task of matches) ids.add(task.id);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const task of pending) {
      if (!ids.has(task.id) && task.dependsOn.some((dependency) => ids.has(dependency))) {
        ids.add(task.id);
        expanded = true;
      }
    }
  }
  return { ids, fallback: false, reason: "declared task scopes cover every changed path" };
}

function select(tasksPath, validationsPath, changesPath, cachePath) {
  const tasks = readJson(tasksPath, []);
  const validations = readJson(validationsPath, []);
  const changes = readJson(changesPath, {});
  const cache = loadCache(cachePath);
  const impact = affectedTasks(tasks, changes);
  const grouped = new Map();
  for (const validation of validations) {
    const groupKey = key(validation.kind, validation.value);
    const group = grouped.get(groupKey) ?? {
      key: groupKey, kind: validation.kind, value: validation.value, taskIds: [],
    };
    if (!group.taskIds.includes(validation.taskId)) group.taskIds.push(validation.taskId);
    grouped.set(groupKey, group);
  }
  process.stdout.write(`meta\timpact\t${impact.fallback ? "full" : "affected"}\t${impact.reason.replace(/[\t\r\n]+/g, " ")}\n`);
  for (const group of grouped.values()) {
    let action = "observe";
    let provenance = "";
    if (group.kind === "command") {
      const cached = cache.entries[group.key];
      const invalidated = group.taskIds.some((taskId) => impact.ids.has(taskId));
      if (!invalidated && cached?.exitCode === 0) {
        action = "reuse";
        provenance = String(cached.evidence ?? "").replace(/[\t\r\n]+/g, " ");
      } else {
        action = "run";
      }
    }
    process.stdout.write([
      group.taskIds.join(","), group.kind, group.value, action, group.key, provenance,
    ].join("\t") + "\n");
  }
}

function record(cachePath, cacheKey, taskIds, kind, value, exitCode, evidence) {
  const cache = loadCache(cachePath);
  cache.entries[cacheKey] = {
    taskIds: taskIds.split(",").filter(Boolean), kind, value,
    exitCode: Number(exitCode), evidence, recordedAt: new Date().toISOString(),
  };
  writeCache(cachePath, cache);
}

const [command, ...args] = process.argv.slice(2);
if (command === "select" && args.length === 4) select(...args);
else if (command === "record" && args.length === 7) record(...args);
else fail("Usage: validation-cache.cjs select <tasks.json> <validations.json> <changes.json> <cache.json> | record <cache.json> <key> <task-ids> <kind> <value> <exit> <evidence>");
