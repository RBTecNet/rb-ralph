#!/usr/bin/env node
"use strict";

const { open, readdir, readFile, stat } = require("node:fs/promises");
const { basename, resolve } = require("node:path");
const { showSplash } = require("./splash.cjs");

const options = { project: ".", run: "", once: false, embedded: false, interval: 1000, color: true };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === "--project") options.project = args[++index] ?? "";
  else if (value === "--run") options.run = args[++index] ?? "";
  else if (value === "--interval") options.interval = Number(args[++index]) * 1000;
  else if (value === "--once") options.once = true;
  else if (value === "--embedded") options.embedded = true;
  else if (value === "--no-color") options.color = false;
  else if (value === "-h" || value === "--help") {
    process.stdout.write(`Usage: rb-ralph-watch [options]\n\nOptions:\n  --project <path>  Project containing .rb/runs (default: .)\n  --run <id>        Select a run ID instead of the newest observable run\n  --interval <sec>  Refresh interval (default: 1)\n  --once            Render one frame without requiring a TTY\n  --no-color        Disable ANSI colors\n  -h, --help        Show this help\n\nKeys: q exits the standalone dashboard without stopping RB Ralph.\n`);
    process.exit(0);
  } else throw new Error(`Unknown option: ${value}`);
}

if (!Number.isFinite(options.interval) || options.interval < 100) {
  throw new Error("--interval must be at least 0.1 seconds");
}
if (!process.stdout.isTTY) options.color = false;

const C = options.color ? {
  reset: "\u001b[0m", bold: "\u001b[1m", dim: "\u001b[2m",
  cyan: "\u001b[38;5;81m", green: "\u001b[38;5;77m",
  yellow: "\u001b[38;5;221m", red: "\u001b[38;5;203m", grey: "\u001b[38;5;245m",
  blue: "\u001b[38;5;75m", magenta: "\u001b[38;5;213m", white: "\u001b[38;5;255m",
  dark: "\u001b[38;5;239m",
} : { reset: "", bold: "", dim: "", cyan: "", green: "", yellow: "", red: "", grey: "", blue: "", magenta: "", white: "", dark: "" };

function clean(value) {
  return String(value ?? "").replace(/[\t\r\n]/g, " ");
}

function truncate(value, width) {
  const text = clean(value);
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function visibleLength(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "").length;
}

function padAnsi(value, width) {
  const missing = Math.max(0, width - visibleLength(value));
  return `${value}${" ".repeat(missing)}`;
}

function duration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours ? `${hours}h ${minutes}m ${rest}s` : minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function count(value) {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0));
}

function plainStatus(value) {
  const labels = {
    pending: "· Pendente", running: "▶ Executando", retry: "↻ Nova tentativa",
    complete: "✓ Concluída", "document-complete": "✓ Documentada",
    failed: "✗ Falhou", blocked: "! Bloqueada", paused: "Ⅱ Pausada",
  };
  return labels[value] ?? clean(value || "pending");
}

function status(value) {
  const colors = {
    pending: C.grey, running: C.yellow, retry: C.yellow,
    complete: C.green, "document-complete": C.green,
    failed: C.red, blocked: C.red, paused: C.yellow,
  };
  return `${colors[value] ?? ""}${plainStatus(value)}${C.reset}`;
}

function statusCell(value, width) {
  const colors = {
    pending: C.grey, running: C.yellow, retry: C.yellow,
    complete: C.green, "document-complete": C.green,
    failed: C.red, blocked: C.red, paused: C.yellow,
  };
  return `${colors[value] ?? ""}${truncate(plainStatus(value), width)}${C.reset}`;
}

async function findRun(project) {
  const runs = resolve(project, ".rb/runs");
  const entries = await readdir(runs, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || (options.run && entry.name !== options.run)) continue;
    const plan = resolve(runs, entry.name, "dashboard-plan.tsv");
    try {
      const metadata = await stat(plan);
      candidates.push({ id: entry.name, directory: resolve(runs, entry.name), mtime: metadata.mtimeMs });
    } catch { /* not an observable RB Ralph run */ }
  }
  candidates.sort((left, right) => right.mtime - left.mtime);
  return candidates[0] ?? null;
}

async function rows(path) {
  const body = await readFile(path, "utf8").catch(() => "");
  return body.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTerminalNoise(value) {
  return String(value)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\t/g, "  ")
    .trim();
}

function usefulLogLine(value) {
  const line = stripTerminalNoise(value);
  if (!line.startsWith("{")) return line;
  try {
    const event = JSON.parse(line);
    const item = event.item ?? {};
    if (event.type === "thread.started") return `sessão iniciada · ${event.thread_id ?? "provider"}`;
    if (event.type === "item.started" && item.type === "command_execution") {
      return `$ ${item.command ?? "comando iniciado"}`;
    }
    if (event.type === "item.completed" && item.type === "command_execution") {
      return `$ ${item.command ?? "comando"} · exit ${item.exit_code ?? "?"}`;
    }
    if (event.type === "item.completed" && item.type === "agent_message") {
      return String(item.text ?? "mensagem do modelo").replace(/\s+/g, " ").trim();
    }
    if (event.type === "turn.completed") {
      const usage = event.usage ?? {};
      return `turno concluído · entrada ${usage.input_tokens ?? 0} · saída ${usage.output_tokens ?? 0}`;
    }
    if (event.type === "error") return `erro do provider · ${event.message ?? event.error?.message ?? "sem detalhe"}`;
    return "";
  } catch {
    return line;
  }
}

async function readLogTail(path, maxBytes = 32768) {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return { bytes: 0, mtimeMs: Date.now(), lines: [] };
  try {
    const metadata = await handle.stat();
    const length = Math.min(metadata.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, metadata.size - length));
    const rawLines = buffer.toString("utf8").split(/\n/);
    if (metadata.size > length) rawLines.shift();
    const lines = rawLines.map(usefulLogLine).filter(Boolean);
    return { bytes: metadata.size, mtimeMs: metadata.mtimeMs, lines: lines.slice(-4) };
  } finally {
    await handle.close();
  }
}

async function currentActivityLog(run, meta, phaseGates) {
  const phase = meta.phase;
  const attempt = /A(\d+)/.exec(meta.attempt ?? "")?.[1];
  if (!phase || !attempt) return null;
  const gates = String(phaseGates[phase] ?? "").split(/\s+/);
  const role = gates[3] === "run" || ["complete", "failed", "blocked", "paused"].includes(meta.status)
    ? "manager"
    : gates[2] === "run" ? "validation"
      : "agent";
  const escapedPhase = escapeRegex(phase);
  const escapedAttempt = escapeRegex(attempt);
  const pattern = role === "agent"
    ? new RegExp(`^${escapedPhase}(?:-[^-]+)?-attempt-${escapedAttempt}-agent\\.log$`)
    : role === "manager"
      ? new RegExp(`^${escapedPhase}-attempt-${escapedAttempt}-manager(?:-retry-[0-9]+)?\\.log$`)
      : new RegExp(`^${escapedPhase}-attempt-${escapedAttempt}-validation\\.log$`);
  const directory = resolve(run.directory, "logs");
  const candidates = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const path = resolve(directory, entry.name);
    const metadata = await stat(path).catch(() => null);
    if (metadata) candidates.push({ path, name: entry.name, mtimeMs: metadata.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates.length) return { role, name: "aguardando arquivo", bytes: 0, mtimeMs: Date.now(), lines: [] };
  const selected = candidates[0];
  return { role, name: selected.name, ...await readLogTail(selected.path) };
}

async function currentProviderStatus(run, meta) {
  const phase = meta.phase;
  const attempt = /A(\d+)/.exec(meta.attempt ?? "")?.[1];
  if (!phase || !attempt) return null;
  const pattern = new RegExp(`^${escapeRegex(phase)}(?:-.+)?-attempt-${escapeRegex(attempt)}-(?:agent|manager(?:-retry-[0-9]+)?)\\.json$`);
  const directory = resolve(run.directory, ".lock/live");
  const candidates = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const path = resolve(directory, entry.name);
    const metadata = await stat(path).catch(() => null);
    if (metadata) candidates.push({ path, name: entry.name, mtimeMs: metadata.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    try {
      return { ...JSON.parse(await readFile(candidate.path, "utf8")), name: candidate.name, mtimeMs: candidate.mtimeMs };
    } catch { /* atomic writer may be between generations; try the next file */ }
  }
  return null;
}

function providerActivity(status) {
  if (!status) return "";
  if (!status.firstOutputAt) {
    const remaining = status.firstOutputTimeoutSeconds > 0
      ? Math.max(0, status.firstOutputTimeoutSeconds - status.elapsedSeconds) : null;
    if (status.secondsSinceProcessActivity !== null && status.secondsSinceProcessActivity <= 2) {
      return `processo ${status.role} ativo por CPU/I/O; nenhuma saída há ${status.elapsedSeconds}s${remaining === null ? "" : `; timeout em ${remaining}s`}`;
    }
    return `processo ${status.role} iniciado; nenhuma saída há ${status.elapsedSeconds}s${remaining === null ? "" : `; timeout em ${remaining}s`}`;
  }
  return `${status.role} produziu a primeira saída em ${status.firstOutputLatencySeconds}s; ${status.outputBytes} bytes observados; última saída há ${status.secondsSinceOutput}s`;
}

async function load(run) {
  const phases = [];
  const tasks = [];
  const meta = {};
  const phaseStatus = {};
  const phaseAttempt = {};
  const phaseGates = {};
  const usage = {};
  const models = [];
  let latestEvent = null;
  for (const row of await rows(resolve(run.directory, "dashboard-plan.tsv"))) {
    if (row[0] === "META") meta[row[1]] = row.slice(2).join(" ");
    else if (row[0] === "PHASE") phases.push({ id: row[1], base: row[2], title: row.slice(3).join(" ") });
    else if (row[0] === "TASK") tasks.push({ phase: row[1], id: row[2], base: row[3], title: row.slice(4).join(" ") });
  }
  for (const row of await rows(resolve(run.directory, "dashboard-live.tsv"))) {
    if (row[0] === "META") meta[row[1]] = row.slice(2).join(" ");
    else if (row[0] === "PHASE") {
      phaseStatus[row[1]] = row[2];
      phaseAttempt[row[1]] = row[3] ?? "0";
      phaseGates[row[1]] = row[4] ?? "pending pending pending pending";
    }
  }
  for (const row of await rows(resolve(run.directory, "usage-summary.tsv"))) {
    if (row[0] === "USAGE") usage[row[1]] = row[2];
    else if (row[0] === "MODEL") models.push({
      provider: row[1], model: row[2], calls: row[3], measuredCalls: row[4],
      inputTokens: row[5], cachedInputTokens: row[6], cacheCreationInputTokens: row[7],
      outputTokens: row[8], totalTokens: row[9], cost: row[10],
      knownCostCalls: row[11], unknownCostCalls: row[12], costSource: row[13],
    });
  }
  for (const row of await rows(resolve(run.directory, "events.tsv"))) {
    if (row[0] === "timestamp") continue;
    if (row.length < 4) continue;
    latestEvent = {
      timestamp: row[0], phase: row[1], attempt: row[2], status: row[3],
      reason: row.slice(4).join(" "),
    };
  }
  const activityLog = await currentActivityLog(run, meta, phaseGates);
  const providerStatus = await currentProviderStatus(run, meta);
  return { ...run, phases, tasks, meta, phaseStatus, phaseAttempt, phaseGates, usage, models, latestEvent, activityLog, providerStatus };
}

function effectivePhase(state, phase) {
  return state.phaseStatus[phase.id] ?? phase.base;
}

function effectiveTask(state, task) {
  if (task.base === "complete") return "complete";
  const phase = state.phases.find((item) => item.id === task.phase);
  const phaseState = phase ? effectivePhase(state, phase) : "pending";
  if (["complete", "document-complete"].includes(phaseState)) return "complete";
  if (["running", "retry"].includes(phaseState)) return "running";
  if (["failed", "blocked", "paused"].includes(phaseState)) return phaseState;
  return "pending";
}

function bar(done, total, width) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return `${C.green}${"█".repeat(filled)}${C.grey}${"░".repeat(width - filled)}${C.reset}`;
}

function percent(done, total) {
  return total ? `${Math.round((done / total) * 100)}%` : "0%";
}

function gateMark(value) {
  const marks = {
    pass: `${C.green}✓${C.reset}`,
    fail: `${C.red}✗${C.reset}`,
    run: `${C.yellow}●${C.reset}`,
    skip: `${C.grey}⊘${C.reset}`,
    pending: `${C.dark}·${C.reset}`,
  };
  return marks[value] ?? marks.pending;
}

function gatesCell(spec) {
  const gates = String(spec ?? "pending pending pending pending").split(/\s+/);
  return [0, 1, 2, 3].map((index) => `${C.grey}G${index}${C.reset} ${gateMark(gates[index])}`).join("  ");
}

function borderTop(title, width, color = C.cyan) {
  const label = ` ${title} `;
  return `${color}╭─${label}${"─".repeat(Math.max(0, width - label.length - 3))}╮${C.reset}`;
}

function borderBottom(width, color = C.cyan) {
  return `${color}╰${"─".repeat(width - 2)}╯${C.reset}`;
}

function boxLine(content, width, color = C.cyan) {
  const inner = width - 4;
  const fitted = visibleLength(content) > inner
    ? truncate(String(content).replace(/\u001b\[[0-9;]*m/g, ""), inner)
    : padAnsi(content, inner);
  return `${color}│${C.reset} ${fitted} ${color}│${C.reset}`;
}

function wrapText(value, width, maxLines = 4) {
  let remaining = clean(value).trim();
  const lines = [];
  while (remaining && lines.length < maxLines) {
    if (remaining.length <= width) {
      lines.push(remaining);
      remaining = "";
      break;
    }
    let split = remaining.lastIndexOf(" ", width);
    if (split < Math.floor(width / 2)) split = width;
    lines.push(remaining.slice(0, split).trim());
    remaining = remaining.slice(split).trim();
  }
  if (remaining && lines.length) {
    lines[lines.length - 1] = truncate(lines[lines.length - 1], Math.max(1, width - 1)).trimEnd() + "…";
  }
  return lines;
}

function decisionDetails(state) {
  const event = state.latestEvent;
  const currentPhase = state.meta.phase;
  const phase = state.phases.find((item) => item.id === currentPhase);
  const phaseState = phase ? effectivePhase(state, phase) : "pending";
  const matchingTerminalState = event && {
    BLOCKED: "blocked",
    RETRY: "retry",
    FAILED: "failed",
    PAUSED: "paused",
    COMPLETE: "complete",
  }[event.status] === phaseState;
  if (event && event.status === "MANAGER_ERROR" && event.phase === currentPhase
    && ["running", "retry"].includes(phaseState) && event.reason) {
    return { title: "FALHA NA TENTATIVA ANTERIOR", reason: event.reason, event };
  }
  if (event && (!currentPhase || event.phase === currentPhase) && matchingTerminalState) {
    const labels = {
      BLOCKED: "MOTIVO DO BLOQUEIO",
      RETRY: "FEEDBACK PARA NOVA TENTATIVA",
      FAILED: "MOTIVO DA FALHA",
      PAUSED: "CIRCUIT BREAKER — EXECUÇÃO RETOMÁVEL",
      MANAGER_ERROR: "ERRO NA DECISÃO DO GERENTE",
      COMPLETE: "DECISÃO DO GERENTE",
    };
    if (labels[event.status] && event.reason) {
      return { title: labels[event.status], reason: event.reason, event };
    }
  }
  if (["failed", "blocked", "paused"].includes(state.meta.status) && state.meta.reason) {
    const title = state.meta.status === "blocked" ? "MOTIVO DO BLOQUEIO"
      : state.meta.status === "paused" ? "CIRCUIT BREAKER — EXECUÇÃO RETOMÁVEL" : "MOTIVO DA FALHA";
    return { title, reason: state.meta.reason, event: null };
  }
  return null;
}

function recentLogPanel(state, width) {
  const source = state.activityLog;
  const roleLabels = { agent: "EXECUTOR", manager: "GERENTE", validation: "VALIDAÇÃO" };
  const role = roleLabels[source?.role] ?? "ATIVIDADE";
  const age = source ? Math.max(0, Math.floor((Date.now() - source.mtimeMs) / 1000)) : 0;
  const lines = [borderTop(`LOG RECENTE · ${role}`, width, C.blue)];
  const name = source?.name ?? "nenhum log ativo";
  lines.push(boxLine(`${C.cyan}${name}${C.reset}  ${C.grey}${source?.bytes ?? 0} bytes · última saída há ${age}s${C.reset}`, width, C.blue));
  const content = source?.lines?.length ? source.lines : [providerActivity(state.providerStatus) || "Processo do provider ainda não foi iniciado."];
  for (const line of content.slice(-4)) {
    lines.push(boxLine(`${C.white}${line}${C.reset}`, width, C.blue));
  }
  while (lines.length < 6) lines.push(boxLine("", width, C.blue));
  lines.push(borderBottom(width, C.blue));
  return lines;
}

function tableBorder(widths, kind) {
  const chars = kind === "top" ? ["╭", "┬", "╮"] : kind === "bottom" ? ["╰", "┴", "╯"] : ["├", "┼", "┤"];
  return `${C.blue}${chars[0]}${widths.map((width) => "─".repeat(width + 2)).join(chars[1])}${chars[2]}${C.reset}`;
}

/**
 * Which slice of the task table to show when it does not fit.
 *
 * The window follows the unit actually being worked on. A phase with more tasks
 * than the terminal can hold otherwise shows its first rows — the ones already
 * finished — and hides the running task below the cut, which is exactly the
 * moment an operator needs to see. Preference order is the running task, then
 * any other unfinished task of the current phase, then the phase row itself.
 *
 * The phase heading is kept in view when it fits, so a visible task always says
 * which phase it belongs to, and the caller reports what is hidden on each side
 * rather than letting the list end without saying so.
 */
function focusWindow(rowKinds, state, room) {
  const total = rowKinds.length;
  if (total <= room) return { start: 0, hiddenAbove: 0, hiddenBelow: 0 };
  const phaseId = state.meta.phase;
  const unfinished = (row) => !["complete", "document-complete"].includes(row.state);
  let target = rowKinds.findIndex((row) => row.kind === "task" && row.state === "running");
  if (target < 0) target = rowKinds.findIndex((row) => row.kind === "task" && row.phase === phaseId && unfinished(row));
  if (target < 0) target = rowKinds.findIndex((row) => row.kind === "phase" && row.id === phaseId);
  if (target < 0) target = 0;
  // Keep the enclosing phase heading visible when the target is a task.
  let anchor = target;
  if (rowKinds[target] && rowKinds[target].kind === "task") {
    for (let index = target; index >= 0; index -= 1) {
      if (rowKinds[index].kind === "phase") { anchor = index; break; }
    }
    // If the phase heading is too far back to keep, fall back to a line of lead.
    if (target - anchor >= room) anchor = Math.max(0, target - 1);
  }
  const start = Math.max(0, Math.min(anchor, total - room));
  return { start, hiddenAbove: start, hiddenBelow: Math.max(0, total - start - room) };
}

function tableRow(cells, widths, colors = []) {
  const body = cells.map((cell, index) => {
    const raw = String(cell ?? "");
    const fitted = raw.includes("\u001b[")
      ? visibleLength(raw) <= widths[index] ? padAnsi(raw, widths[index]) : truncate(raw.replace(/\u001b\[[0-9;]*m/g, ""), widths[index])
      : truncate(raw, widths[index]);
    return `${colors[index] ?? ""}${fitted}${colors[index] ? C.reset : ""}`;
  }).join(` ${C.blue}│${C.reset} `);
  return `${C.blue}│${C.reset} ${body} ${C.blue}│${C.reset}`;
}

function brandHeader(version, width, terminalLines) {
  if (width < 100 || terminalLines < 42) {
    return [`${C.bold}${C.magenta}◆${C.reset} ${C.bold}${C.cyan}RB RALPH${C.reset} ${C.dim}v${clean(version)} · CONTROL PLANE${C.reset}`];
  }
  const logoWidth = 36;
  const logo = [
    "█▀█ █▄▄   █▀█ ▄▀█ █░░ █▀█ █░█",
    "█▀▄ █▄█   █▀▄ █▀█ █▄▄ █▀▀ █▀█",
    "     AUTONOMOUS CONTROL PLANE",
    `     v${clean(version)}`,
    "",
    "",
  ];
  const mascot = [
    "    ╭─╮          ╭─╮",
    "  ╭─╯ ╰──────────╯ ╰─╮",
    "  │     ◕      ◕     │",
    "  ╰──╮  ╭──────╮  ╭──╯",
    "     ╰──┤ ▪  ▪ ├──╯",
    `        ╰──◡◡──╯${" ".repeat(10)}RALPH · capivara de plantão`,
  ];
  return logo.map((line, index) => {
    const logoColor = index < 2 ? `${C.bold}${C.cyan}` : C.dim;
    const mascotColor = index === 0 ? C.yellow : index < 3 ? C.magenta : index < 5 ? C.white : C.grey;
    return `${logoColor}${line.padEnd(logoWidth)}${C.reset}${mascotColor}${mascot[index]}${C.reset}`;
  });
}

function render(state) {
  const configuredWidth = Number(process.env.RB_RALPH_WATCH_COLS);
  const width = Math.max(88, Number.isFinite(configuredWidth) && configuredWidth > 0 ? configuredWidth : process.stdout.columns || 118);
  const configuredLines = Number(process.env.RB_RALPH_WATCH_LINES);
  const terminalLines = Number.isFinite(configuredLines) && configuredLines > 0 ? configuredLines : process.stdout.rows || 40;
  const now = Math.floor(Date.now() / 1000);
  const started = Number(state.meta.started || now);
  const ended = Number(state.meta.ended || now);
  const elapsed = (state.meta.status === "running" ? now : ended) - started;
  const phaseDone = state.phases.filter((phase) => ["complete", "document-complete"].includes(effectivePhase(state, phase))).length;
  const taskDone = state.tasks.filter((task) => effectiveTask(state, task) === "complete").length;
  const lines = [];
  lines.push(...brandHeader(state.meta.version ?? "?", width, terminalLines));
  lines.push(`${C.dark}${"━".repeat(width)}${C.reset}`);
  const project = truncate(state.meta.project ?? "?", Math.max(12, Math.floor(width / 5))).trimEnd();
  const plan = truncate(state.meta.plan ?? state.id, Math.max(16, Math.floor(width / 4))).trimEnd();
  lines.push(`${C.cyan}PROJETO${C.reset} ${C.white}${project}${C.reset}   ${C.cyan}PLANO${C.reset} ${C.white}${plan}${C.reset}   ${C.cyan}DURAÇÃO${C.reset} ${C.white}${duration(elapsed)}${C.reset}`);
  const roles = truncate(state.meta.roles ?? "?", Math.max(16, width - 35)).trimEnd();
  lines.push(`${C.cyan}STATUS${C.reset} ${status(state.meta.status)}   ${C.cyan}PAPÉIS${C.reset} ${C.white}${roles}${C.reset}`);
  if (state.meta.permissions === "yolo") {
    lines.push(`${C.red}${C.bold}⚠ ACESSO YOLO${C.reset} ${C.red}permissões e sandbox do provedor ignorados${C.reset}`);
  } else if (state.meta.permissions === "protected") {
    lines.push(`${C.green}◆ ACESSO PROTEGIDO${C.reset} ${C.grey}sandbox e permissões do provedor ativos${C.reset}`);
  }
  lines.push("");
  const progressWidth = Math.max(12, Math.min(34, Math.floor((width - 50) / 2)));
  lines.push(borderTop("PROGRESSO & CONSUMO", width, C.magenta));
  lines.push(boxLine(`${C.white}Fases${C.reset} ${String(phaseDone).padStart(2)}/${String(state.phases.length).padEnd(2)}  [${bar(phaseDone, state.phases.length, progressWidth)}] ${C.green}${percent(phaseDone, state.phases.length).padStart(4)}${C.reset}    ${C.white}Tasks${C.reset} ${String(taskDone).padStart(2)}/${String(state.tasks.length).padEnd(2)}  [${bar(taskDone, state.tasks.length, progressWidth)}] ${C.green}${percent(taskDone, state.tasks.length).padStart(4)}${C.reset}`, width, C.magenta));
  const usage = state.usage;
  const calls = Number(usage.calls ?? 0);
  const costKnown = Number(usage.knownCostCalls ?? 0);
  const costUnknown = Number(usage.unknownCostCalls ?? 0);
  let cost = "indisponível";
  if (costKnown > 0) {
    cost = `${usage.currency ?? "USD"} ${Number(usage.cost ?? 0).toFixed(6)} (${usage.costSource ?? "measured"}`;
    if (costUnknown > 0) cost += `; ${costUnknown} sem preço`;
    cost += ")";
  }
  lines.push(boxLine(`${C.cyan}CHAMADAS${C.reset} ${calls}  ${C.green}medidas ${usage.measuredCalls ?? 0}${C.reset}  ${C.grey}sem métrica ${usage.unmeasuredCalls ?? 0}${C.reset}    ${C.cyan}TOKENS${C.reset} entrada ${count(usage.inputTokens)}  cache↙ ${count(usage.cachedInputTokens)}  cache↗ ${count(usage.cacheCreationInputTokens)}  saída ${count(usage.outputTokens)}  ${C.bold}total ${count(usage.totalTokens)}${C.reset}`, width, C.magenta));
  lines.push(boxLine(`${C.cyan}CUSTO${C.reset} ${costKnown > 0 ? C.green : C.grey}${cost}${C.reset}`, width, C.magenta));
  for (const model of state.models.slice(0, 2)) {
    let modelCost = "custo indisponível";
    if (Number(model.knownCostCalls) > 0) {
      modelCost = `${usage.currency ?? "USD"} ${Number(model.cost).toFixed(6)} ${model.costSource}`;
      if (Number(model.unknownCostCalls) > 0) modelCost += ` + ${model.unknownCostCalls} sem preço`;
    }
    lines.push(boxLine(`${C.blue}${model.provider}/${model.model}${C.reset}  ${model.calls} chamada(s)  ${count(model.totalTokens)} tokens  ${C.grey}${modelCost}${C.reset}`, width, C.magenta));
  }
  if (state.models.length > 2) lines.push(boxLine(`${C.grey}+ ${state.models.length - 2} modelo(s) no usage-summary.tsv${C.reset}`, width, C.magenta));
  lines.push(borderBottom(width, C.magenta));
  lines.push("");
  lines.push(borderTop("TRABALHO ATUAL", width, C.yellow));
  const currentPhase = state.phases.find((phase) => phase.id === state.meta.phase);
  lines.push(boxLine(`${C.yellow}${C.bold}${state.meta.phase || "—"}${C.reset}  ${C.white}${currentPhase?.title ?? "aguardando próxima fase"}${C.reset}    ${C.cyan}tentativa${C.reset} ${state.meta.attempt || "—"}`, width, C.yellow));
  const liveActivity = providerActivity(state.providerStatus);
  lines.push(boxLine(`${C.cyan}atividade${C.reset}  ${C.white}${truncate(liveActivity || state.meta.activity || "aguardando", width - 18).trimEnd()}${C.reset}`, width, C.yellow));
  lines.push(boxLine(`${C.cyan}achados${C.reset}    ${C.white}${state.meta.findings || "total=0 open=0 resolved=0 new=0"}${C.reset}`, width, C.yellow));
  if (state.meta.phase) lines.push(boxLine(`${C.cyan}gates${C.reset}      ${gatesCell(state.phaseGates[state.meta.phase])}`, width, C.yellow));
  lines.push(borderBottom(width, C.yellow));
  const legend = truncate("G0 Executor · G1 Evidências · G2 Validações · G3 Gerente   ✓ passou  ● executando  ✗ falhou  ⊘ delegado", width).trimEnd();
  lines.push(`${C.dim}${legend}${C.reset}`);
  const details = decisionDetails(state);
  if (details) {
    lines.push("");
    lines.push(borderTop(details.title, width, C.red));
    for (const reasonLine of wrapText(details.reason, width - 8)) {
      lines.push(boxLine(`${C.white}${reasonLine}${C.reset}`, width, C.red));
    }
    if (details.event) {
      const source = `.rb/runs/${state.id}/events.tsv · ${details.event.phase} tentativa ${details.event.attempt}`;
      lines.push(boxLine(`${C.grey}registro: ${source}${C.reset}`, width, C.red));
    }
    lines.push(borderBottom(width, C.red));
  }
  lines.push("");
  const columnWidths = [6, Math.max(13, width - 75), 16, 11, 26];
  lines.push(tableBorder(columnWidths, "top"));
  lines.push(tableRow(["ID", "FASE / TASK", "STATUS", "TENTATIVA", "GATES"], columnWidths, [C.cyan, C.cyan, C.cyan, C.cyan, C.cyan]));
  lines.push(tableBorder(columnWidths, "middle"));
  const tableStart = lines.length;
  // Rows are tagged as they are built. The previous anchor searched the
  // rendered text for the phase ID, but every row starts with a coloured box
  // border, so the match never succeeded, findIndex returned -1, and the window
  // silently pinned itself to the top of the table — which is why a long phase
  // showed only its finished tasks and hid the one actually running.
  const rowKinds = [];
  for (const phase of state.phases) {
    const phaseState = effectivePhase(state, phase);
    const phaseColor = phaseState === "complete" || phaseState === "document-complete" ? C.green
      : phaseState === "running" || phaseState === "retry" ? C.yellow
      : phaseState === "failed" || phaseState === "blocked" ? C.red
        : phaseState === "paused" ? C.yellow : C.grey;
    lines.push(tableRow([
      phase.id, phase.title, plainStatus(phaseState), state.phaseAttempt[phase.id] ?? "0",
      gatesCell(state.phaseGates[phase.id]),
    ], columnWidths, [C.cyan, C.white, phaseColor, C.grey, ""]));
    rowKinds.push({ kind: "phase", id: phase.id, state: phaseState });
    for (const task of state.tasks.filter((item) => item.phase === phase.id)) {
      const taskState = effectiveTask(state, task);
      const taskColor = taskState === "complete" ? C.green : taskState === "running" ? C.yellow
        : taskState === "failed" || taskState === "blocked" ? C.red
          : taskState === "paused" ? C.yellow : C.grey;
      lines.push(tableRow([`  ${task.id}`, `↳ ${task.title}`, plainStatus(taskState), "—", "—"], columnWidths, [C.grey, C.grey, taskColor, C.grey, C.grey]));
      rowKinds.push({ kind: "task", id: task.id, phase: phase.id, state: taskState });
    }
  }
  const tableBottom = tableBorder(columnWidths, "bottom");
  const logPanel = recentLogPanel(state, width);
  const finished = ["complete", "failed", "blocked", "paused"].includes(state.meta.status);
  const footer = options.embedded && finished
    ? "Run finalizado · pressione Enter para fechar o painel"
    : options.embedded
      ? "O painel permanecerá aberto ao final · Ctrl-C interrompe o Ralph"
      : "q fecha este painel sem parar o Ralph";
  const maxLines = Math.max(12, terminalLines - 1);
  if (lines.length + 1 + logPanel.length + 1 > maxLines) {
    const header = lines.slice(0, tableStart);
    const table = lines.slice(tableStart);
    const room = Math.max(2, maxLines - header.length - logPanel.length - 2);
    const { start, hiddenAbove, hiddenBelow } = focusWindow(rowKinds, state, room);
    const shown = table.slice(start, start + room);
    const trail = [
      hiddenAbove ? `↑ ${hiddenAbove} acima` : "",
      hiddenBelow ? `↓ ${hiddenBelow} abaixo` : "",
    ].filter(Boolean).join(" · ");
    const scrollFooter = truncate(
      `Mostrando ${shown.length}/${table.length} linhas${trail ? ` · ${trail}` : ""} · ${footer}`,
      width,
    ).trimEnd();
    return [...header, ...shown, tableBottom, ...logPanel, `${C.dim}${scrollFooter}${C.reset}`].join("\n");
  }
  return [...lines, tableBottom, ...logPanel, `${C.dim}${truncate(footer, width).trimEnd()}${C.reset}`].join("\n");
}

let stopped = false;
let alternate = false;
let runFinished = false;
function cleanup() {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  if (alternate) process.stdout.write("\u001b[?25h\u001b[?1049l");
  alternate = false;
}

async function main() {
  const project = resolve(options.project);
  if (!options.once && !process.stdout.isTTY) throw new Error("Live dashboard requires a TTY; use --once for a snapshot");
  if (!options.once && !options.embedded) showSplash();
  if (!options.once) {
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    alternate = true;
    process.on("exit", cleanup);
    process.on("SIGINT", () => { stopped = true; cleanup(); process.exit(130); });
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (data) => {
        const key = data.toString();
        if (options.embedded && runFinished && (key.includes("\r") || key.includes("\n"))) stopped = true;
        else if (!options.embedded && ["q", "Q", "\u0003"].includes(key)) stopped = true;
      });
    }
  }
  while (!stopped) {
    const run = await findRun(project);
    if (!run) {
      if (options.once) throw new Error(`No observable RB Ralph run found under ${project}/.rb/runs`);
      process.stdout.write("\u001b[H\u001b[2JWaiting for RB Ralph observable state…");
    } else {
      const state = await load(run);
      runFinished = ["complete", "failed", "blocked", "paused"].includes(state.meta.status);
      const frame = render(state);
      if (options.once) { process.stdout.write(`${frame}\n`); break; }
      process.stdout.write(`\u001b[H\u001b[2J${frame}`);
    }
    await new Promise((done) => setTimeout(done, options.interval));
  }
  cleanup();
}

main().catch((error) => {
  cleanup();
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
