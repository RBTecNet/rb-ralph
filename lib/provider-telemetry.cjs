#!/usr/bin/env node
"use strict";

const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { dirname, resolve } = require("node:path");

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function baseRecord(provider, model) {
  return {
    schema: "rb-ralph-usage/v1",
    provider,
    model: model || "unknown",
    role: process.env.RB_RALPH_ROLE || "unknown",
    phaseId: process.env.RB_RALPH_PHASE_ID || "unknown",
    taskId: process.env.RB_RALPH_TASK_ID || null,
    attempt: number(process.env.RB_RALPH_ATTEMPT),
    measured: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: null,
    costSource: "unavailable",
  };
}

function codex(raw, model) {
  const record = baseRecord("codex", model);
  const visible = [];
  let parsedEvents = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
      parsedEvents += 1;
    } catch {
      visible.push(line);
      continue;
    }
    const item = event.item ?? {};
    if (event.type === "item.completed" && item.type === "agent_message" && item.text) {
      visible.push(String(item.text));
    } else if (event.type === "error") {
      visible.push(String(event.message ?? event.error?.message ?? line));
    }
    const usage = event.usage ?? event.response?.usage;
    if (usage && typeof usage === "object") {
      record.inputTokens = number(usage.input_tokens ?? usage.inputTokens);
      record.cachedInputTokens = number(
        usage.cached_input_tokens ?? usage.cachedInputTokens
          ?? usage.input_tokens_details?.cached_tokens,
      );
      record.outputTokens = number(usage.output_tokens ?? usage.outputTokens);
      record.totalTokens = number(usage.total_tokens ?? usage.totalTokens)
        || record.inputTokens + record.outputTokens;
      record.measured = record.totalTokens > 0;
    }
  }
  if (parsedEvents === 0) return { text: raw, record };
  return { text: visible.join("\n"), record };
}

function claude(raw, configuredModel) {
  const record = baseRecord("claude", configuredModel);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { text: raw, record };
  }
  const usage = value.usage ?? {};
  record.inputTokens = number(usage.input_tokens);
  record.cachedInputTokens = number(usage.cache_read_input_tokens);
  record.cacheCreationInputTokens = number(usage.cache_creation_input_tokens);
  record.outputTokens = number(usage.output_tokens);
  record.totalTokens = record.inputTokens + record.cachedInputTokens
    + record.cacheCreationInputTokens + record.outputTokens;
  record.measured = record.totalTokens > 0;
  const nativeCost = Number(value.total_cost_usd);
  if (Number.isFinite(nativeCost) && nativeCost >= 0) {
    record.costUsd = nativeCost;
    record.costSource = "provider";
  }
  const modelUsage = value.modelUsage ?? value.model_usage;
  if ((!configuredModel || configuredModel === "unknown") && modelUsage && typeof modelUsage === "object") {
    const models = Object.keys(modelUsage);
    if (models.length === 1) record.model = models[0];
  }
  return { text: String(value.result ?? value.message ?? ""), record };
}

async function main() {
  const [provider, rawPath, outputPath, model = "unknown"] = process.argv.slice(2);
  if (provider === "placeholder") {
    if (!rawPath) throw new Error("Usage: provider-telemetry.cjs placeholder <usage-json> [provider] [model]");
    await atomicJson(resolve(rawPath), baseRecord(outputPath || "custom", model));
    return;
  }
  if (!provider || !rawPath || !outputPath || !["codex", "claude"].includes(provider)) {
    throw new Error("Usage: provider-telemetry.cjs codex|claude <raw-output> <usage-json> [model]");
  }
  const raw = await readFile(resolve(rawPath), "utf8");
  const normalized = provider === "codex" ? codex(raw, model) : claude(raw, model);
  await atomicJson(resolve(outputPath), normalized.record);
  if (normalized.text) process.stdout.write(normalized.text.endsWith("\n") ? normalized.text : `${normalized.text}\n`);
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
