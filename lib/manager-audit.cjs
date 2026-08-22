#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(2);
}

function expectedRows(source) {
  const rows = [];
  const seen = new Set();
  let currentTask = "";
  let inFinalCriteria = false;
  let finalIndex = 0;
  for (const line of source.split(/\r?\n/)) {
    const task = /^- \[[ xX]\]\s+([A-Z][A-Z0-9-]+)\s+[—-]/.exec(line);
    if (task) {
      currentTask = task[1];
      if (!seen.has(currentTask)) rows.push({ id: currentTask, kind: "task", parent: "" });
      seen.add(currentTask);
      continue;
    }
    if (/^## Acceptance criteria\s*$/.test(line)) {
      inFinalCriteria = true;
      if (!seen.has("RBT-FINAL")) rows.push({ id: "RBT-FINAL", kind: "task", parent: "" });
      seen.add("RBT-FINAL");
      currentTask = "RBT-FINAL";
      continue;
    }
    if (inFinalCriteria && /^##\s+/.test(line)) inFinalCriteria = false;
    const criterion = /^\s+-\s+(AC-[A-Z0-9-]+):\s*/.exec(line);
    if (criterion && !seen.has(criterion[1])) {
      rows.push({ id: criterion[1], kind: "criterion", parent: currentTask });
      seen.add(criterion[1]);
      continue;
    }
    if (inFinalCriteria && /^\s*-\s+\S/.test(line)) {
      finalIndex += 1;
      const id = `AC-RBF-${String(finalIndex).padStart(2, "0")}`;
      rows.push({ id, kind: "criterion", parent: "RBT-FINAL" });
      seen.add(id);
    }
  }
  return rows;
}

function validate(phaseSource, managerSource) {
  const expected = expectedRows(phaseSource);
  const allowed = new Set(["PASS", "FAIL", "UNPROVEN", "HUMAN_PENDING", "NOT_APPLICABLE"]);
  const rows = new Map();
  const duplicates = [];
  const malformed = [];
  const findings = [];
  let auditStatus = "";
  let decision = "";
  for (const line of managerSource.split(/\r?\n/)) {
    const statusMatch = /^RB_RALPH_AUDIT_STATUS:\s*(\S+)\s*$/.exec(line);
    if (statusMatch) auditStatus = statusMatch[1];
    const decisionMatch = /^RB_RALPH_DECISION:\s*(\S+)\s*$/.exec(line);
    if (decisionMatch) decision = decisionMatch[1];
    if (line.startsWith("RB_RALPH_CRITERION:")) {
      const fields = line.slice("RB_RALPH_CRITERION:".length).split("|").map((value) => value.trim());
      if (fields.length < 3 || !fields[0] || !allowed.has(fields[1]) || !fields.slice(2).join(" | ")) {
        malformed.push(line);
        continue;
      }
      if (rows.has(fields[0])) duplicates.push(fields[0]);
      rows.set(fields[0], { id: fields[0], status: fields[1], evidence: fields.slice(2).join(" | ") });
    }
    if (line.startsWith("RB_RALPH_FINDING:")) {
      const fields = line.slice("RB_RALPH_FINDING:".length).split("|").map((value) => value.trim());
      if (fields.length < 5 || fields.some((value) => !value)) malformed.push(line);
      else findings.push({ criteria: fields[0], boundary: fields[1], expected: fields[2], observed: fields[3], evidence: fields.slice(4).join(" | ") });
    }
  }
  const expectedIds = new Set(expected.map((row) => row.id));
  const missing = expected.filter((row) => !rows.has(row.id)).map((row) => row.id);
  const unknown = [...rows.keys()].filter((id) => !expectedIds.has(id));
  const failed = [...rows.values()].filter((row) => ["FAIL", "UNPROVEN"].includes(row.status));
  const uncoveredFailures = failed.filter((row) => !findings.some((finding) =>
    finding.criteria.split(/\s*,\s*/).includes(row.id),
  )).map((row) => row.id);
  const invalidComplete = decision === "COMPLETE"
    ? [...rows.values()].filter((row) => !["PASS", "NOT_APPLICABLE"].includes(row.status)).map((row) => row.id)
    : [];
  const issues = [];
  if (auditStatus !== "COMPLETE") issues.push("RB_RALPH_AUDIT_STATUS must be COMPLETE after the full matrix audit");
  if (!expected.length) issues.push("validated phase exposes no auditable task or criterion IDs");
  if (missing.length) issues.push(`missing matrix rows: ${missing.join(", ")}`);
  if (unknown.length) issues.push(`unknown matrix rows: ${unknown.join(", ")}`);
  if (duplicates.length) issues.push(`duplicate matrix rows: ${[...new Set(duplicates)].join(", ")}`);
  if (malformed.length) issues.push(`malformed structured rows: ${malformed.length}`);
  if (uncoveredFailures.length) issues.push(`failed/unproven rows without structured findings: ${uncoveredFailures.join(", ")}`);
  if (decision === "RETRY" && findings.length === 0) issues.push("RETRY requires at least one structured finding");
  if (invalidComplete.length) issues.push(`COMPLETE has non-passing rows: ${invalidComplete.join(", ")}`);
  return {
    schema: "rb-ralph-manager-audit/v1",
    valid: issues.length === 0,
    auditStatus,
    decision,
    expected,
    rows: [...rows.values()],
    findings,
    counts: {
      expected: expected.length,
      reviewed: rows.size,
      findings: findings.length,
      pass: [...rows.values()].filter((row) => row.status === "PASS").length,
      fail: [...rows.values()].filter((row) => row.status === "FAIL").length,
      unproven: [...rows.values()].filter((row) => row.status === "UNPROVEN").length,
      humanPending: [...rows.values()].filter((row) => row.status === "HUMAN_PENDING").length,
      notApplicable: [...rows.values()].filter((row) => row.status === "NOT_APPLICABLE").length,
    },
    issues,
  };
}

const [command, phasePath, managerPath] = process.argv.slice(2);
if (!command || !phasePath) fail("Usage: manager-audit.cjs expected <phase> | validate <phase> <manager-log>");
const phaseSource = readFileSync(phasePath, "utf8");
if (command === "expected") {
  for (const row of expectedRows(phaseSource)) process.stdout.write(`${row.id}\t${row.kind}\t${row.parent}\n`);
} else if (command === "validate") {
  if (!managerPath) fail("validate requires a manager log");
  const result = validate(phaseSource, readFileSync(managerPath, "utf8"));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 3;
} else fail(`Unknown command: ${command}`);
