#!/usr/bin/env node
"use strict";

const { mkdirSync, renameSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const [output, ...entries] = process.argv.slice(2);
if (!output || entries.length % 3 !== 0) {
  process.stderr.write("Usage: evidence-provenance.cjs <output.json> <path> <origin> <trust> [... ]\n");
  process.exit(2);
}
const records = [];
for (let index = 0; index < entries.length; index += 3) {
  records.push({ path: entries[index], origin: entries[index + 1], trust: entries[index + 2] });
}
const value = { contract: "rb-ralph-evidence-provenance/v1", records };
mkdirSync(dirname(resolve(output)), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, output);
