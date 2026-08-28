import { jest } from "@jest/globals";
import {
  withRpcBackoff,
  computeBackoffDelayMs,
  RpcRetryError,
} from "../src/utils/backoff.js";

describe("computeBackoffDelayMs", () => {
  it("increases exponentially with each attempt", () => {
    const opts = { initialDelayMs: 100, multiplier: 2, maxDelayMs: 100000 };
    expect(computeBackoffDelayMs(1, opts)).toBe(100);
    expect(computeBackoffDelayMs(2, opts)).toBe(200);
    expect(computeBackoffDelayMs(3, opts)).toBe(400);
    expect(computeBackoffDelayMs(4, opts)).toBe(800);
  });

  it("caps the delay at maxDelayMs", () => {
    const opts = { initialDelayMs: 100, multiplier: 2, maxDelayMs: 500 };
    expect(computeBackoffDelayMs(1, opts)).toBe(100);
    expect(computeBackoffDelayMs(2, opts)).toBe(200);
    expect(computeBackoffDelayMs(3, opts)).toBe(400);
    // Would be 800 uncapped – must clamp to maxDelayMs
    expect(computeBackoffDelayMs(4, opts)).toBe(500);
    expect(computeBackoffDelayMs(5, opts)).toBe(500);
  });

  it("uses the documented defaults when no options are given", () => {
    expect(computeBackoffDelayMs(1)).toBe(250);
    expect(computeBackoffDelayMs(2)).toBe(500);
    expect(computeBackoffDelayMs(3)).toBe(1000);
  });
});

describe("withRpcBackoff", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns the result immediately on first success without retrying", async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue("ok");

    const result = await withRpcBackoff(fn, { maxAttempts: 5 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on connection dropouts with exponentially increasing delay, up to max attempts", async () => {
    const connectionTimeout = () => Promise.reject(new Error("ETIMEDOUT"));
    const fn = jest
      .fn<() => Promise<string>>()
      .mockImplementationOnce(connectionTimeout)
      .mockImplementationOnce(connectionTimeout)
      .mockImplementationOnce(connectionTimeout)
      .mockResolvedValueOnce("recovered");

    const observedDelays: number[] = [];

    const resultPromise = withRpcBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 100,
      multiplier: 2,
      maxDelayMs: 100000,
      onRetry: (_attempt, delayMs) => observedDelays.push(delayMs),
    });

    // Flush the microtask + timer queue repeatedly until the promise settles.
    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(100000);
    }

    const result = await resultPromise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(4);
    // Delay must strictly increase (exponentially) between successive retries
    expect(observedDelays).toEqual([100, 200, 400]);
  });

  it("gives up after the configured max attempts and throws RpcRetryError", async () => {
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("connection dropout"));

    const resultPromise = withRpcBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 50,
      multiplier: 2,
      maxDelayMs: 100000,
    });

    // Swallow the eventual rejection so it isn't reported as unhandled while
    // we advance timers below.
    resultPromise.catch(() => {});

    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(100000);
    }

    await expect(resultPromise).rejects.toBeInstanceOf(RpcRetryError);
    await expect(resultPromise).rejects.toMatchObject({ attempts: 3 });
    // Exactly maxAttempts calls – no retry beyond the configured maximum
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not delay before the very first attempt", async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue("ok");
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");

    await withRpcBackoff(fn, { maxAttempts: 5 });

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
