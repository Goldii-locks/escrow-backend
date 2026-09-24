/**
 * event_type_filter's high-frequency diagnostic logging (elapsed time +
 * payload sizes, added in poller.ts) is emitted via logger.debug(). This
 * suite exercises the real, unmocked logger.ts to confirm that call is
 * truly off by default in production - not just "not asserted on" but
 * actually filtered by winston before ever reaching a transport.
 */
import { jest } from "@jest/globals";

describe("logger level gating (event_type_filter debug diagnostics)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  it("suppresses debug-level diagnostics by default in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.LOG_LEVEL;
    jest.resetModules();

    const { default: logger } = await import("../src/utils/logger.js");

    expect(logger.level).toBe("info");
    expect(logger.isLevelEnabled("debug")).toBe(false);
  });

  it("enables debug-level diagnostics outside production", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.LOG_LEVEL;
    jest.resetModules();

    const { default: logger } = await import("../src/utils/logger.js");

    expect(logger.level).toBe("debug");
    expect(logger.isLevelEnabled("debug")).toBe(true);
  });

  it("an explicit LOG_LEVEL always overrides the NODE_ENV-based default", async () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "warn";
    jest.resetModules();

    const { default: logger } = await import("../src/utils/logger.js");

    expect(logger.level).toBe("warn");
    expect(logger.isLevelEnabled("debug")).toBe(false);
  });
});
