#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { mkdir, readFile, readdir, rename, stat, writeFile } = require("node:fs/promises");
const { dirname, relative, resolve, sep } = require("node:path");

const MUTABLE_RUNTIME_FILES = new Set([
  "dashboard-live.tsv",
  "logs/dashboard-runner.log",
]);

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function snapshot(root) {
  const files = {};
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const rel = relativePath(root, path);
      if (!rel || rel === ".lock" || rel.startsWith(".lock/")) continue;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || MUTABLE_RUNTIME_FILES.has(rel)) continue;
      const metadata = await stat(path);
      files[rel] = {
        bytes: metadata.size,
        sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
      };
    }
  }
  await walk(root);
  return { schema: "rb-ralph-control-plane/v1", root, files };
}

async function main() {
  const [command, rawRoot, beforePath, outputPath] = process.argv.slice(2);
  if (!command || !rawRoot || !beforePath) {
    throw new Error("Usage: control-plane.cjs snapshot <run-dir> <output> | diff <run-dir> <before> <output>");
  }
  const root = resolve(rawRoot);
  if (command === "snapshot") {
    await atomicJson(resolve(beforePath), await snapshot(root));
    return;
  }
  if (command !== "diff" || !outputPath) {
    throw new Error("Usage: control-plane.cjs snapshot <run-dir> <output> | diff <run-dir> <before> <output>");
  }
  const before = JSON.parse(await readFile(resolve(beforePath), "utf8"));
  const after = await snapshot(root);
  const modified = [];
  const deleted = [];
  for (const [path, prior] of Object.entries(before.files ?? {})) {
    const current = after.files[path];
    if (!current) deleted.push(path);
    else if (current.sha256 !== prior.sha256 || current.bytes !== prior.bytes) modified.push(path);
  }
  await atomicJson(resolve(outputPath), {
    schema: "rb-ralph-control-plane-diff/v1",
    modified: modified.sort(),
    deleted: deleted.sort(),
  });
  if (modified.length || deleted.length) process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
