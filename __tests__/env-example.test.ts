import fs from "fs";
import path from "path";

function extractEnvsFromSrc(srcDir: string = "src"): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) {
        if (f !== "node_modules" && f !== "dist" && f !== ".git") walk(p);
      } else if (f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs")) {
        files.push(p);
      }
    }
  }
  walk(srcDir);

  const envs = new Set<string>();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const m of content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      envs.add(m[1]);
    }
    for (const m of content.matchAll(/process\.env\[["']([A-Z0-9_]+)["']\]/g)) {
      envs.add(m[1]);
    }
  }

  // Also include variables checked via helpers or alternatives in src/index.ts
  envs.add("API_KEY");
  envs.add("API_KEYS");
  envs.add("ADMIN_API_KEY");
  envs.add("ADMIN_API_KEYS");

  return Array.from(envs).sort();
}

function parseEnvExample(filePath: string = ".env.example"): Set<string> {
  const content = fs.readFileSync(filePath, "utf8");
  const keys = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Match either KEY=value or # KEY=value
    const match = trimmed.match(/^(?:#\s*)?([A-Z0-9_]+)=/);
    if (match) {
      keys.add(match[1]);
    }
  }
  return keys;
}

describe(".env.example documentation coverage", () => {
  it("documents every environment variable referenced in src/", () => {
    const srcEnvs = extractEnvsFromSrc();
    const exampleEnvs = parseEnvExample();

    const missing = srcEnvs.filter((envVar) => !exampleEnvs.has(envVar));

    expect(missing).toEqual([]);
  });

  it("passes production startup guard using .env.example definitions", async () => {
    const exampleEnvs = parseEnvExample();
    // Required production vars from src/index.ts:
    // API_KEYS / API_KEY, ADMIN_API_KEYS / ADMIN_API_KEY, ALLOWED_ORIGINS, CONTRACT_ID,
    // SOROBAN_RPC_URL, SOROBAN_NETWORK_PASSPHRASE
    expect(exampleEnvs.has("API_KEY") || exampleEnvs.has("API_KEYS")).toBe(true);
    expect(exampleEnvs.has("ADMIN_API_KEY") || exampleEnvs.has("ADMIN_API_KEYS")).toBe(true);
    expect(exampleEnvs.has("ALLOWED_ORIGINS")).toBe(true);
    expect(exampleEnvs.has("CONTRACT_ID")).toBe(true);
    expect(exampleEnvs.has("SOROBAN_RPC_URL")).toBe(true);
    expect(exampleEnvs.has("SOROBAN_NETWORK_PASSPHRASE")).toBe(true);
  });
});
