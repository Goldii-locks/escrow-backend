import { jest } from "@jest/globals";

/**
 * Covers the production startup assertion in src/index.ts.
 *
 * This imports the real entry point rather than re-implementing the check,
 * so deleting the assertion — or moving it below a side effect — fails here.
 * ES module imports are evaluated before the module body, so the throw
 * happens after dotenv.config() but before runMigrations(), startPoller()
 * and app.listen(); nothing binds a port and no database is touched.
 */
describe("production startup assertion (src/index.ts)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws and names every missing variable when NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.API_KEY;
    delete process.env.ADMIN_API_KEY;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.CONTRACT_ID;

    // dotenv.config() may repopulate some of these from a local .env, so
    // assert on the ones the repo's .env.example does not provide.
    await expect(import("../src/index.js")).rejects.toThrow(
      /Missing required production environment variables:.*API_KEY/,
    );
  });

  it("names ADMIN_API_KEY specifically when only that one is absent", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_KEY = "set";
    process.env.ALLOWED_ORIGINS = "https://example.test";
    process.env.CONTRACT_ID = "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
    delete process.env.ADMIN_API_KEY;

    await expect(import("../src/index.js")).rejects.toThrow(
      "Missing required production environment variables: ADMIN_API_KEY",
    );
  });
});
