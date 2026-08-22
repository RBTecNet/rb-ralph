#!/usr/bin/env node
"use strict";

// RB Ralph splash screen. Purely cosmetic: it paints an animated wordmark on the
// alternate screen buffer, restores the terminal, and returns. It never touches
// execution state and stays silent whenever the terminal cannot render it.

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function packagedVersion() {
  try {
    return readFileSync(join(__dirname, "..", "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
}

const WORDMARK = [
  "██████╗ ██████╗     ██████╗  █████╗ ██╗     ██████╗ ██╗  ██╗",
  "██╔══██╗██╔══██╗    ██╔══██╗██╔══██╗██║     ██╔══██╗██║  ██║",
  "██████╔╝██████╔╝    ██████╔╝███████║██║     ██████╔╝███████║",
  "██╔══██╗██╔══██╗    ██╔══██╗██╔══██║██║     ██╔═══╝ ██╔══██║",
  "██║  ██║██████╔╝    ██║  ██║██║  ██║███████╗██║     ██║  ██║",
  "╚═╝  ╚═╝╚═════╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝",
];

const WORDMARK_COMPACT = [
  "█▀█ █▄▄   █▀█ ▄▀█ █░░ █▀█ █░█",
  "█▀▄ █▄█   █▀▄ █▀█ █▄▄ █▀▀ █▀█",
];

// Capybara: blunt rectangular head, small round ears, eyes set high and wide,
// and the oversized muzzle that makes the animal recognizable at this size.
const MASCOT = [
  "        ╭──╮                            ╭──╮",
  "    ╭───╯  ╰────────────────────────────╯  ╰───╮",
  "    │          ◕                    ◕          │",
  "    │                                          │",
  "    ╰─────╮      ╭────────────────╮      ╭─────╯",
  "          ╰──────┤    ▪      ▪    ├──────╯",
  "                 │       ◡◡       │",
  "                 ╰────────────────╯",
];

const MASCOT_COMPACT = [
  "    ╭─╮          ╭─╮",
  "  ╭─╯ ╰──────────╯ ╰─╮",
  "  │     ◕      ◕     │",
  "  ╰──╮  ╭──────╮  ╭──╯",
  "     ╰──┤ ▪  ▪ ├──╯",
  "        ╰──◡◡──╯",
];

const STOPS = [
  [62, 207, 142],   // verde
  [168, 109, 255],  // roxo
  [255, 150, 60],   // laranja
];

function mix(from, to, ratio) {
  return [
    Math.round(from[0] + (to[0] - from[0]) * ratio),
    Math.round(from[1] + (to[1] - from[1]) * ratio),
    Math.round(from[2] + (to[2] - from[2]) * ratio),
  ];
}

function colorAt(phase) {
  const normalized = ((phase % 1) + 1) % 1;
  const scaled = normalized * STOPS.length;
  const index = Math.floor(scaled) % STOPS.length;
  const step = scaled - Math.floor(scaled);
  const eased = step < 0.5 ? 2 * step * step : 1 - Math.pow(-2 * step + 2, 2) / 2;
  return mix(STOPS[index], STOPS[(index + 1) % STOPS.length], eased);
}

function level(value) {
  return Math.max(0, Math.min(5, Math.round((value / 255) * 5)));
}

function ansi(rgb, trueColor) {
  if (!trueColor) return `\u001b[38;5;${16 + 36 * level(rgb[0]) + 6 * level(rgb[1]) + level(rgb[2])}m`;
  return `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

// Each block keeps its own internal alignment and is centred as a unit, so the
// wordmark, the capybara, and the tagline stay on a common vertical axis.
function centered(lines, columns) {
  const widest = lines.reduce((max, line) => Math.max(max, [...line].length), 0);
  const pad = " ".repeat(Math.max(0, Math.floor((columns - widest) / 2)));
  return lines.map((line) => (line ? `${pad}${line}` : ""));
}

function compose(version, columns) {
  const compact = columns < 66;
  const wordmark = compact ? WORDMARK_COMPACT : WORDMARK;
  const mascot = compact ? MASCOT_COMPACT : MASCOT;
  const tagline = `AUTONOMOUS CONTROL PLANE${version ? `  ·  v${version}` : ""}`;
  const rule = "─".repeat(Math.max(0, Math.min(columns - 2, [...wordmark[0]].length)));
  return [
    ...centered(wordmark, columns),
    "",
    ...centered([rule], columns),
    "",
    ...centered(mascot, columns),
    "",
    ...centered([tagline], columns),
    ...centered(["RALPH · capivara de plantão"], columns),
  ];
}

function frame(lines, base, trueColor, rows, columns) {
  const top = Math.max(0, Math.floor((rows - lines.length) / 2));
  const out = ["\u001b[H\u001b[2J"];
  for (let index = 0; index < top; index += 1) out.push("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) { out.push("\n"); return; }
    const color = ansi(colorAt(base + index * 0.018), trueColor);
    out.push(`${color}${[...line].slice(0, columns).join("")}\u001b[0m\n`);
  });
  return out.join("");
}

function showSplash(options = {}) {
  const stream = options.stream || process.stdout;
  if (process.env.RB_RALPH_SPLASH === "0") return;
  if (process.env.RB_RALPH_SPLASH_SHOWN === "1") return;
  if (process.env.NO_SPLASH || process.env.CI) return;
  if (!stream.isTTY) return;
  const term = process.env.TERM || "";
  if (!term || term === "dumb") return;

  const columns = stream.columns || 80;
  const rows = stream.rows || 24;
  if (columns < 34 || rows < 16) return;

  const requested = Number(process.env.RB_RALPH_SPLASH_MS);
  const duration = requested > 0 ? requested
    : Number(options.durationMs) > 0 ? Number(options.durationMs)
    : 1800;
  const trueColor = /truecolor|24bit/i.test(process.env.COLORTERM || "");
  const lines = compose(options.version || packagedVersion(), columns);

  const restore = () => { try { stream.write("\u001b[0m\u001b[?25h\u001b[?1049l"); } catch { /* ignore */ } };
  const interrupted = () => { restore(); process.exit(130); };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);

  stream.write("\u001b[?1049h\u001b[?25l");
  try {
    const interval = 55;
    const frames = Math.max(1, Math.round(duration / interval));
    const idle = new Int32Array(new SharedArrayBuffer(4));
    for (let index = 0; index < frames; index += 1) {
      stream.write(frame(lines, (index / frames) * 1.5, trueColor, rows, columns));
      Atomics.wait(idle, 0, 0, interval);
    }
  } catch { /* a splash must never break the run */ } finally {
    restore();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
}

module.exports = { showSplash, compose };

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--version") options.version = args[++index] ?? "";
    else if (args[index] === "--ms") options.durationMs = Number(args[++index]);
  }
  showSplash(options);
}
