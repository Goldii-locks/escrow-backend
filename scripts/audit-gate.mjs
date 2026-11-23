#!/usr/bin/env node
// CI audit gate (#663): fail on any high or critical advisory in production
// dependencies, except those listed with a reason in .audit-allowlist.json
// (advisories whose only fix is a major upgrade that needs its own change).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const allow = JSON.parse(readFileSync(new URL("../.audit-allowlist.json", import.meta.url), "utf8")).advisories;

let raw;
try {
  raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8" });
} catch (err) {
  // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
  raw = err.stdout;
}
const report = JSON.parse(raw);

const blocking = new Map();
for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== "object") continue;
    if (via.severity !== "high" && via.severity !== "critical") continue;
    const id = via.url?.split("/").pop();
    if (id && allow[id]) continue;
    blocking.set(id ?? `${pkg}:${via.title}`, `${pkg} (${via.severity}): ${via.title} ${via.url ?? ""}`);
  }
}

for (const id of Object.keys(allow)) {
  console.log(`allowed ${id}: ${allow[id]}`);
}
if (blocking.size > 0) {
  console.error(`\n${blocking.size} high/critical advisories not in .audit-allowlist.json:`);
  for (const line of blocking.values()) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("\nnpm audit gate passed");
