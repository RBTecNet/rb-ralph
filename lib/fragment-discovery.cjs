#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { lstat, mkdir, readFile, readdir, realpath, writeFile } = require("node:fs/promises");
const { basename, relative, resolve, sep } = require("node:path");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function posix(path) {
  return path.split(sep).join("/");
}

function slug(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52) || "imported-plan";
}

function oneLine(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

async function regularDirectoryInside(project, candidate) {
  const projectRoot = await realpath(resolve(project));
  const unresolved = resolve(projectRoot, candidate);
  const info = await lstat(unresolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`fragments directory is not a regular directory: ${candidate}`);
  const directory = await realpath(unresolved);
  if (directory === projectRoot || !directory.startsWith(`${projectRoot}${sep}`)) {
    throw new Error(`fragments directory must be inside the project: ${candidate}`);
  }
  return directory;
}

async function candidates(directory) {
  const output = [];
  let visited = 0;
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > 10_000) throw new Error("fragment scan exceeded 10000 directory entries");
      if (entry.isSymbolicLink()) continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (entry.name === "PHASES.md" || entry.name === "project-phases.md")) {
        if (output.length >= 2_000) throw new Error("fragment scan exceeded 2000 compatible phase documents");
        output.push(path);
      }
    }
  }
  await visit(directory);
  return output;
}

async function detectedValidation(project) {
  async function exists(path) {
    try { await lstat(resolve(project, path)); return true; } catch { return false; }
  }
  if (await exists("artisan") && await exists("vendor/bin/sail")) return "vendor/bin/sail test";
  if (await exists("package.json")) {
    try {
      const value = JSON.parse(await readFile(resolve(project, "package.json"), "utf8"));
      if (value?.scripts?.test) {
        if (await exists("pnpm-lock.yaml")) return "pnpm test";
        if (await exists("yarn.lock")) return "yarn test";
        return "npm test";
      }
    } catch {}
  }
  if (await exists("composer.json")) {
    try {
      const value = JSON.parse(await readFile(resolve(project, "composer.json"), "utf8"));
      if (value?.scripts?.test) return "composer test";
    } catch {}
  }
  if (await exists("artisan")) return "php artisan test";
  if (await exists("pytest.ini") || await exists("pyproject.toml")) return "pytest";
  if (await exists("go.mod")) return "go test ./...";
  if (await exists("Cargo.toml")) return "cargo test";
  return "";
}

function taskFields(lines) {
  const values = new Map();
  let active = "";
  const fieldPattern = /^\s+(?:-\s+)?(?:\*\*)?(Arquivos|Files|Mudança|Change|Cobre|Covers|Traces|Acceptance criteria|Critérios de aceitação|Feature tests|Testes|Tests)(?:\*\*)?:\s*(.*)$/i;
  for (const line of lines) {
    const field = line.match(fieldPattern);
    if (field?.[1]) {
      active = field[1].toLowerCase();
      if (!values.has(active)) values.set(active, []);
      if (field[2]?.trim()) values.get(active).push(oneLine(field[2]));
      continue;
    }
    const nested = line.match(/^\s{4,}-\s+(.+)$/);
    if (active && nested?.[1]) values.get(active).push(oneLine(nested[1]));
  }
  const read = (...names) => names.flatMap((name) => values.get(name) ?? []);
  return {
    scope: read("arquivos", "files").join(", "),
    change: read("mudança", "change").join(" "),
    covers: read("cobre", "covers", "traces").join(", "),
    acceptance: read("acceptance criteria", "critérios de aceitação"),
    tests: read("feature tests", "testes", "tests"),
  };
}

function boundedImportedScope(fields, sourcePath) {
  const candidates = [fields.scope, fields.change, ...fields.acceptance, ...fields.tests]
    .flatMap((value) => [...String(value).matchAll(/`([^`]+)`/g)].map((match) => oneLine(match[1])))
    .filter((value) => value && !value.startsWith("/") && value !== "." && value !== "./"
      && !value.startsWith("../") && (value.includes("/") || /\.[A-Za-z0-9_-]+$/.test(value)));
  const unique = [...new Set(candidates)];
  if (!unique.length) unique.push(sourcePath);
  return unique.map((path) => `\`${path}\``).join(", ");
}

function importBeerAndCode(source, sourcePath, validationCommand) {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const malformed = lines.filter((line) => /^## Phase/.test(line) && !/^## Phase [0-9]+:\s+.+/.test(line));
  if (malformed.length) throw new Error(`malformed phase heading: ${oneLine(malformed[0])}`);

  const phaseStarts = [];
  lines.forEach((line, index) => {
    const match = line.match(/^## Phase ([0-9]+):\s+(.+)$/);
    if (match) phaseStarts.push({ index, number: Number(match[1]), title: oneLine(match[2]) });
  });
  if (!phaseStarts.length) throw new Error("no `## Phase N: <title>` headings found");
  phaseStarts.forEach((phase, index) => {
    if (phase.number !== index + 1) throw new Error(`expected Phase ${index + 1}, found Phase ${phase.number}`);
  });

  const title = oneLine(lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "")) || basename(sourcePath);
  const sourceHash = sha256(normalized);
  const artifactId = `${slug(sourcePath.replace(/\.[^.]+$/, ""))}-imported-execution`;
  const output = [
    `# RB Execution Plan: ${title}`,
    "",
    "<!-- rb-execution-contract: rb-execution/v1 -->",
    `<!-- rb-artifact-id: ${artifactId} -->`,
    `<!-- imported-source: beer-and-code/v1 ${sourcePath} -->`,
    `<!-- imported-source-sha256: ${sourceHash} -->`,
    "",
  ];
  let taskNumber = 0;
  let previousTask = "";

  phaseStarts.forEach((phase, phaseIndex) => {
    const end = phaseStarts[phaseIndex + 1]?.index ?? lines.length;
    const body = lines.slice(phase.index + 1, end);
    const starts = [];
    body.forEach((line, index) => {
      const named = line.match(/^- \[([ xX])\] (T[0-9]+)\s+[—-]\s+(.+)$/);
      const generic = line.match(/^- \[([ xX])\] \*\*Task:\*\*\s+(.+)$/);
      if (named) starts.push({ index, done: named[1].toLowerCase() === "x", title: oneLine(named[3]) });
      else if (generic) starts.push({ index, done: generic[1].toLowerCase() === "x", title: oneLine(generic[2]) });
    });
    if (!starts.length) throw new Error(`Phase ${phase.number} has no supported checkbox tasks`);

    const context = [];
    for (const line of body) {
      const item = line.match(/^\s*[0-9]+\.\s+(`?\.?[^`]+`?)\s+(?:—|-)\s+/);
      if (item?.[1]) context.push(oneLine(item[1]));
      if (/^- \[/.test(line)) break;
    }
    if (!context.length) context.push(`\`${sourcePath}\``);
    const goalMatch = body.map(oneLine).find((line) => line.startsWith("**Goal:**"));
    const goal = goalMatch ? oneLine(goalMatch.replace(/^\*\*Goal:\*\*/, "").split("·")[0]) : phase.title;
    const phaseId = `P${String(phase.number).padStart(2, "0")}`;

    output.push(
      `## Phase ${phase.number}: ${phase.title}`,
      "",
      `**Phase ID:** ${phaseId}`,
      `**Goal:** ${goal || phase.title}`,
      `**Depends on:** ${phase.number === 1 ? "none" : `P${String(phase.number - 1).padStart(2, "0")}`}`,
      "**Context:**",
      ...context.map((entry) => `- ${entry}`),
      "",
    );

    starts.forEach((start, index) => {
      const taskEnd = starts[index + 1]?.index ?? body.length;
      const fields = taskFields(body.slice(start.index + 1, taskEnd));
      if (!fields.acceptance.length) throw new Error(`Phase ${phase.number} task ${index + 1} has no acceptance criteria`);
      taskNumber += 1;
      const taskId = `T${String(taskNumber).padStart(3, "0")}`;
      const dependency = previousTask || "none";
      const validation = validationCommand
        ? `\`${validationCommand}\``
        : `manual: inspect source-task acceptance evidence and relevant project tests`;
      const scope = boundedImportedScope(fields, sourcePath);
      output.push(
        `- [${start.done ? "x" : " "}] ${taskId} — ${start.title}`,
        `  - **Scope:** ${scope}`,
        `  - **Change:** ${fields.change || start.title}`,
        `  - **Covers:** ${fields.covers || "imported source task"}`,
        `  - **Depends on:** ${dependency}`,
        "  - **Parallel safe:** false",
        "  - **Acceptance criteria:**",
        ...fields.acceptance.map((criterion, criterionIndex) => `    - AC-${taskId}-${String(criterionIndex + 1).padStart(2, "0")}: ${criterion}`),
        "  - **Validation:**",
        `    - ${validation}`,
        `  - **Expected evidence:** Source changes, regression coverage, ${fields.tests.length ? fields.tests.join("; ") : "and evidence for every imported acceptance criterion"}.`,
        "",
      );
      previousTask = taskId;
    });
  });

  return { artifactId, sourceHash, markdown: `${output.join("\n").trim()}\n` };
}

async function main() {
  const [command, projectArg, fragmentsArg, outputArg] = process.argv.slice(2);
  if (command !== "discover" || !projectArg || !fragmentsArg || !outputArg) {
    throw new Error("usage: fragment-discovery.cjs discover <project> <fragments-dir> <output-dir>");
  }
  const project = resolve(projectArg);
  const fragments = await regularDirectoryInside(project, fragmentsArg);
  const outputDirectory = resolve(outputArg);
  await mkdir(outputDirectory, { recursive: true });
  const validationCommand = await detectedValidation(project);
  const rows = [];
  const errors = [];
  for (const path of await candidates(fragments)) {
    const sourcePath = posix(relative(project, path));
    try {
      const imported = importBeerAndCode(await readFile(path, "utf8"), sourcePath, validationCommand);
      const canonicalHash = sha256(imported.markdown);
      const canonicalPath = resolve(outputDirectory, `${imported.artifactId}-${canonicalHash.slice(0, 12)}.md`);
      await writeFile(canonicalPath, imported.markdown, { encoding: "utf8", mode: 0o600 });
      rows.push([imported.artifactId, "execution-plan", "ready", "rb-execution/v1", sourcePath, canonicalHash, canonicalPath, "beer-and-code/v1"]);
    } catch (error) {
      errors.push(`${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!rows.length) throw new Error(`no compatible phase documents found${errors.length ? `; ${errors.join("; ")}` : ""}`);
  process.stdout.write("id\tkind\tstatus\tcontract\tpath\tsha256\tcanonical_path\tsource_format\n");
  for (const row of rows) process.stdout.write(`${row.join("\t")}\n`);
  for (const error of errors) process.stderr.write(`WARNING: skipped incompatible fragment ${error}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { importBeerAndCode };
