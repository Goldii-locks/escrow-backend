import { config, validateConfigAtStartup } from "../src/config.js";
import { submitRateLimit } from "../src/middleware/job-contract-rate-limit.js";

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

  it("RECONCILE_INTERVAL_MS=abc fails startup naming the variable (#926)", () => {
    process.env.RECONCILE_INTERVAL_MS = "abc";
    expect(() => validateConfigAtStartup()).toThrow(/RECONCILE_INTERVAL_MS/);
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

  it("SUBMIT_RATE_MAX=abc fails startup naming the variable (#873)", () => {
    void submitRateLimit; // module import registers the SUBMIT_RATE prefix
    process.env.SUBMIT_RATE_MAX = "abc";
    expect(() => validateConfigAtStartup()).toThrow(/SUBMIT_RATE_MAX/);
  });

  it("route limiter and webhook defaults are unchanged when unset (#873)", () => {
    delete process.env.SUBMIT_RATE_MAX;
    delete process.env.SUBMIT_RATE_WINDOW_MS;
    delete process.env.WEBHOOK_RATE_LIMIT_MAX;
    expect(config.webhookRateLimitMax).toBe(30);
    expect(() => validateConfigAtStartup()).not.toThrow();
  });

  it("WEBHOOK_RATE_LIMIT_MAX=20/min fails startup (#873)", () => {
    process.env.WEBHOOK_RATE_LIMIT_MAX = "20/min";
    expect(() => validateConfigAtStartup()).toThrow(/WEBHOOK_RATE_LIMIT_MAX/);
  });
});
