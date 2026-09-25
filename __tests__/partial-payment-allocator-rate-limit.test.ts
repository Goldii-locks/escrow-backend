import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import {
  partialPaymentAllocatorRateLimit,
  resetPartialPaymentAllocatorRateLimitBuckets,
} from "../src/middleware/job-contract-rate-limit.js";

// Mock Express Request, Response, and NextFunction
interface MockRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface MockResponse {
  status: jest.Mock<(code: number) => MockResponse>;
  json: jest.Mock<(data: unknown) => MockResponse>;
  setHeader: jest.Mock<(name: string, value: string) => void>;
  statusCode?: number;
  _json?: unknown;
}

function createMockRequest(ip: string): MockRequest {
  return {
    ip,
    socket: { remoteAddress: ip },
  };
}

function createMockResponse(): MockResponse {
  const res = {} as MockResponse;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((data: unknown) => {
    res._json = data;
    return res;
  });
  res.setHeader = jest.fn<(name: string, value: string) => void>();
  return res;
}

describe("partialPaymentAllocatorRateLimit", () => {
  beforeEach(() => {
    resetPartialPaymentAllocatorRateLimitBuckets();
    jest.clearAllMocks();
    // Mock environment variables with defaults
    process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_WINDOW_MS = "60000";
    process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_MAX = "50";
  });

  afterEach(() => {
    resetPartialPaymentAllocatorRateLimitBuckets();
    delete process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_WINDOW_MS;
    delete process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_MAX;
  });

  describe("Basic Rate Limiting", () => {
    it("should allow requests under the limit", () => {
      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      for (let i = 0; i < 50; i++) {
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      expect(next).toHaveBeenCalledTimes(50);
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should reject requests exceeding the limit with 429 status", () => {
      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      // Make 51 requests (over the default limit of 50)
      for (let i = 0; i < 51; i++) {
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Too many requests, please try again later",
      });
      expect(next).toHaveBeenCalledTimes(50);
    });

    it("should return proper rate limit headers", () => {
      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      partialPaymentAllocatorRateLimit(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", "50");
      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "49");
      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Reset",
        expect.any(String)
      );
    });

    it("should correctly decrement remaining count", () => {
      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      // First request
      partialPaymentAllocatorRateLimit(req, res, next);
      let calls = res.setHeader.mock.calls;
      expect(calls[calls.length - 2][1]).toBe("49"); // Remaining after 1st request

      // Fifth request
      for (let i = 0; i < 4; i++) {
        res.setHeader.mockClear();
        partialPaymentAllocatorRateLimit(req, res, next);
      }
      calls = res.setHeader.mock.calls;
      expect(calls[calls.length - 2][1]).toBe("45"); // Remaining after 5th request
    });
  });

  describe("Multiple Client Isolation", () => {
    it("should track separate buckets for different IPs", () => {
      const req1 = createMockRequest("192.168.1.1") as any;
      const req2 = createMockRequest("192.168.1.2") as any;
      const res1 = createMockResponse() as any;
      const res2 = createMockResponse() as any;
      const next = jest.fn() as any;

      // Client 1 makes 50 requests
      for (let i = 0; i < 50; i++) {
        partialPaymentAllocatorRateLimit(req1, res1, next);
      }

      // Client 2 makes 1 request
      res2.setHeader.mockClear();
      partialPaymentAllocatorRateLimit(req2, res2, next);

      // Client 2 should still have requests available
      const calls = res2.setHeader.mock.calls;
      expect(calls.some((call: unknown[]) => call[0] === "X-RateLimit-Remaining")).toBe(
        true
      );
      const remainingCall = calls.find((call: unknown[]) => call[0] === "X-RateLimit-Remaining");
      expect(remainingCall?.[1]).toBe("49");

      // Client 1's 51st request should be rejected
      res1.status.mockClear();
      partialPaymentAllocatorRateLimit(req1, res1, next);
      expect(res1.status).toHaveBeenCalledWith(429);
    });

    it("should handle requests with fallback to socket.remoteAddress", () => {
      const req = {
        ip: undefined,
        socket: { remoteAddress: "10.0.0.1" },
      } as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      partialPaymentAllocatorRateLimit(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should handle requests with no IP (unknown client)", () => {
      const req = {
        ip: undefined,
        socket: undefined,
      } as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      // Multiple requests from "unknown" client should still be rate limited
      for (let i = 0; i < 51; i++) {
        res.status.mockClear();
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      expect(res.status).toHaveBeenCalledWith(429);
    });
  });

  describe("Environment Configuration", () => {
    it("should use custom window duration from environment", () => {
      process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_WINDOW_MS = "30000";
      process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_MAX = "10";

      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      // Make 11 requests (over custom limit of 10)
      for (let i = 0; i < 11; i++) {
        res.status.mockClear();
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it("should use custom max requests from environment", () => {
      process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_MAX = "5";

      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      // Make 6 requests (over custom limit of 5)
      for (let i = 0; i < 6; i++) {
        res.status.mockClear();
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it("should fall back to defaults for invalid environment values", () => {
      process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_MAX = "invalid";
      process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_WINDOW_MS = "-1000";

      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      // Should still use defaults (50 requests)
      for (let i = 0; i < 51; i++) {
        res.status.mockClear();
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      expect(res.status).toHaveBeenCalledWith(429);
    });
  });

  describe("Window Reset", () => {
    it("should reset bucket after window expires", (done) => {
      process.env.PARTIAL_PAYMENT_ALLOCATOR_RATE_WINDOW_MS = "100"; // 100ms window

      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      // Fill up the bucket
      for (let i = 0; i < 50; i++) {
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      // Next request should be rejected
      res.status.mockClear();
      partialPaymentAllocatorRateLimit(req, res, next);
      expect(res.status).toHaveBeenCalledWith(429);

      // Wait for window to expire
      setTimeout(() => {
        res.status.mockClear();
        next.mockClear();
        partialPaymentAllocatorRateLimit(req, res, next);

        // Should be allowed again
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        done();
      }, 150);
    });
  });

  describe("Rate Limit Headers", () => {
    it("should include all required rate limit headers", () => {
      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      partialPaymentAllocatorRateLimit(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Limit",
        expect.any(String)
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Remaining",
        expect.any(String)
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Reset",
        expect.any(String)
      );
    });

    it("should set reset time correctly", () => {
      const beforeRequest = Math.ceil(Date.now() / 1000);
      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      partialPaymentAllocatorRateLimit(req, res, next);

      const resetCalls = res.setHeader.mock.calls.filter(
        (call: unknown[]) => call[0] === "X-RateLimit-Reset"
      );
      expect(resetCalls.length).toBeGreaterThan(0);

      const resetTime = parseInt(resetCalls[0][1]);
      const expectedMin = beforeRequest + 60; // 60 second window
      const expectedMax = beforeRequest + 61;

      expect(resetTime).toBeGreaterThanOrEqual(expectedMin);
      expect(resetTime).toBeLessThanOrEqual(expectedMax);
    });
  });

  describe("Response Format", () => {
    it("should return correct 429 response format when limit exceeded", () => {
      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      // Exceed limit
      for (let i = 0; i < 51; i++) {
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "Too many requests, please try again later",
        })
      );
    });
  });

  describe("Reset Functionality", () => {
    it("should clear all buckets when reset is called", () => {
      const req1 = createMockRequest("192.168.1.1") as any;
      const req2 = createMockRequest("192.168.1.2") as any;
      const res1 = createMockResponse() as any;
      const res2 = createMockResponse() as any;
      const next = jest.fn() as any;

      // Fill both clients' buckets
      for (let i = 0; i < 50; i++) {
        partialPaymentAllocatorRateLimit(req1, res1, next);
        partialPaymentAllocatorRateLimit(req2, res2, next);
      }

      // Reset buckets
      resetPartialPaymentAllocatorRateLimitBuckets();

      // Both clients should be able to make requests again
      res1.status.mockClear();
      res2.status.mockClear();
      next.mockClear();

      partialPaymentAllocatorRateLimit(req1, res1, next);
      partialPaymentAllocatorRateLimit(req2, res2, next);

      expect(next).toHaveBeenCalledTimes(2);
      expect(res1.status).not.toHaveBeenCalled();
      expect(res2.status).not.toHaveBeenCalled();
    });
  });

  describe("Remaining Count Logic", () => {
    it("should show 0 remaining when limit is reached", () => {
      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      for (let i = 0; i < 50; i++) {
        res.setHeader.mockClear();
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      const calls = res.setHeader.mock.calls;
      const remainingCall = calls.find((call: unknown[]) => call[0] === "X-RateLimit-Remaining");
      expect(remainingCall?.[1]).toBe("0");
    });

    it("should never show negative remaining count", () => {
      const req = createMockRequest("192.168.1.1") as any;
      const res = createMockResponse() as any;
      const next = jest.fn() as any;

      // Make requests well over the limit
      for (let i = 0; i < 100; i++) {
        res.setHeader.mockClear();
        partialPaymentAllocatorRateLimit(req, res, next);
      }

      // Check that no negative remaining was ever set
      const allRemainingSets = res.setHeader.mock.calls.filter(
        (call: unknown[]) => call[0] === "X-RateLimit-Remaining"
      );

      allRemainingSets.forEach((call: unknown[]) => {
        const remaining = parseInt(String(call[1]));
        expect(remaining).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
