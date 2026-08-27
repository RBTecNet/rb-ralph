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
const MAX_DEPENDENCY_FILES = 12;
const MAX_DEPENDENCY_SYMBOLS = 12;

const NON_PRODUCT_SEGMENTS = new Set([
  ".rb", ".rb-harness", ".git", "node_modules", "vendor",
  "__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".tox", ".venv", "venv", ".next", ".turbo",
]);
const NON_PRODUCT_TOP_LEVEL = new Set(["coverage", "dist", "build", "target", "out", "logs", "snapshots"]);
const NON_PRODUCT_BASENAMES = /(?:\.log|\.snap|\.pyc|\.class|\.o|\.a|\.so|\.dylib|\.dll|\.exe|\.bin|\.wasm)$/i;

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

function cleanScopeToken(token) {
  return String(token || "").replace(/\/?\*\*?\/?\*?$/, "").replace(/\/$/, "");
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
  const cleaned = cleanScopeToken(token);
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

function isProductCataloguePath(root, candidate) {
  const normalized = String(candidate || "").split("\\").join("/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../")) return false;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => NON_PRODUCT_SEGMENTS.has(segment))) return false;
  if (NON_PRODUCT_TOP_LEVEL.has(segments[0])) return false;
  if (NON_PRODUCT_BASENAMES.test(normalized)) return false;
  const absolute = insideRoot(root, normalized);
  if (!absolute) return false;
  try {
    if (!fs.statSync(absolute).isFile()) return false;
    const descriptor = fs.openSync(absolute, "r");
    try {
      const buffer = Buffer.alloc(512);
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      return !buffer.subarray(0, bytes).includes(0);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // Snapshot catalogues may describe a path that disappeared during the
    // attempt. Known control/build/log paths are still filtered; an unavailable
    // ordinary path remains useful as a name.
    return true;
  }
}

function coveredIds(task) {
  const values = [];
  for (const match of String(task?.covers || "").matchAll(/\b[A-Z][A-Z0-9]*-[A-Z0-9-]+\b/g)) {
    if (!values.includes(match[0])) values.push(match[0]);
  }
  return values;
}

function markdownSections(source, ids) {
  const wanted = new Set(ids);
  const lines = String(source || "").split(/\r?\n/);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (heading) headings.push({ index, level: heading[1].length, title: heading[2] });
  }
  const found = [];
  for (let offset = 0; offset < headings.length; offset += 1) {
    const heading = headings[offset];
    const matches = [...wanted].filter((id) => new RegExp(`(^|[^A-Z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9-]|$)`).test(heading.title));
    if (!matches.length) continue;
    let end = lines.length;
    for (let next = offset + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) { end = headings[next].index; break; }
    }
    found.push({ ids: matches, text: lines.slice(heading.index, end).join("\n").trimEnd() });
  }
  return found;
}

function exactContextSections(root, files, ids) {
  const sections = [];
  const resolved = new Set();
  for (const absolute of files) {
    let source;
    try { source = fs.readFileSync(absolute, "utf8"); } catch { continue; }
    for (const section of markdownSections(source, ids)) {
      const fresh = section.ids.filter((id) => !resolved.has(id));
      if (!fresh.length) continue;
      sections.push({ path: relative(root, absolute), ids: fresh, text: section.text });
      for (const id of fresh) resolved.add(id);
    }
  }
  return { sections, missing: ids.filter((id) => !resolved.has(id)) };
}

function loadTaskCatalogue(tasksPath) {
  const tasks = [];
  const seen = new Set();
  const candidates = [];
  if (tasksPath) candidates.push(tasksPath);
  try {
    const directory = path.dirname(tasksPath);
    for (const name of fs.readdirSync(directory)) {
      if (/-tasks\.json$/.test(name)) candidates.push(path.join(directory, name));
    }
  } catch { /* one fixture file is still a complete deterministic catalogue */ }
  for (const candidate of candidates) {
    const values = readJson(candidate, []);
    if (!Array.isArray(values)) continue;
    for (const task of values) {
      if (!task?.id || seen.has(task.id)) continue;
      tasks.push(task);
      seen.add(task.id);
    }
  }
  return tasks;
}

function publicSymbols(absolute) {
  let source;
  try { source = fs.readFileSync(absolute, "utf8").slice(0, 64 * 1024); } catch { return []; }
  const names = [];
  const patterns = [
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Z][A-Za-z0-9_]*)\b/gm,
    /^\s*(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm,
    /\bpub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!names.includes(match[1])) names.push(match[1]);
    }
  }
  return names;
}

function dependencyBoundary(root, task) {
  const tokens = scopeTokens(task?.scope);
  const files = [];
  for (const token of tokens) {
    for (const absolute of resolveScopeFiles(root, token, MAX_DEPENDENCY_FILES)) {
      if (!files.includes(absolute) && files.length < MAX_DEPENDENCY_FILES) files.push(absolute);
    }
  }
  const symbols = [];
  for (const absolute of files) {
    for (const symbol of publicSymbols(absolute)) {
      if (!symbols.includes(symbol) && symbols.length < MAX_DEPENDENCY_SYMBOLS) symbols.push(symbol);
    }
  }
  return { tokens, files: files.map((absolute) => relative(root, absolute)), symbols };
}

function tokenMatchesPath(token, candidate) {
  const cleaned = cleanScopeToken(token).replace(/^\.\//, "");
  const normalized = String(candidate || "").replace(/^\.\//, "");
  return cleaned === "." || normalized === cleaned || normalized.startsWith(`${cleaned}/`);
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

function fileSection(root, files, seen, out, fileBytes, label, heading = true) {
  let written = 0;
  for (const absolute of files) {
    const name = relative(root, absolute);
    if (seen.has(name)) continue;
    const content = readBounded(absolute, fileBytes);
    if (!content) continue;
    const header = content.truncated
      ? `\n===== ${name} (first ${fileBytes} of ${content.bytes} bytes) =====`
      : `\n===== ${name} =====`;
    if (!out.push(`${heading ? header : ""}\n${content.text}`)) {
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

  const tasks = loadTaskCatalogue(options.tasksPath);
  const task = tasks.find((entry) => entry && entry.id === options.taskId);
  const declared = options.phaseFile ? contextPathsFrom(options.phaseFile) : [];
  const contextPaths = [...(options.contextPaths || []), ...declared]
    .map((entry) => insideRoot(root, entry))
    .filter((entry, index, values) => entry && fs.existsSync(entry) && values.indexOf(entry) === index);

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

  // 2. Exact structured sections named by Covers. These are selected by ID and
  //    heading boundaries, never by keyword relevance or document order.
  const criteria = coveredIds(task);
  if (criteria.length) {
    const exact = exactContextSections(root, contextPaths, criteria);
    if (exact.sections.length) out.push(`\n--- EXACT COVERED REQUIREMENTS ---`);
    for (const section of exact.sections) {
      const value = `\n===== ${section.path} :: ${section.ids.join(", ")} =====\n${section.text}`;
      if (!out.push(value)) out.omit(`covered requirement ${section.ids.join(", ")}`);
    }
    if (exact.missing.length) out.omit(`covered IDs not found in declared context: ${exact.missing.join(", ")}`);
  }

  // 3. The dependency map carries producer boundaries and deterministic public
  //    names, not the dependency implementations. Prior phase task JSON files
  //    in the same state directory extend the current TASK_DETAILS_FILE.
  const dependencyIds = Array.isArray(task?.dependsOn) ? task.dependsOn : [];
  if (dependencyIds.length) {
    const lines = [];
    for (const dependencyId of dependencyIds) {
      const dependency = tasks.find((entry) => entry.id === dependencyId);
      if (!dependency) {
        lines.push(`${dependencyId}\n  [task details omitted: dependency is outside the generated task catalogue]`);
        continue;
      }
      const boundary = dependencyBoundary(root, dependency);
      lines.push([
        `${dependencyId} — ${dependency.title || "dependency"}`,
        `  scope: ${dependency.scope || "[not declared]"}`,
        `  existing files: ${boundary.files.length ? boundary.files.join(", ") : "[none found]"}`,
        `  public names: ${boundary.symbols.length ? boundary.symbols.join(", ") : "[no deterministic symbols found]"}`,
        boundary.files.length >= MAX_DEPENDENCY_FILES ? "  [additional files omitted]" : "",
        boundary.symbols.length >= MAX_DEPENDENCY_SYMBOLS ? "  [additional public names omitted]" : "",
      ].filter(Boolean).join("\n"));
    }
    if (!out.push(`\n--- DECLARED DEPENDENCY BOUNDARIES ---\n${lines.join("\n\n")}`)) {
      out.omit(`dependency map for ${dependencyIds.join(", ")}`);
    }
  }

  // 4. Only changed paths intersecting this task or its declared dependencies
  //    are useful pre-load. Other phase changes remain discoverable in evidence.
  const changes = readJson(options.changesPath, undefined);
  const changed = changes
    ? [...(changes.addedPaths || changes.added || []), ...(changes.modifiedPaths || changes.modified || [])]
      .filter((entry) => typeof entry === "string")
    : [];
  const boundaryTasks = [task, ...dependencyIds.map((id) => tasks.find((entry) => entry.id === id))].filter(Boolean);
  const boundaryTokens = boundaryTasks.flatMap((entry) => scopeTokens(entry.scope));
  const relevantChanged = boundaryTokens.length
    ? changed.filter((entry) => boundaryTokens.some((token) => tokenMatchesPath(token, entry)))
    : [];
  if (relevantChanged.length) {
    const listed = relevantChanged.slice(0, MAX_CHANGED_ENTRIES);
    out.push(`\n--- CHANGED EARLIER IN THIS PHASE ---\n${listed.join("\n")}`
      + (relevantChanged.length > listed.length ? `\n[and ${relevantChanged.length - listed.length} more]` : ""));
  }

  // 5. The reduced product tree excludes control planes, execution evidence,
  //    dependency caches, build outputs, logs, snapshots, and binary files.
  const before = readJson(options.beforePath, undefined);
  const catalogue = before && before.files && typeof before.files === "object" ? Object.keys(before.files) : [];
  const tree = catalogue.filter((entry) => isProductCataloguePath(root, entry)).sort();
  if (tree.length) {
    const listed = tree.slice(0, MAX_TREE_ENTRIES);
    out.push(`\n--- PROJECT FILES (from the orchestrator's snapshot) ---\n${listed.join("\n")}`
      + (tree.length > listed.length ? `\n[and ${tree.length - listed.length} more]` : ""));
  }

  // 6. General document prefixes are strictly last. Exact covered sections
  //    above therefore cannot be displaced by RF-001..RF-013 appearing first.
  if (contextPaths.length) {
    out.push(`\n--- REMAINING PHASE CONTEXT (bounded prefixes) ---`);
    const written = fileSection(root, contextPaths, seen, out, options.fileBytes, "remaining phase context");
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

module.exports = {
  build, buildManagerContext, scopeTokens, resolveScopeFiles, contextPathsFrom,
  coveredIds, markdownSections, isProductCataloguePath, loadTaskCatalogue,
};
