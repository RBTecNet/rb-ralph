#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");

const [versionFile, identityFile] = process.argv.slice(2);
if (!versionFile || !identityFile) {
  process.stderr.write("Usage: release-identity.cjs <VERSION> <RB-RALPH-CONTRACT-IDENTITY.json>\n");
  process.exit(2);
}
const version = readFileSync(versionFile, "utf8").trim();
const identity = JSON.parse(readFileSync(identityFile, "utf8"));
if (identity.contract !== "rb-ralph-release-identity/v1" || identity.runtimeVersion !== version) {
  process.stderr.write("ERROR: RB Ralph runtime VERSION and contract identity metadata are incompatible\n");
  process.exit(1);
}
if (identity.consolidatedContract?.status === "current" && identity.consolidatedContract.snapshotRuntimeVersion !== version) {
  process.stderr.write("ERROR: a current consolidated contract cannot claim a different RB Ralph runtime version\n");
  process.exit(1);
}
if (!Array.isArray(identity.dataContracts) || !identity.dataContracts.includes("rb-execution/v1")) {
  process.stderr.write("ERROR: release identity must name authoritative versioned data contracts\n");
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ contract: identity.contract, runtimeVersion: version, consolidatedContract: identity.consolidatedContract, dataContracts: identity.dataContracts })}\n`);
