#!/usr/bin/env node
"use strict";

/**
 * Pre-computed repository context for a fresh executor call.
 *
 * Every task runs in a new process with no session, so the agent rediscovers
 * the repository from scratch. Measured on a real run: the prompt Ralph handed
 * over was 3.7 KB, and the agent then spent 445k-1520k input tokens per task,
 * with 82% of its shell commands being rediscovery — listing files, grepping
 * for modules, and re-reading the very plan the prompt already contained in
 * extract form.
 *
 * Ralph already knows all of it: the task declares its Scope, the phase
 * declares its Context, and the evidence snapshot catalogues the tree and what
 * earlier tasks changed. This module turns that into a bounded prompt section
 * so the agent starts informed instead of searching.
 *
 * Nothing here is new authority. It is the current repository state, which the
 * executor's own authority order already ranks second, delivered instead of
 * hunted. Everything is bounded and every omission is declared, so a truncated
 * section can never read as a complete one.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TOTAL_BYTES = 48 * 1024;
const DEFAULT_FILE_BYTES = 16 * 1024;
const MAX_TREE_ENTRIES = 400;
const MAX_CHANGED_ENTRIES = 60;

/**
 * Files whose bytes teach a reviewer nothing.
 *
 * A lockfile is a resolved dependency graph, not a decision: one changed
 * `package-lock.json` is 79 KB that would eat the whole review budget and
 * displace the source that actually implements the criteria. The path still
 * appears in the changed-path summary, so nothing is hidden — only its content
 * is left out of the pre-load.
 */
const OPAQUE_CONTENT = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|Gemfile\.lock)$/;

/** Source a reviewer reads first, before configuration or fixtures. */
function reviewPriority(relativePath) {
  if (OPAQUE_CONTENT.test(relativePath)) return 3;
  if (/(?:^|\/)(?:test|tests|spec|__tests__)\//.test(relativePath)) return 1;
  if (/\.(?:json|ya?ml|toml|lock|md)$/.test(relativePath)) return 2;
  return 0;
}

function readJson(target, fallback) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return fallback;
  }
}

/** Backtick-quoted path tokens a task declares in `Scope`. */
function scopeTokens(scope) {
  return [...String(scope || "").matchAll(/`([^`]+)`/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function insideRoot(root, candidate) {
  const resolved = path.resolve(root, candidate);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : undefined;
}

/**
 * Resolve a scope token to concrete readable files.
 *
 * A token may name a file, a directory, or a bounded glob. Only regular files
 * inside the project are returned, and a directory is walked shallowly: the
 * point is to seat the agent in the code it is about to change, not to ship the
 * repository.
 */
function resolveScopeFiles(root, token, budget) {
  const cleaned = token.replace(/\/?\*\*?\/?\*?$/, "").replace(/\/$/, "");
  const target = insideRoot(root, cleaned || ".");
  if (!target) return [];
  let info;
  try {
    info = fs.statSync(target);
  } catch {
    return [];
  }
  if (info.isFile()) return [target];
  if (!info.isDirectory()) return [];
  const found = [];
  const walk = (directory, depth) => {
    if (depth > 2 || found.length >= budget) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= budget) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.isFile()) found.push(absolute);
    }
  };
  walk(target, 0);
  return found;
}

function relative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function readBounded(target, limit) {
  let raw;
  try {
    raw = fs.readFileSync(target);
  } catch {
    return undefined;
  }
  if (raw.includes(0)) return undefined;
  if (raw.byteLength <= limit) return { text: raw.toString("utf8"), truncated: false };
  return { text: raw.subarray(0, limit).toString("utf8"), truncated: true, bytes: raw.byteLength };
}

/** Accumulates sections while enforcing one declared total budget. */
function budgeted(totalBytes) {
  const parts = [];
  let used = 0;
  const omitted = [];
  return {
    push(text) {
      const size = Buffer.byteLength(text, "utf8");
      if (used + size > totalBytes) return false;
      parts.push(text);
      used += size;
      return true;
    },
    omit(label) {
      omitted.push(label);
    },
    render() {
      if (omitted.length) {
        parts.push(`\n[context budget reached; not included: ${omitted.join(", ")}. Open these yourself if a criterion needs them.]`);
      }
      return parts.join("\n");
    },
    get used() {
      return used;
    },
  };
}

function fileSection(root, files, seen, out, fileBytes, label) {
  let written = 0;
  for (const absolute of files) {
    const name = relative(root, absolute);
    if (seen.has(name)) continue;
    const content = readBounded(absolute, fileBytes);
    if (!content) continue;
    const header = content.truncated
      ? `\n===== ${name} (first ${fileBytes} of ${content.bytes} bytes) =====`
      : `\n===== ${name} =====`;
    if (!out.push(`${header}\n${content.text}`)) {
      out.omit(`${label} beyond ${written} file(s)`);
      return written;
    }
    seen.add(name);
    written += 1;
  }
  return written;
}

/** Context paths a validated phase or task extract declares. */
function contextPathsFrom(extractPath) {
  let source;
  try {
    source = fs.readFileSync(extractPath, "utf8");
  } catch {
    return [];
  }
  const start = source.indexOf("**Context:**");
  if (start < 0) return [];
  const block = source.slice(start).split(/\n\s*\n/, 1)[0];
  return [...block.matchAll(/^-\s+`([^`]+)`/gm)].map((match) => match[1].trim()).filter(Boolean);
}

function build(options) {
  const root = path.resolve(options.root);
  const out = budgeted(options.totalBytes);
  const seen = new Set();
  const header = [];

  const tasks = readJson(options.tasksPath, []);
  const task = Array.isArray(tasks) ? tasks.find((entry) => entry && entry.id === options.taskId) : undefined;

  // 1. The files this task declares it will change. Without them the agent's
  //    first move is always to search for what the plan already named.
  if (task) {
    const tokens = scopeTokens(task.scope);
    const files = [];
    for (const token of tokens) {
      for (const absolute of resolveScopeFiles(root, token, 12)) {
        if (!files.includes(absolute)) files.push(absolute);
      }
    }
    const missing = tokens.filter((token) => !insideRoot(root, token.replace(/\/?\*\*?\/?\*?$/, "")) || !fs.existsSync(path.resolve(root, token.replace(/\/?\*\*?\/?\*?$/, ""))));
    if (files.length) {
      header.push(`Declared scope of ${options.taskId}: ${tokens.join(", ")}`);
      out.push(`\n--- CURRENT CONTENT OF THE DECLARED SCOPE ---`);
      const written = fileSection(root, files, seen, out, options.fileBytes, "scope files");
      if (!written) out.omit("scope files");
    }
    if (missing.length) {
      header.push(`Scope paths that do not exist yet (create them): ${missing.join(", ")}`);
    }
  }

  // 2. What earlier tasks in this phase already produced. Rediscovering a
  //    sibling task's output is the second thing every agent did.
  const changes = readJson(options.changesPath, undefined);
  const changed = changes
    ? [...(changes.addedPaths || changes.added || []), ...(changes.modifiedPaths || changes.modified || [])]
      .filter((entry) => typeof entry === "string")
    : [];
  if (changed.length) {
    const listed = changed.slice(0, MAX_CHANGED_ENTRIES);
    out.push(`\n--- CHANGED EARLIER IN THIS PHASE ---\n${listed.join("\n")}`
      + (changed.length > listed.length ? `\n[and ${changed.length - listed.length} more]` : ""));
  }

  // 3. The project tree Ralph already catalogued for its evidence snapshot.
  const before = readJson(options.beforePath, undefined);
  const catalogue = before && before.files && typeof before.files === "object" ? Object.keys(before.files) : [];
  const tree = catalogue.filter((entry) => !entry.startsWith(".rb/")).sort();
  if (tree.length) {
    const listed = tree.slice(0, MAX_TREE_ENTRIES);
    out.push(`\n--- PROJECT FILES (from the orchestrator's snapshot) ---\n${listed.join("\n")}`
      + (tree.length > listed.length ? `\n[and ${tree.length - listed.length} more]` : ""));
  }

  // 4. The phase's own Context documents, so `.rb/` is not re-read by hand.
  const declared = options.phaseFile ? contextPathsFrom(options.phaseFile) : [];
  const contextPaths = [...(options.contextPaths || []), ...declared]
    .map((entry) => insideRoot(root, entry))
    .filter((entry) => entry && fs.existsSync(entry));
  if (contextPaths.length) {
    out.push(`\n--- PHASE CONTEXT DOCUMENTS ---`);
    const written = fileSection(root, contextPaths, seen, out, options.fileBytes, "phase context");
    if (!written) out.omit("phase context documents");
  }

  const body = out.render();
  // A greenfield task declares a scope that does not exist yet. That header is
  // the most useful thing the agent can be told — it stops the search before it
  // starts — so it counts as context even when there is no file body at all.
  if (!body.trim() && !header.length) return "";
  return [
    "",
    "--- PRE-LOADED REPOSITORY CONTEXT ---",
    "The orchestrator already resolved the state below; it is current repository content, not new authority.",
    "Use it instead of listing, grepping, or re-reading these files. Only open something else when a concrete criterion is still unresolved.",
    ...header,
    body,
  ].join("\n");
}

/**
 * Current content of the paths this attempt changed, for the manager.
 *
 * The manager prompt lists changed paths and tells the reviewer to inspect the
 * files in PROJECT_ROOT. It duly does — an observed audit spent 194k input
 * tokens re-reading what the orchestrator had already diffed. Shipping the
 * content removes that round trip without weakening the review: it is the same
 * bytes, from the same tree, at the same moment.
 */
function buildManagerContext(options) {
  const root = path.resolve(options.root);
  const out = budgeted(options.totalBytes);
  const changes = readJson(options.changesPath, undefined);
  if (!changes) return "";
  const paths = [...(changes.addedPaths || changes.added || []), ...(changes.modifiedPaths || changes.modified || [])]
    .filter((entry) => typeof entry === "string" && !entry.startsWith(".rb/"));
  if (!paths.length) return "";
  const files = paths
    .filter((entry) => !OPAQUE_CONTENT.test(entry))
    .sort((left, right) => reviewPriority(left) - reviewPriority(right) || left.localeCompare(right))
    .map((entry) => insideRoot(root, entry))
    .filter((entry) => entry && fs.existsSync(entry));
  if (!files.length) return "";
  const written = fileSection(root, files, new Set(), out, options.fileBytes, "changed files");
  const body = out.render();
  if (!written || !body.trim()) return "";
  return [
    "",
    "--- CURRENT CONTENT OF THE CHANGED PATHS ---",
    `The orchestrator read these ${written} file(s) from PROJECT_ROOT at this attempt's boundary. Review them here instead of re-reading the tree; open anything else only for a criterion these do not settle.`,
    body,
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    totalBytes: DEFAULT_TOTAL_BYTES,
    fileBytes: DEFAULT_FILE_BYTES,
    contextPaths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--root") { options.root = value; index += 1; }
    else if (flag === "--tasks") { options.tasksPath = value; index += 1; }
    else if (flag === "--task") { options.taskId = value; index += 1; }
    else if (flag === "--changes") { options.changesPath = value; index += 1; }
    else if (flag === "--before") { options.beforePath = value; index += 1; }
    else if (flag === "--context") { options.contextPaths.push(value); index += 1; }
    else if (flag === "--phase-file") { options.phaseFile = value; index += 1; }
    else if (flag === "--mode") { options.mode = value; index += 1; }
    else if (flag === "--max-bytes") { options.totalBytes = Number(value) || DEFAULT_TOTAL_BYTES; index += 1; }
    else if (flag === "--max-file-bytes") { options.fileBytes = Number(value) || DEFAULT_FILE_BYTES; index += 1; }
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.stdout.write(options.mode === "manager" ? buildManagerContext(options) : build(options));
  } catch {
    // Context is an optimization: a failure here must never fail the run.
    process.stdout.write("");
  }
}

module.exports = { build, buildManagerContext, scopeTokens, resolveScopeFiles, contextPathsFrom };
