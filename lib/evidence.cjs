#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { lstat, mkdir, readFile, readdir, readlink, rename, stat, writeFile } = require("node:fs/promises");
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

async function snapshot(root, sealed = false) {
  const files = {};
  const limitations = [];
  let visited = 0;

  async function walk(directory) {
    if (!sealed && visited >= MAX_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!sealed && visited >= MAX_FILES) break;
      const path = resolve(directory, entry.name);
      const rel = projectPath(root, path);
      if (!sealed && isSecretLike(path)) continue;
      if (entry.isSymbolicLink()) {
        visited += 1;
        const target = await readlink(path);
        const metadata = await lstat(path);
        files[rel] = {
          sha256: createHash("sha256").update(target).digest("hex"),
          bytes: Buffer.byteLength(target),
          kind: "symlink",
          mode: metadata.mode & 0o777,
        };
        continue;
      }
      if (entry.isDirectory()) {
        if ((!sealed && EXCLUDED_DIRECTORIES.has(entry.name)) || entry.name === ".git" || rel === ".rb/runs" || rel.startsWith(".rb/runs/")) continue;
        if (sealed) {
          const metadata = await stat(path);
          files[`${rel}/`] = { kind: "directory", mode: metadata.mode & 0o777 };
        }
        await walk(path);
        continue;
      }
      if (!entry.isFile()) {
        if (sealed) {
          const metadata = await lstat(path);
          files[rel] = { kind: "special", mode: metadata.mode & 0o777 };
        }
        continue;
      }
      visited += 1;
      const metadata = await stat(path);
      if (!sealed && metadata.size > MAX_FILE_BYTES) {
        limitations.push(`Skipped oversized file: ${rel}`);
        continue;
      }
      const hash = createHash("sha256").update(await readFile(path)).digest("hex");
      files[rel] = { sha256: hash, bytes: metadata.size, kind: "file", mode: metadata.mode & 0o777 };
    }
  }

  await walk(root);
  if (!sealed && visited >= MAX_FILES) limitations.push(`File scan reached the ${MAX_FILES}-file safety limit.`);
  return { schema: sealed ? "rb-ralph-product-seal/v1" : "rb-ralph-evidence/v1", root, files, limitations };
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function snapshotDigest(snapshot) {
  // A seal is deliberately the correctness representation, distinct from the
  // bounded manager-facing evidence index.  Hash only its observable entries
  // so the location of a checkout never changes proof identity.
  const canonical = Object.keys(snapshot.files ?? {}).sort().map((path) => [path, snapshot.files[path]]);
  return createHash("sha256").update(JSON.stringify({ schema: snapshot.schema, files: canonical })).digest("hex");
}

async function main() {
  const [command, rawRoot, firstPath, secondPath] = process.argv.slice(2);
  if (!command || !rawRoot || !firstPath) {
    throw new Error("Usage: evidence.cjs snapshot <project> <output> | seal-digest <project> <snapshot> | diff <project> <before> <output>");
  }
  const root = resolve(rawRoot);
  const sealed = command === "seal-snapshot" || command === "seal-diff";
  if (command === "seal-digest") {
    const snapshot = JSON.parse(await readFile(resolve(firstPath), "utf8"));
    if (snapshot.schema !== "rb-ralph-product-seal/v1") throw new Error("seal-digest requires rb-ralph-product-seal/v1");
    process.stdout.write(`${snapshotDigest(snapshot)}\n`);
    return;
  }
  if (command === "snapshot" || command === "seal-snapshot") {
    await atomicJson(resolve(firstPath), await snapshot(root, sealed));
    return;
  }
  if ((command !== "diff" && command !== "seal-diff") || !secondPath) {
    throw new Error("Usage: evidence.cjs snapshot <project> <output> | diff <project> <before> <output> | seal-snapshot <project> <output> | seal-diff <project> <before> <output>");
  }
  const before = JSON.parse(await readFile(resolve(firstPath), "utf8"));
  const after = await snapshot(root, sealed);
  const beforeFiles = before.files ?? {};
  const afterFiles = after.files ?? {};
  const added = [];
  const modified = [];
  const deleted = [];
  let unchanged = 0;
  for (const path of Object.keys(afterFiles).sort()) {
    if (!beforeFiles[path]) added.push(path);
    else if (beforeFiles[path].sha256 !== afterFiles[path].sha256
      || beforeFiles[path].kind !== afterFiles[path].kind
      || (sealed && (beforeFiles[path].bytes !== afterFiles[path].bytes
        || beforeFiles[path].mode !== afterFiles[path].mode))) modified.push(path);
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
