import { jest } from "@jest/globals";
import { retryWithBackoff } from "../src/indexer/failover-recovery.js";

describe("FailoverRecovery – retryWithBackoff", () => {
  it("increases retry delay on each connection dropout up to max attempts", async () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return originalSetTimeout(fn, 0);
      }) as unknown as typeof setTimeout);

    const timeoutError = new Error("ETIMEDOUT");
    const operation = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(timeoutError);

    await expect(
      retryWithBackoff(operation, 4, 100)
    ).rejects.toThrow("ETIMEDOUT");

    expect(operation).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([100, 200, 400]);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("returns the result once the operation succeeds within max attempts", async () => {
    const operation = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce("ok");

    const result = await retryWithBackoff(operation, 3, 10);

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
