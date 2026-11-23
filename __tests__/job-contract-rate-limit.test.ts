import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import {
  makeRouteLimiter,
  jobContractRateLimit,
  resetJobContractRateLimitBuckets,
} from "../src/middleware/job-contract-rate-limit.js";

describe("makeRouteLimiter eviction", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetJobContractRateLimitBuckets();
  });

  afterEach(() => {
    resetJobContractRateLimitBuckets();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("removes buckets for expired keys when advancing past the window with 10k distinct IPs", () => {
    const createMockRes = (): Response =>
      ({
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response);

    const next: NextFunction = jest.fn();

    // 10k distinct IPs using jobContractRateLimit
    for (let i = 0; i < 10000; i++) {
      const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      const req = { ip } as Request;
      jobContractRateLimit(req, createMockRes(), next);
    }

    expect(jobContractRateLimit.buckets.size).toBe(10000);

    // Advance past the window (60,000ms)
    jest.advanceTimersByTime(60001);

    expect(jobContractRateLimit.buckets.size).toBe(0);
  });

  it("removes buckets for custom makeRouteLimiter instance with 10k distinct IPs", () => {
    const limiter = makeRouteLimiter({
      name: "custom-test",
      envPrefix: "CUSTOM_TEST_RATE",
      defaultMax: 5,
      defaultWindowMs: 30000,
    });

    const createMockRes = (): Response =>
      ({
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response);

    const next: NextFunction = jest.fn();

    for (let i = 0; i < 10000; i++) {
      const ip = `192.168.${Math.floor(i / 256)}.${i % 256}`;
      const req = { ip } as Request;
      limiter(req, createMockRes(), next);
    }

    expect(limiter.buckets.size).toBe(10000);

    jest.advanceTimersByTime(30001);

    expect(limiter.buckets.size).toBe(0);
    limiter.reset();
  });
});
