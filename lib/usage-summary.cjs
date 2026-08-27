#!/usr/bin/env node
"use strict";

const { mkdir, readFile, readdir, rename, writeFile } = require("node:fs/promises");
const { dirname, resolve } = require("node:path");

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function loadPricing(path) {
  if (!path) return { currency: "USD", models: {} };
  const value = JSON.parse(await readFile(resolve(path), "utf8"));
  const currency = String(value.currency ?? "USD").toUpperCase();
  if (currency !== "USD") throw new Error("Pricing currency must be USD; currency conversion is not implicit");
  return { currency, models: value.models ?? {} };
}

function estimatedCost(record, prices) {
  const price = prices.models?.[record.model];
  if (!price) return null;
  const input = finite(record.inputTokens);
  const cached = finite(record.cachedInputTokens);
  const uncached = record.provider === "codex" ? input - Math.min(input, cached) : input;
  const cacheWrite = finite(record.cacheCreationInputTokens);
  const output = finite(record.outputTokens);
  return (
    uncached * finite(price.inputPerMillion)
    + cached * finite(price.cachedInputPerMillion ?? price.inputPerMillion)
    + cacheWrite * finite(price.cacheWritePerMillion ?? price.inputPerMillion)
    + output * finite(price.outputPerMillion)
  ) / 1_000_000;
}

async function main() {
  const [usageDirectory, outputPath, pricingPath = ""] = process.argv.slice(2);
  if (!usageDirectory || !outputPath) {
    throw new Error("Usage: usage-summary.cjs <usage-directory> <output-tsv> [pricing-json]");
  }
  const directory = resolve(usageDirectory);
  const pricing = await loadPricing(pricingPath);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".usage.json")) continue;
    try {
      const value = JSON.parse(await readFile(resolve(directory, entry.name), "utf8"));
      if (value.schema === "rb-ralph-usage/v1") records.push(value);
    } catch {
      // A provider may still be atomically publishing this record; the next refresh retries it.
    }
  }
  const summary = {
    calls: records.length,
    measuredCalls: 0,
    unmeasuredCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    derivedUncachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    knownCostCalls: 0,
    unknownCostCalls: 0,
    cost: 0,
    currency: pricing.currency,
    costSource: "unavailable",
    contextCompactionCalls: 0,
  };
  const sources = new Set();
  const groups = new Map();
  for (const record of records) {
    if (record.measured) summary.measuredCalls += 1;
    else summary.unmeasuredCalls += 1;
    summary.inputTokens += finite(record.inputTokens);
    summary.cachedInputTokens += finite(record.cachedInputTokens);
    summary.derivedUncachedInputTokens += record.inputIncludesCached === false
      ? finite(record.inputTokens)
      : Math.max(0, finite(record.inputTokens) - finite(record.cachedInputTokens));
    summary.cacheCreationInputTokens += finite(record.cacheCreationInputTokens);
    summary.outputTokens += finite(record.outputTokens);
    summary.totalTokens += finite(record.totalTokens);
    if (record.contextCompactionObserved === true) summary.contextCompactionCalls += 1;
    let cost = record.costUsd == null ? null : finite(record.costUsd);
    let source = record.costSource === "provider" ? "provider" : null;
    if (cost == null) {
      cost = estimatedCost(record, pricing);
      if (cost != null) source = "configured-pricing";
    }
    if (cost == null) summary.unknownCostCalls += 1;
    else {
      summary.cost += cost;
      summary.knownCostCalls += 1;
      sources.add(source);
    }
    const groupKey = `${record.provider ?? "unknown"}\u0000${record.model ?? "unknown"}`;
    const group = groups.get(groupKey) ?? {
      provider: record.provider ?? "unknown", model: record.model ?? "unknown",
      calls: 0, measuredCalls: 0, inputTokens: 0, cachedInputTokens: 0,
      derivedUncachedInputTokens: 0,
      cacheCreationInputTokens: 0, outputTokens: 0, totalTokens: 0,
      contextCompactionCalls: 0,
      cost: 0, knownCostCalls: 0, unknownCostCalls: 0, sources: new Set(),
    };
    group.calls += 1;
    if (record.measured) group.measuredCalls += 1;
    group.inputTokens += finite(record.inputTokens);
    group.cachedInputTokens += finite(record.cachedInputTokens);
    group.derivedUncachedInputTokens += record.inputIncludesCached === false
      ? finite(record.inputTokens)
      : Math.max(0, finite(record.inputTokens) - finite(record.cachedInputTokens));
    group.cacheCreationInputTokens += finite(record.cacheCreationInputTokens);
    group.outputTokens += finite(record.outputTokens);
    group.totalTokens += finite(record.totalTokens);
    if (record.contextCompactionObserved === true) group.contextCompactionCalls += 1;
    if (cost == null) group.unknownCostCalls += 1;
    else {
      group.cost += cost;
      group.knownCostCalls += 1;
      group.sources.add(source);
    }
    groups.set(groupKey, group);
  }
  if (sources.size === 1) summary.costSource = [...sources][0];
  else if (sources.size > 1) summary.costSource = "mixed";
  const rows = Object.entries(summary).map(([key, value]) => `USAGE\t${key}\t${value}`);
  for (const group of [...groups.values()].sort((left, right) =>
    `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))) {
    const source = group.sources.size === 1 ? [...group.sources][0]
      : group.sources.size > 1 ? "mixed" : "unavailable";
    rows.push([
      "MODEL", group.provider, group.model, group.calls, group.measuredCalls,
      group.inputTokens, group.cachedInputTokens, group.cacheCreationInputTokens,
      group.outputTokens, group.totalTokens, group.cost, group.knownCostCalls,
      group.unknownCostCalls, source,
      group.derivedUncachedInputTokens, group.contextCompactionCalls,
    ].join("\t"));
  }
  await atomicWrite(resolve(outputPath), `${rows.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
