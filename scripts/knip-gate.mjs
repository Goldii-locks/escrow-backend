#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(repoRoot, "knip-baseline.json");

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function runKnip() {
  let raw = "";
  try {
    const knipBin = path.join(repoRoot, "node_modules", "knip", "bin", "knip.js");
    raw = execFileSync("node", [knipBin, "--reporter", "json"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    raw = err.stdout || "";
  }

  if (!raw.trim()) {
    throw new Error("Knip produced no output");
  }

  return JSON.parse(raw);
}

function extractFindings(report) {
  const unusedFiles = new Set();
  const unusedExports = new Set();
  const unusedTypes = new Set();

  for (const issue of report.issues || []) {
    const file = normalizePath(issue.file || "");

    // Unused files
    if (Array.isArray(issue.files) && issue.files.length > 0) {
      unusedFiles.add(file);
    }

    // Unused exports
    for (const exp of issue.exports || []) {
      const name = exp.name || "";
      if (name) unusedExports.add(`${file}:${name}`);
    }

    // Unused types
    for (const typ of issue.types || []) {
      const name = typ.name || "";
      if (name) unusedTypes.add(`${file}:${name}`);
    }

    // Unused enum members
    for (const enumMem of issue.enumMembers || []) {
      const name = enumMem.name || "";
      if (name) unusedExports.add(`${file}:${name}`);
    }
  }

  return {
    files: Array.from(unusedFiles).sort(),
    exports: Array.from(unusedExports).sort(),
    types: Array.from(unusedTypes).sort(),
  };
}

const args = process.argv.slice(2);
const isWrite = args.includes("--write") || args.includes("--update") || args.includes("--baseline");

const report = runKnip();
const currentFindings = extractFindings(report);

if (isWrite) {
  const payload = {
    _comment: "Baseline of existing Knip findings. New unused files or exports cause CI to fail.",
    generatedAt: new Date().toISOString(),
    files: currentFindings.files,
    exports: currentFindings.exports,
    types: currentFindings.types,
  };
  fs.writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Saved baseline to ${path.relative(repoRoot, baselinePath)}:`);
  console.log(`  - Unused files: ${currentFindings.files.length}`);
  console.log(`  - Unused exports: ${currentFindings.exports.length}`);
  console.log(`  - Unused types: ${currentFindings.types.length}`);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error(`Knip baseline file not found at ${path.relative(repoRoot, baselinePath)}.`);
  console.error("Run `node scripts/knip-gate.mjs --write` to generate it.");
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const baselineFiles = new Set(baseline.files || []);
const baselineExports = new Set(baseline.exports || []);
const baselineTypes = new Set(baseline.types || []);

const newFiles = currentFindings.files.filter((f) => !baselineFiles.has(f));
const newExports = currentFindings.exports.filter((e) => !baselineExports.has(e));
const newTypes = currentFindings.types.filter((t) => !baselineTypes.has(t));

const totalNew = newFiles.length + newExports.length + newTypes.length;

if (totalNew > 0) {
  console.error(`\nCI knip check failed: ${totalNew} new unused file(s) or export(s) introduced:\n`);
  if (newFiles.length > 0) {
    console.error("New unused file(s):");
    for (const f of newFiles) console.error(`  - ${f}`);
  }
  if (newExports.length > 0) {
    console.error("New unused export(s):");
    for (const e of newExports) console.error(`  - ${e}`);
  }
  if (newTypes.length > 0) {
    console.error("New unused type(s):");
    for (const t of newTypes) console.error(`  - ${t}`);
  }
  process.exit(1);
}

console.log("Knip gate passed: no new unused files or exports.");
console.log(`Checked against baseline (${baselineFiles.size} files, ${baselineExports.size} exports, ${baselineTypes.size} types tolerated).`);
process.exit(0);
