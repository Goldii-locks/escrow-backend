import { computeBackoffMs, withRetry } from "../src/indexer/rpc-poller-client.js";

describe("RpcPollerClient – exponential backoff retry", () => {
  describe("computeBackoffMs", () => {
    const config = {
      initialBackoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 30000,
    };

    it("returns initial backoff for attempt 0", () => {
      expect(computeBackoffMs(0, config)).toBe(1000);
    });

    it("doubles backoff on each attempt", () => {
      expect(computeBackoffMs(1, config)).toBe(2000);
      expect(computeBackoffMs(2, config)).toBe(4000);
      expect(computeBackoffMs(3, config)).toBe(8000);
      expect(computeBackoffMs(4, config)).toBe(16000);
    });

    it("caps at maxBackoffMs", () => {
      expect(computeBackoffMs(5, config)).toBe(30000);
      expect(computeBackoffMs(10, config)).toBe(30000);
      expect(computeBackoffMs(100, config)).toBe(30000);
    });

    it("respects custom multiplier", () => {
      const cfg3x = { ...config, backoffMultiplier: 3 };
      expect(computeBackoffMs(0, cfg3x)).toBe(1000);
      expect(computeBackoffMs(1, cfg3x)).toBe(3000);
      expect(computeBackoffMs(2, cfg3x)).toBe(9000);
    });

    it("respects custom initial backoff", () => {
      const cfg500 = { ...config, initialBackoffMs: 500 };
      expect(computeBackoffMs(0, cfg500)).toBe(500);
      expect(computeBackoffMs(1, cfg500)).toBe(1000);
    });
  });

  describe("withRetry", () => {
    it("returns result on first success without retry", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        return "ok";
      };
      const result = await withRetry(fn, { maxRetries: 3 }, "test");
      expect(result).toBe("ok");
      expect(calls).toBe(1);
    });

    it("retries on retryable error and eventually succeeds", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls === 1) throw new Error("timeout");
        if (calls === 2) throw new Error("ECONNRESET");
        return "recovered";
      };

      const result = await withRetry(
        fn,
        { maxRetries: 3, initialBackoffMs: 10 },
        "test"
      );
      expect(result).toBe("recovered");
      expect(calls).toBe(3);
    });

    it("throws after exhausting retries", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw new Error("timeout");
      };

      await expect(
        withRetry(fn, { maxRetries: 2, initialBackoffMs: 10 }, "test")
      ).rejects.toThrow("timeout");
      expect(calls).toBe(3); // initial + 2 retries
    });

    it("does not retry non-retryable errors", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw new Error("invalid argument");
      };

      await expect(
        withRetry(fn, { maxRetries: 5, initialBackoffMs: 10 }, "test")
      ).rejects.toThrow("invalid argument");
      expect(calls).toBe(1);
    });

    it("retries on various retryable patterns", async () => {
      const patterns = [
        "ECONNREFUSED",
        "ETIMEDOUT",
        "socket hang up",
        "status 429",
        "status 503",
        "request timeout",
      ];

      for (const pattern of patterns) {
        let calls = 0;
        const fn = async () => {
          calls++;
          if (calls === 1) throw new Error(pattern);
          return "ok";
        };

        const result = await withRetry(
          fn,
          { maxRetries: 1, initialBackoffMs: 10 },
          "test"
        );
        expect(result).toBe("ok");
        expect(calls).toBe(2);
      }
    });

    it("succeeds on retry after mixed failures", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls === 1) throw new Error("timeout");
        if (calls === 2) throw new Error("ECONNRESET");
        if (calls === 3) throw new Error("network");
        return "final-success";
      };

      const result = await withRetry(
        fn,
        { maxRetries: 5, initialBackoffMs: 10 },
        "test"
      );
      expect(result).toBe("final-success");
      expect(calls).toBe(4);
    });

    it("handles non-Error thrown values as non-retryable", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw "string error";
      };

      await expect(
        withRetry(fn, { maxRetries: 3, initialBackoffMs: 10 }, "test")
      ).rejects.toThrow("string error");
      expect(calls).toBe(1);
    });
  });
});
