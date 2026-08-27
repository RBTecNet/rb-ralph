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
  const resolutions = new Map((report.resolutions ?? []).map((resolution) => [resolution.id, resolution]));
  for (const row of rows) {
    if (row[1] !== phase || row[3] !== "open" || Number(row[2]) > Number(attempt)) continue;
    const active = row[8] ? current.get(row[8]) : null;
    if (active) {
      const evidenceHash = createHash("sha256").update(active.reason).digest("hex");
      row[9] = normalizedCriteria(active.criteria);
      row[10] = active.reason;
      row[11] = `${evidenceFingerprint}:${evidenceHash}`;
      row[12] = String(attempt);
      current.delete(row[8]);
      updated += 1;
    } else if (resolutions.has(row[0]) && openingFingerprint(row[5]) !== evidenceFingerprint) {
      // An omitted finding is not proof.  The manager must name the stable
      // ledger identity and bind its resolution to new canonical evidence.
      row[3] = "resolved";
      row[6] = String(attempt);
      row[7] = evidenceFingerprint;
      row[10] = clean(`Resolved: ${resolutions.get(row[0]).evidence}`);
      row[11] = evidenceFingerprint;
      row[12] = String(attempt);
      resolutions.delete(row[0]);
      resolved += 1;
    }
  }
  if (resolutions.size) throw new Error(`unknown or non-open finding resolution IDs: ${[...resolutions.keys()].join(", ")}`);
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
  const resolutions = [];
  const auditStatuses = [];
  const decisions = [];
  const reasons = [];
  const decisionAllowed = new Set(["COMPLETE", "RETRY", "BLOCKED"]);
  for (const line of managerSource.split(/\r?\n/)) {
    const statusMatch = /^RB_RALPH_AUDIT_STATUS:\s*(\S+)\s*$/.exec(line);
    if (statusMatch) auditStatuses.push(statusMatch[1]);
    const decisionMatch = /^RB_RALPH_DECISION:\s*(\S+)\s*$/.exec(line);
    if (decisionMatch) decisions.push(decisionMatch[1]);
    const reasonMatch = /^RB_RALPH_REASON:\s*(\S(?:.*\S)?)\s*$/.exec(line);
    if (reasonMatch) reasons.push(reasonMatch[1]);
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
    if (line.startsWith("RB_RALPH_FINDING_RESOLUTION:")) {
      const fields = line.slice("RB_RALPH_FINDING_RESOLUTION:".length).split("|").map((value) => value.trim());
      if (fields.length !== 2 || !/^F-[A-Z0-9-]+-A\d{3}(?:-\d{2})?$/.test(fields[0]) || !fields[1]) malformed.push(line);
      else resolutions.push({ id: fields[0], evidence: fields[1] });
    }
  }
  const auditStatus = auditStatuses.length === 1 ? auditStatuses[0] : "";
  const decision = decisions.length === 1 && decisionAllowed.has(decisions[0]) ? decisions[0] : "";
  const reason = reasons.length === 1 ? reasons[0] : "";
  const expectedIds = new Set(expected.map((row) => row.id));
  const missing = expected.filter((row) => !rows.has(row.id)).map((row) => row.id);
  const unknown = [...rows.keys()].filter((id) => !expectedIds.has(id));
  const unknownFindingCriteria = [...new Set(findings.flatMap((finding) =>
    finding.criteria.split(/\s*,\s*/).filter((id) => !expectedIds.has(id))))];
  const failed = [...rows.values()].filter((row) => ["FAIL", "UNPROVEN"].includes(row.status));
  const uncoveredFailures = failed.filter((row) => !findings.some((finding) =>
    finding.criteria.split(/\s*,\s*/).includes(row.id),
  )).map((row) => row.id);
  const invalidComplete = decision === "COMPLETE"
    ? [...rows.values()].filter((row) => row.status !== "PASS").map((row) => row.id)
    : [];
  const issues = [];
  const duplicateFindingKeys = findings
    .filter((finding, index) => findings.findIndex((candidate) => candidate.key === finding.key) !== index)
    .map((finding) => finding.key);
  if (auditStatuses.length !== 1 || auditStatus !== "COMPLETE") issues.push("exactly one RB_RALPH_AUDIT_STATUS: COMPLETE is required");
  if (decisions.length !== 1 || !decision) issues.push("exactly one valid RB_RALPH_DECISION is required");
  if (reasons.length !== 1 || !reason) issues.push("exactly one non-empty RB_RALPH_REASON is required");
  if (!expected.length) issues.push("validated phase exposes no auditable task or criterion IDs");
  if (missing.length) issues.push(`missing matrix rows: ${missing.join(", ")}`);
  if (unknown.length) issues.push(`unknown matrix rows: ${unknown.join(", ")}`);
  if (unknownFindingCriteria.length) issues.push(`unknown finding criteria: ${unknownFindingCriteria.join(", ")}`);
  if (duplicates.length) issues.push(`duplicate matrix rows: ${[...new Set(duplicates)].join(", ")}`);
  if (malformed.length) issues.push(`malformed structured rows: ${malformed.length}`);
  if (duplicateFindingKeys.length) issues.push(`duplicate structured findings: ${new Set(duplicateFindingKeys).size}`);
  if (uncoveredFailures.length) issues.push(`failed/unproven rows without structured findings: ${uncoveredFailures.join(", ")}`);
  if ([...rows.values()].some((row) => row.status === "NOT_APPLICABLE")) issues.push("NOT_APPLICABLE is not valid for a declared task or acceptance criterion without an explicit contract exemption");
  if (decision === "RETRY" && failed.length === 0) issues.push("RETRY requires at least one FAIL or UNPROVEN criterion");
  if (decision === "BLOCKED" && ![...rows.values()].some((row) => ["UNPROVEN", "HUMAN_PENDING"].includes(row.status))) issues.push("BLOCKED requires an UNPROVEN or HUMAN_PENDING criterion");
  if (invalidComplete.length) issues.push(`COMPLETE has non-passing rows: ${invalidComplete.join(", ")}`);
  if (decision === "COMPLETE" && findings.length) issues.push("COMPLETE cannot include unresolved structured findings");
  return {
    schema: "rb-ralph-manager-audit/v1",
    valid: issues.length === 0,
    auditStatus,
    decision,
    reason,
    expected,
    rows: [...rows.values()],
    findings,
    resolutions,
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

function validateLegacy(managerSource) {
  // Legacy retains the old two-line surface but no longer has a shell parser
  // with different "last line wins" semantics.
  const decisions = [];
  const reasons = [];
  const resolutions = [];
  for (const line of managerSource.split(/\r?\n/)) {
    const decision = /^RB_RALPH_DECISION:\s*(\S+)\s*$/.exec(line);
    const reason = /^RB_RALPH_REASON:\s*(\S(?:.*\S)?)\s*$/.exec(line);
    if (decision) decisions.push(decision[1]);
    if (reason) reasons.push(reason[1]);
    if (line.startsWith("RB_RALPH_FINDING_RESOLUTION:")) {
      const fields = line.slice("RB_RALPH_FINDING_RESOLUTION:".length).split("|").map((value) => value.trim());
      if (fields.length === 2 && /^F-[A-Z0-9-]+-A\d{3}(?:-\d{2})?$/.test(fields[0]) && fields[1]) resolutions.push({ id: fields[0], evidence: fields[1] });
      else reasons.push(""); // force a canonical rejection below
    }
  }
  const allowed = new Set(["COMPLETE", "RETRY", "BLOCKED"]);
  const valid = decisions.length === 1 && allowed.has(decisions[0]) && reasons.length === 1;
  return {
    schema: "rb-ralph-manager-audit/v1", valid,
    auditStatus: "legacy", decision: valid ? decisions[0] : "", reason: valid ? reasons[0] : "",
    expected: [], rows: [], findings: [], resolutions, counts: {},
    issues: valid ? [] : ["legacy manager output requires exactly one valid decision and one non-empty reason"],
  };
}

function retrySelection(tasks, report) {
  const pending = tasks.filter((task) => task && task.done !== true && task.id);
  const taskById = new Map(pending.map((task) => [task.id, task]));
  const expected = new Map((report.expected ?? []).map((row) => [row.id, row]));
  const selected = new Set();
  const criteria = new Set();
  const failedRows = (report.rows ?? []).filter((row) => ["FAIL", "UNPROVEN"].includes(row.status)).map((row) => row.id);
  for (const criterion of failedRows) {
    criteria.add(criterion);
    const row = expected.get(criterion);
    const direct = row?.kind === "task" ? row.id : row?.parent;
    if (direct && taskById.has(direct)) { selected.add(direct); continue; }
    if (taskById.has(criterion)) { selected.add(criterion); continue; }
    for (const task of pending) {
      const acceptance = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.join("\n") : "";
      const covers = String(task.covers || "");
      if (new RegExp(`(^|[^A-Z0-9-])${criterion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9-]|$)`).test(`${acceptance}\n${covers}`)) {
        selected.add(task.id);
      }
    }
  }
  if (!selected.size) {
    return {
      contract: "rb-ralph-retry-selection/v1", localized: false, fallback: true,
      taskIds: [], criteria: [...criteria], reason: "manager findings could not be mapped to a declared pending task ID",
    };
  }

  return {
    contract: "rb-ralph-retry-selection/v1", localized: true, fallback: false,
    taskIds: pending.filter((task) => selected.has(task.id)).map((task) => task.id),
    criteria: [...criteria], reason: "structured failed/unproven criteria mapped to the minimal declared task closure",
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
    if (outcome.status === "COMPLETE" && report.decision === "COMPLETE") reconcile(rows, report, entry.phase, entry.attempt, fingerprint);
    else if (outcome.status === "RETRY" && report.decision === "RETRY") reconcile(rows, report, entry.phase, entry.attempt, fingerprint);
    else if (outcome.status === "RETRY") recordFallback(rows, entry.phase, entry.attempt, outcome.reason, fingerprint);
    processed += 1;
  }
  writeLedger(ledgerPath, rows);
  return { processed };
}

const [command, firstPath, secondPath, thirdValue, fourthValue, fifthValue] = process.argv.slice(2);
if (!command || !firstPath) fail("Usage: manager-audit.cjs expected <phase> | validate <phase> <manager-log> | validate-legacy <manager-log> | retry-selection <tasks-json> <audit-json> | reconcile <ledger> <audit> <phase> <attempt> <fingerprint> | replay <ledger> <logs> <prompts>");
if (command === "expected") {
  const phaseSource = readFileSync(firstPath, "utf8");
  for (const row of expectedRows(phaseSource)) process.stdout.write(`${row.id}\t${row.kind}\t${row.parent}\n`);
} else if (command === "validate") {
  if (!secondPath) fail("validate requires a manager log");
  const result = validate(readFileSync(firstPath, "utf8"), readFileSync(secondPath, "utf8"));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 3;
} else if (command === "validate-legacy") {
  const result = validateLegacy(readFileSync(firstPath, "utf8"));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 3;
} else if (command === "retry-selection") {
  if (!secondPath) fail("retry-selection requires tasks JSON and a manager audit JSON");
  const result = retrySelection(JSON.parse(readFileSync(firstPath, "utf8")), JSON.parse(readFileSync(secondPath, "utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.localized) process.exitCode = 3;
} else if (command === "reconcile") {
  if (!secondPath || !thirdValue || !fourthValue || !fifthValue) fail("reconcile requires ledger, audit, phase, attempt, and fingerprint");
  const report = JSON.parse(readFileSync(secondPath, "utf8"));
  if (!report.valid || !["RETRY", "COMPLETE"].includes(report.decision)) fail("reconcile requires a valid exhaustive RETRY or COMPLETE report");
  process.stdout.write(`${JSON.stringify(reconcileFile(firstPath, report, thirdValue, Number(fourthValue), fifthValue))}\n`);
} else if (command === "replay") {
  if (!secondPath || !thirdValue) fail("replay requires ledger, logs directory, and prompts directory");
  process.stdout.write(`${JSON.stringify(replay(firstPath, secondPath, thirdValue))}\n`);
} else fail(`Unknown command: ${command}`);

module.exports = { expectedRows, validate, validateLegacy, retrySelection, findingKey };
