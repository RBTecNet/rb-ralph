#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const LEDGER_HEADER = [
  "finding_id", "phase_id", "opened_attempt", "status", "reason",
  "opened_evidence_sha256", "resolved_attempt", "resolved_evidence_sha256",
  "finding_key", "criteria", "latest_reason", "latest_evidence_sha256",
  "last_seen_attempt",
];

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

function clean(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function normalized(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[`'"“”]/g, "")
    .replace(/:(?:line\s*)?\d+(?:-\d+)?\b/g, ":#")
    .replace(/\s+/g, " ");
}

function normalizedCriteria(value) {
  return clean(value).split(/\s*,\s*/).filter(Boolean).sort().join(",");
}

function findingKey(finding) {
  return createHash("sha256").update([
    normalizedCriteria(finding.criteria),
    normalized(finding.boundary),
    normalized(finding.expected),
  ].join("\0")).digest("hex");
}

function findingReason(finding) {
  return clean(`${finding.criteria}: ${finding.observed}; expected ${finding.expected}; boundary ${finding.boundary}; evidence ${finding.evidence}`);
}

function parseStoredReason(reason) {
  const source = clean(reason);
  const expectedAt = source.indexOf("; expected ");
  const boundaryAt = source.indexOf("; boundary ", expectedAt + 11);
  const evidenceAt = source.indexOf("; evidence ", boundaryAt + 11);
  const criteriaAt = source.indexOf(": ");
  if (criteriaAt < 1 || expectedAt < 0 || boundaryAt < 0 || evidenceAt < 0) return null;
  return {
    criteria: source.slice(0, criteriaAt),
    observed: source.slice(criteriaAt + 2, expectedAt),
    expected: source.slice(expectedAt + 11, boundaryAt),
    boundary: source.slice(boundaryAt + 11, evidenceAt),
    evidence: source.slice(evidenceAt + 11),
  };
}

function ledgerRows(path) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const rows = lines.slice(1).map((line) => {
    const row = line.split("\t");
    while (row.length < LEDGER_HEADER.length) row.push("");
    if (!row[8]) {
      const parsed = parseStoredReason(row[4]);
      if (parsed) {
        row[8] = findingKey(parsed);
        row[9] = normalizedCriteria(parsed.criteria);
      }
    }
    if (!row[10]) row[10] = row[4];
    if (!row[11]) row[11] = row[5];
    if (!row[12]) row[12] = row[2];
    return row.slice(0, LEDGER_HEADER.length);
  });
  return rows;
}

function writeLedger(path, rows) {
  const temporary = `${path}.tmp-${process.pid}`;
  const source = [LEDGER_HEADER, ...rows]
    .map((row) => row.map(clean).join("\t"))
    .join("\n");
  writeFileSync(temporary, `${source}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function newFindingId(rows, phase, attempt) {
  const base = `F-${phase}-A${String(attempt).padStart(3, "0")}`;
  const used = new Set(rows.map((row) => row[0]));
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix).padStart(2, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
}

function openingFingerprint(value) {
  return clean(value).split(":", 1)[0];
}

function resolveAll(rows, phase, attempt, evidenceFingerprint) {
  for (const row of rows) {
    if (row[1] === phase && row[3] === "open" && Number(row[2]) <= Number(attempt)) {
      row[3] = "resolved";
      row[6] = String(attempt);
      row[7] = evidenceFingerprint;
    }
  }
}

function recordFallback(rows, phase, attempt, reason, evidenceFingerprint) {
  const normalizedReason = clean(reason);
  if (!normalizedReason || rows.some((row) => row[1] === phase && row[3] === "open" && row[4] === normalizedReason)) return;
  rows.push([
    newFindingId(rows, phase, attempt), phase, String(attempt), "open",
    normalizedReason, evidenceFingerprint, "", "", "", "",
    normalizedReason, evidenceFingerprint, String(attempt),
  ]);
}

function reconcile(rows, report, phase, attempt, evidenceFingerprint) {
  const current = new Map();
  for (const finding of report.findings ?? []) {
    const key = finding.key || findingKey(finding);
    current.set(key, { ...finding, key, reason: findingReason(finding) });
  }
  let resolved = 0;
  let updated = 0;
  let added = 0;
  for (const row of rows) {
    if (row[1] !== phase || row[3] !== "open" || !row[8] || Number(row[2]) > Number(attempt)) continue;
    const active = current.get(row[8]);
    if (active) {
      const evidenceHash = createHash("sha256").update(active.reason).digest("hex");
      row[9] = normalizedCriteria(active.criteria);
      row[10] = active.reason;
      row[11] = `${evidenceFingerprint}:${evidenceHash}`;
      row[12] = String(attempt);
      current.delete(row[8]);
      updated += 1;
    } else if (openingFingerprint(row[5]) !== evidenceFingerprint) {
      row[3] = "resolved";
      row[6] = String(attempt);
      row[7] = evidenceFingerprint;
      resolved += 1;
    }
  }
  for (const active of current.values()) {
    const evidenceHash = createHash("sha256").update(active.reason).digest("hex");
    const evidence = `${evidenceFingerprint}:${evidenceHash}`;
    rows.push([
      newFindingId(rows, phase, attempt), phase, String(attempt), "open",
      active.reason, evidence, "", "", active.key,
      normalizedCriteria(active.criteria), active.reason, evidence, String(attempt),
    ]);
    added += 1;
  }
  return { added, updated, resolved };
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
      else {
        const finding = { criteria: fields[0], boundary: fields[1], expected: fields[2], observed: fields[3], evidence: fields.slice(4).join(" | ") };
        findings.push({ ...finding, key: findingKey(finding) });
      }
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
  const duplicateFindingKeys = findings
    .filter((finding, index) => findings.findIndex((candidate) => candidate.key === finding.key) !== index)
    .map((finding) => finding.key);
  if (auditStatus !== "COMPLETE") issues.push("RB_RALPH_AUDIT_STATUS must be COMPLETE after the full matrix audit");
  if (!expected.length) issues.push("validated phase exposes no auditable task or criterion IDs");
  if (missing.length) issues.push(`missing matrix rows: ${missing.join(", ")}`);
  if (unknown.length) issues.push(`unknown matrix rows: ${unknown.join(", ")}`);
  if (duplicates.length) issues.push(`duplicate matrix rows: ${[...new Set(duplicates)].join(", ")}`);
  if (malformed.length) issues.push(`malformed structured rows: ${malformed.length}`);
  if (duplicateFindingKeys.length) issues.push(`duplicate structured findings: ${new Set(duplicateFindingKeys).size}`);
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

function reconcileFile(ledgerPath, report, phase, attempt, fingerprint) {
  const rows = ledgerRows(ledgerPath);
  const stats = reconcile(rows, report, phase, attempt, fingerprint);
  writeLedger(ledgerPath, rows);
  return stats;
}

function replay(ledgerPath, logsDirectory, promptsDirectory) {
  const rows = ledgerRows(ledgerPath);
  // Structured rows are derived state. Reset them to their immutable opening
  // record before replaying canonical audits so repeated resumes are idempotent.
  for (const row of rows) {
    if (!row[8]) continue;
    row[3] = "open";
    row[6] = "";
    row[7] = "";
    row[10] = row[4];
    row[11] = row[5];
    row[12] = row[2];
  }
  const reports = readdirSync(logsDirectory)
    .map((name) => {
      const match = /^(.*)-attempt-(\d+)-manager(?:-retry-(\d+))?-audit\.json$/.exec(name);
      return match ? { name, phase: match[1], attempt: Number(match[2]), retry: Number(match[3] ?? 1) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.phase.localeCompare(right.phase)
      || left.attempt - right.attempt || left.retry - right.retry);
  const effective = new Map();
  try {
    for (const line of readFileSync(join(dirname(ledgerPath), "events.tsv"), "utf8").split(/\r?\n/)) {
      const fields = line.split("\t");
      if (!/^\d+$/.test(fields[2] ?? "") || !["RETRY", "COMPLETE", "BLOCKED"].includes(fields[3])) continue;
      effective.set(`${fields[1]}\0${fields[2]}`, { status: fields[3], reason: fields.slice(4).join(" ") });
    }
  } catch { /* a brand-new or legacy run may not have events yet */ }
  let processed = 0;
  for (const entry of reports) {
    let report;
    try { report = JSON.parse(readFileSync(join(logsDirectory, entry.name), "utf8")); }
    catch { continue; }
    if (!report.valid || !["RETRY", "COMPLETE"].includes(report.decision)) continue;
    const promptPath = join(promptsDirectory, `${entry.phase}-attempt-${entry.attempt}-manager.txt`);
    let prompt;
    try { prompt = readFileSync(promptPath, "utf8"); } catch { continue; }
    const fingerprint = /^EVIDENCE_FINGERPRINT:\s*([a-f0-9]{64})\s*$/m.exec(prompt)?.[1];
    if (!fingerprint) continue;
    const outcome = effective.get(`${entry.phase}\0${entry.attempt}`);
    if (!outcome) continue;
    if (outcome.status === "COMPLETE") resolveAll(rows, entry.phase, entry.attempt, fingerprint);
    else if (outcome.status === "RETRY" && report.decision === "RETRY") reconcile(rows, report, entry.phase, entry.attempt, fingerprint);
    else if (outcome.status === "RETRY") recordFallback(rows, entry.phase, entry.attempt, outcome.reason, fingerprint);
    processed += 1;
  }
  writeLedger(ledgerPath, rows);
  return { processed };
}

const [command, firstPath, secondPath, thirdValue, fourthValue, fifthValue] = process.argv.slice(2);
if (!command || !firstPath) fail("Usage: manager-audit.cjs expected <phase> | validate <phase> <manager-log> | reconcile <ledger> <audit> <phase> <attempt> <fingerprint> | replay <ledger> <logs> <prompts>");
if (command === "expected") {
  const phaseSource = readFileSync(firstPath, "utf8");
  for (const row of expectedRows(phaseSource)) process.stdout.write(`${row.id}\t${row.kind}\t${row.parent}\n`);
} else if (command === "validate") {
  if (!secondPath) fail("validate requires a manager log");
  const result = validate(readFileSync(firstPath, "utf8"), readFileSync(secondPath, "utf8"));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 3;
} else if (command === "reconcile") {
  if (!secondPath || !thirdValue || !fourthValue || !fifthValue) fail("reconcile requires ledger, audit, phase, attempt, and fingerprint");
  const report = JSON.parse(readFileSync(secondPath, "utf8"));
  if (!report.valid || report.decision !== "RETRY") fail("reconcile requires a valid exhaustive RETRY report");
  process.stdout.write(`${JSON.stringify(reconcileFile(firstPath, report, thirdValue, Number(fourthValue), fifthValue))}\n`);
} else if (command === "replay") {
  if (!secondPath || !thirdValue) fail("replay requires ledger, logs directory, and prompts directory");
  process.stdout.write(`${JSON.stringify(replay(firstPath, secondPath, thirdValue))}\n`);
} else fail(`Unknown command: ${command}`);
