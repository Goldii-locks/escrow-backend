import { config, validateConfigAtStartup } from "../src/config.js";

describe("numeric env validation (#624)", () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("uses defaults when variables are unset", () => {
    delete process.env.POLL_INTERVAL_MS;
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.WHITELIST_CACHE_TTL_S;
    expect(config.pollIntervalMs).toBe(15000);
    expect(config.rateLimitMax).toBe(100);
    expect(config.whitelistCacheTtlS).toBe(60);
    expect(() => validateConfigAtStartup()).not.toThrow();
  });

  it("POLL_INTERVAL_MS=abc fails startup naming the variable", () => {
    process.env.POLL_INTERVAL_MS = "abc";
    expect(() => validateConfigAtStartup()).toThrow(/POLL_INTERVAL_MS/);
  });

  it("truncated numbers like RATE_LIMIT_MAX=100r fail startup", () => {
    process.env.RATE_LIMIT_MAX = "100r";
    expect(() => config.rateLimitMax).toThrow(/RATE_LIMIT_MAX/);
    expect(() => validateConfigAtStartup()).toThrow(/RATE_LIMIT_MAX/);
  });

  it("accepts valid overrides live without re-importing", () => {
    process.env.POLL_INTERVAL_MS = "5000";
    expect(config.pollIntervalMs).toBe(5000);
  });

  it("empty-but-set values fall back to defaults", () => {
    process.env.POLL_INTERVAL_MS = "";
    expect(config.pollIntervalMs).toBe(15000);
  });
});
