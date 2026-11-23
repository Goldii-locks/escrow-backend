#!/usr/bin/env node
// Fails when .env.example and the environment variables read in src/ differ
// (#872). Every variable the code reads must be documented (set or commented
// out as `# NAME=`), and every documented variable must be read by the code.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Documented variables that are intentionally not read from src/. */
const NOT_READ_BY_SRC = new Set([
  "BACKUP_S3_BUCKET", // read by deploy/backup.sh on the host
]);

const NAME = /["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]/g;

/** Direct reads: `process.env.X`, `process.env["X"]`, and `env.X` on an injected env object. */
const DIRECT = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g,
  /\benv\.([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)/g,
];

/**
 * Helper reads: every quoted NAME among the arguments of an env-reading helper
 * (readIntEnv, readPositiveIntEnv, readFirstIntEnv, readThrottleIntEnv,
 * configuredApiKeys, ...) or an `alternatives: [...]` list.
 */
const HELPER_ARGS = [
  /\b\w*(?:Env|ApiKeys)\(([^)]*)\)/g,
  /alternatives:\s*\[([^\]]*)\]/g,
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.[cm]?[jt]s$/.test(name) ? [p] : [];
  });
}

const read = new Set();
for (const file of walk(join(ROOT, "src"))) {
  const src = readFileSync(file, "utf8");
  for (const re of DIRECT) {
    for (const m of src.matchAll(re)) read.add(m[1]);
  }
  for (const re of HELPER_ARGS) {
    for (const m of src.matchAll(re)) {
      for (const n of m[1].matchAll(NAME)) read.add(n[1]);
    }
  }
  // makeRouteLimiter({ envPrefix: "X" }) reads X_MAX and X_WINDOW_MS.
  for (const m of src.matchAll(/envPrefix:\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g)) {
    read.add(`${m[1]}_MAX`);
    read.add(`${m[1]}_WINDOW_MS`);
  }
}

const documented = new Set();
for (const line of readFileSync(join(ROOT, ".env.example"), "utf8").split("\n")) {
  const m = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
  if (m) documented.add(m[1]);
}

const undocumented = [...read].filter((v) => !documented.has(v)).sort();
const unused = [...documented]
  .filter((v) => !read.has(v) && !NOT_READ_BY_SRC.has(v))
  .sort();

if (undocumented.length || unused.length) {
  if (undocumented.length) {
    console.error("Read in src/ but missing from .env.example:\n  " + undocumented.join("\n  "));
  }
  if (unused.length) {
    console.error("In .env.example but never read in src/:\n  " + unused.join("\n  "));
  }
  process.exit(1);
}
console.log(`.env.example matches src/ (${read.size} variables).`);
