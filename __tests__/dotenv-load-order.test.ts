import { jest } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * #602: .env must be loaded before any module that reads process.env at top
 * level. The production assertion in src/index.ts throws once the module body
 * runs, which is after every import has been evaluated but before the server
 * starts, so jobs.ts is inspected without binding a port or touching the RPC.
 */
describe("dotenv load order (src/index.ts)", () => {
  const ORIGINAL_ENV = { ...process.env };
  let dir: string;

  beforeEach(() => {
    jest.resetModules();
    dir = mkdtempSync(join(tmpdir(), "dotenv-order-"));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads dotenv/config as the first import", () => {
    const source = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");
    const firstImport = source.match(/^import\s.*$/m)?.[0];
    expect(firstImport).toBe('import "dotenv/config";');
  });

  it("builds the jobs.ts RPC Server from a SOROBAN_RPC_URL set only in .env", async () => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "SOROBAN_RPC_URL=https://example.invalid\n");
    process.env.DOTENV_CONFIG_PATH = envFile;
    process.env.DOTENV_CONFIG_QUIET = "true";
    delete process.env.SOROBAN_RPC_URL;
    // Make the production assertion throw so index.ts stops before startup.
    process.env.NODE_ENV = "production";
    delete process.env.API_KEY;
    delete process.env.API_KEYS;

    await expect(import("../src/index.js")).rejects.toThrow(
      /Missing required production environment variables/,
    );

    const { getRpcUrl } = await import("../src/routes/jobs.js");
    expect(getRpcUrl()).toBe("https://example.invalid");
  });
});
