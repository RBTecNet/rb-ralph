#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { mkdir, readFile, readdir, readlink, rename, stat, writeFile } = require("node:fs/promises");
const { basename, dirname, relative, resolve, sep } = require("node:path");

const EXCLUDED_DIRECTORIES = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "coverage", ".next", "target", ".cache",
]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function isSecretLike(path) {
  const name = basename(path);
  return name === ".env"
    || name.startsWith(".env.")
    || /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials)(?:\..+)?$/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name);
}

function projectPath(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value === "..") throw new Error(`Unsafe project path: ${path}`);
  return value;
}

async function snapshot(root) {
  const files = {};
  const limitations = [];
  let visited = 0;

  async function walk(directory) {
    if (visited >= MAX_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (visited >= MAX_FILES) break;
      const path = resolve(directory, entry.name);
      const rel = projectPath(root, path);
      if (isSecretLike(path)) continue;
      if (entry.isSymbolicLink()) {
        visited += 1;
        const target = await readlink(path);
        files[rel] = {
          sha256: createHash("sha256").update(target).digest("hex"),
          bytes: Buffer.byteLength(target),
          kind: "symlink",
        };
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name) || rel === ".rb/runs" || rel.startsWith(".rb/runs/")) continue;
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const metadata = await stat(path);
      if (metadata.size > MAX_FILE_BYTES) {
        limitations.push(`Skipped oversized file: ${rel}`);
        continue;
      }
      const hash = createHash("sha256").update(await readFile(path)).digest("hex");
      files[rel] = { sha256: hash, bytes: metadata.size };
    }
  }

  await walk(root);
  if (visited >= MAX_FILES) limitations.push(`File scan reached the ${MAX_FILES}-file safety limit.`);
  return { schema: "rb-ralph-evidence/v1", root, files, limitations };
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
  const [command, rawRoot, firstPath, secondPath] = process.argv.slice(2);
  if (!command || !rawRoot || !firstPath) {
    throw new Error("Usage: evidence.cjs snapshot <project> <output> | diff <project> <before> <output>");
  }
  const root = resolve(rawRoot);
  if (command === "snapshot") {
    await atomicJson(resolve(firstPath), await snapshot(root));
    return;
  }
  if (command !== "diff" || !secondPath) {
    throw new Error("Usage: evidence.cjs snapshot <project> <output> | diff <project> <before> <output>");
  }
  const before = JSON.parse(await readFile(resolve(firstPath), "utf8"));
  const after = await snapshot(root);
  const beforeFiles = before.files ?? {};
  const afterFiles = after.files ?? {};
  const added = [];
  const modified = [];
  const deleted = [];
  let unchanged = 0;
  for (const path of Object.keys(afterFiles).sort()) {
    if (!beforeFiles[path]) added.push(path);
    else if (beforeFiles[path].sha256 !== afterFiles[path].sha256) modified.push(path);
    else unchanged += 1;
  }
  for (const path of Object.keys(beforeFiles).sort()) {
    if (!afterFiles[path]) deleted.push(path);
  }
  await atomicJson(resolve(secondPath), {
    schema: "rb-ralph-changes/v1",
    projectRoot: root,
    added,
    modified,
    deleted,
    unchanged,
    limitations: [...(before.limitations ?? []), ...(after.limitations ?? [])],
  });
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
