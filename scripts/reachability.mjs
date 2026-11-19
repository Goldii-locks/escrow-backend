#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, "src");
const entryFile = path.join(srcRoot, "index.ts");
const architecturePath = path.join(repoRoot, "docs", "ARCHITECTURE.md");
const startMarker = "<!-- reachability:start -->";
const endMarker = "<!-- reachability:end -->";

function walkFiles(dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, acc);
      continue;
    }
    if (entry.isFile() && abs.endsWith(".ts")) {
      acc.push(abs);
    }
  }
  return acc;
}

function normalizeImport(specifier) {
  if (!specifier.startsWith(".")) return null;
  return specifier.replace(/\\/g, "/");
}

function resolveRelativeImport(fromFile, specifier) {
  const normalized = normalizeImport(specifier);
  if (!normalized) return null;

  const withoutExt = path.resolve(path.dirname(fromFile), normalized);
  const candidates = [
    withoutExt,
    `${withoutExt}.ts`,
    `${withoutExt}.tsx`,
    `${withoutExt}.mts`,
    `${withoutExt}.cts`,
    `${withoutExt.replace(/\.js$/, "")}.ts`,
    `${withoutExt.replace(/\.mjs$/, "")}.ts`,
    `${withoutExt.replace(/\.cjs$/, "")}.ts`,
    path.join(withoutExt, "index.ts"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function collectRelativeImports(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const imports = new Set();

  const staticImportExport = /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g;
  const dynamicImport = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

  for (const matcher of [staticImportExport, dynamicImport]) {
    let match;
    while ((match = matcher.exec(source)) !== null) {
      const resolved = resolveRelativeImport(filePath, match[1]);
      if (resolved && resolved.startsWith(srcRoot)) {
        imports.add(resolved);
      }
    }
  }

  return imports;
}

function walkReachable(entry) {
  const visited = new Set();
  const stack = [entry];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    const imports = collectRelativeImports(current);
    for (const imported of imports) {
      if (!visited.has(imported)) {
        stack.push(imported);
      }
    }
  }

  return visited;
}

function buildRows() {
  if (!fs.existsSync(entryFile)) {
    throw new Error(`Entry file not found: ${path.relative(repoRoot, entryFile)}`);
  }
  const allModules = walkFiles(srcRoot).sort((a, b) => a.localeCompare(b));
  const reachableModules = walkReachable(entryFile);

  return allModules.map((modulePath) => {
    const relative = path.relative(repoRoot, modulePath).replace(/\\/g, "/");
    const status = reachableModules.has(modulePath) ? "live" : "unwired";
    const trackingIssue = status === "unwired" ? "#718" : "";
    return { module: relative, status, trackingIssue };
  });
}

function renderTable(rows) {
  const lines = [
    "| Module | Status | Tracking issue |",
    "|---|---|---|",
  ];
  for (const row of rows) {
    const issueCell = row.trackingIssue
      ? `[${row.trackingIssue}](https://github.com/Goldii-locks/escrow-backend/issues/718)`
      : "—";
    lines.push(`| \`${row.module}\` | ${row.status} | ${issueCell} |`);
  }
  return lines.join("\n");
}

function renderMarkedTable(rows) {
  return `${startMarker}\n${renderTable(rows)}\n${endMarker}`;
}

function extractMarkedTable(content) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/ARCHITECTURE.md must contain ${startMarker} and ${endMarker}`,
    );
  }
  return content.slice(start, end + endMarker.length);
}

function printSummary(rows) {
  const liveCount = rows.filter((row) => row.status === "live").length;
  const unwiredCount = rows.length - liveCount;
  console.log(`Entry: ${path.relative(repoRoot, entryFile).replace(/\\/g, "/")}`);
  console.log(`Total modules: ${rows.length}`);
  console.log(`Live modules: ${liveCount}`);
  console.log(`Unwired modules: ${unwiredCount}`);
}

const rows = buildRows();
const check = process.argv.includes("--check");
const write = process.argv.includes("--write");

if (check) {
  const content = fs.readFileSync(architecturePath, "utf8");
  const expected = renderMarkedTable(rows);
  const actual = extractMarkedTable(content);
  if (actual !== expected) {
    console.error("docs/ARCHITECTURE.md is out of sync with scripts/reachability.mjs.");
    console.error("Run `node scripts/reachability.mjs --write` to regenerate the table.");
    process.exit(1);
  }
  printSummary(rows);
  console.log("ARCHITECTURE.md reachability table is up to date.");
  process.exit(0);
}

if (write) {
  const content = fs.readFileSync(architecturePath, "utf8");
  const expected = renderMarkedTable(rows);
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/ARCHITECTURE.md must contain ${startMarker} and ${endMarker}`,
    );
  }
  const next = content.slice(0, start) + expected + content.slice(end + endMarker.length);
  fs.writeFileSync(architecturePath, next);
  printSummary(rows);
  console.log("Updated docs/ARCHITECTURE.md.");
  process.exit(0);
}

printSummary(rows);
console.log("");
console.log(renderTable(rows));
