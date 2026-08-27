#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { mkdir, readFile, readdir, readlink, rename, stat, writeFile } = require("node:fs/promises");
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

function controlledPath(root, path) {
  const value = relative(root, resolve(path)).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../")) {
    throw new Error(`Path is outside the control-plane root: ${path}`);
  }
  return value;
}

async function fileMetadata(path, entry) {
  if (entry.isSymbolicLink()) {
    const target = await readlink(path);
    return {
      kind: "symlink",
      bytes: Buffer.byteLength(target),
      sha256: createHash("sha256").update(target).digest("hex"),
    };
  }
  if (entry.isFile()) {
    const metadata = await stat(path);
    return {
      kind: "file",
      bytes: metadata.size,
      sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
    };
  }
  return { kind: "special" };
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
      if (MUTABLE_RUNTIME_FILES.has(rel)) continue;
      files[rel] = await fileMetadata(path, entry);
    }
  }
  await walk(root);
  return { schema: "rb-ralph-control-plane/v1", root, files };
}

async function receipt(root, target, receiptDirectory) {
  const path = resolve(target);
  const rel = controlledPath(root, path);
  if (MUTABLE_RUNTIME_FILES.has(rel) || rel === ".lock" || rel.startsWith(".lock/")) return;
  const parent = dirname(path);
  const name = path.slice(parent.length + 1);
  const entry = (await readdir(parent, { withFileTypes: true })).find((candidate) => candidate.name === name);
  if (!entry || !entry.isFile()) {
    throw new Error(`Canonical control-plane receipt requires a regular file: ${rel}`);
  }
  const value = {
    schema: "rb-ralph-control-plane-receipt/v1",
    path: rel,
    metadata: await fileMetadata(path, entry),
  };
  const receiptPath = resolve(receiptDirectory, `${createHash("sha256").update(rel).digest("hex")}.json`);
  await atomicJson(receiptPath, value);
}

async function receiptTree(root, target, receiptDirectory) {
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else await receipt(root, child, receiptDirectory);
    }
  }
  await walk(resolve(target));
}

async function receipts(path) {
  const values = new Map();
  const entries = await readdir(resolve(path), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = JSON.parse(await readFile(resolve(path, entry.name), "utf8"));
    if (value.schema !== "rb-ralph-control-plane-receipt/v1" || !value.path || !value.metadata) {
      throw new Error(`Invalid control-plane receipt: ${entry.name}`);
    }
    values.set(value.path, value.metadata);
  }
  return values;
}

function metadataEqual(left, right) {
  return left?.kind === right?.kind && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

async function main() {
  const [command, rawRoot, beforePath, outputPath, fifthPath] = process.argv.slice(2);
  if (!command || !rawRoot || !beforePath) {
    throw new Error("Usage: control-plane.cjs snapshot <run-dir> <output> | diff <run-dir> <before> <output> | receipt <run-dir> <file> <receipts-dir> | receipt-tree <run-dir> <directory> <receipts-dir> | verify <run-dir> <before> <receipts-dir> <output>");
  }
  const root = resolve(rawRoot);
  if (command === "snapshot") {
    await atomicJson(resolve(beforePath), await snapshot(root));
    return;
  }
  if (command === "receipt" && outputPath) {
    await receipt(root, resolve(beforePath), resolve(outputPath));
    return;
  }
  if (command === "receipt-tree" && outputPath) {
    await receiptTree(root, resolve(beforePath), resolve(outputPath));
    return;
  }
  if ((command !== "diff" && command !== "verify") || !outputPath || (command === "verify" && !fifthPath)) {
    throw new Error("Usage: control-plane.cjs snapshot <run-dir> <output> | diff <run-dir> <before> <output> | receipt <run-dir> <file> <receipts-dir> | receipt-tree <run-dir> <directory> <receipts-dir> | verify <run-dir> <before> <receipts-dir> <output>");
  }
  const before = JSON.parse(await readFile(resolve(beforePath), "utf8"));
  const after = await snapshot(root);
  const output = command === "verify" ? resolve(fifthPath) : resolve(outputPath);
  const receiptValues = command === "verify" ? await receipts(resolve(outputPath)) : new Map();
  const added = [];
  const authorizedAdded = [];
  const modified = [];
  const deleted = [];
  for (const [path, prior] of Object.entries(before.files ?? {})) {
    const current = after.files[path];
    if (!current) deleted.push(path);
    else if (!metadataEqual(current, prior)) modified.push(path);
  }
  for (const [path, current] of Object.entries(after.files ?? {})) {
    if (before.files?.[path]) continue;
    if (command === "verify" && metadataEqual(receiptValues.get(path), current)) authorizedAdded.push(path);
    else added.push(path);
  }
  await atomicJson(output, {
    schema: "rb-ralph-control-plane-diff/v1",
    added: added.sort(),
    authorizedAdded: authorizedAdded.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
  });
  if (modified.length || deleted.length || (command === "verify" && added.length)) process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
