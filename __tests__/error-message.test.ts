import {
  errorMessage,
  errorStack,
  hasNumericStatus,
} from "../src/utils/error-message.js";

describe("errorMessage", () => {
  it("returns the message for an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns the message for an Error subclass", () => {
    class RpcError extends Error {}
    expect(errorMessage(new RpcError("subclass boom"))).toBe("subclass boom");
  });

  it("keeps the code and message of a bare JSON-RPC error object", () => {
    // Exactly what @stellar/stellar-sdk throws: `throw response.data.error`
    // hands us a plain object with no Error prototype.
    const jsonRpcError = { code: -32602, message: "Invalid params" };

    const message = errorMessage(jsonRpcError);

    expect(message).not.toBe("[object Object]");
    expect(message).toContain("-32602");
    expect(message).toContain("Invalid params");
  });

  it("falls back to a serialised form for non-Error values", () => {
    expect(errorMessage("plain string")).toContain("plain string");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("does not throw on a circular structure", () => {
    const circular: Record<string, unknown> = { code: -32603 };
    circular.self = circular;

    expect(() => errorMessage(circular)).not.toThrow();
    expect(typeof errorMessage(circular)).toBe("string");
  });
});

describe("errorStack", () => {
  it("returns the stack of an Error", () => {
    const err = new Error("boom");
    expect(errorStack(err)).toBe(err.stack);
  });

  it("returns undefined for a value that is not an Error", () => {
    expect(errorStack({ code: -32602, message: "Invalid params" })).toBeUndefined();
    expect(errorStack("plain string")).toBeUndefined();
    expect(errorStack(null)).toBeUndefined();
  });
});

describe("hasNumericStatus", () => {
  it("is true for a value carrying a numeric status", () => {
    expect(hasNumericStatus({ status: 404, message: "Job not found" })).toBe(true);
  });

  it("is false when status is missing or not numeric", () => {
    expect(hasNumericStatus({ message: "no status" })).toBe(false);
    expect(hasNumericStatus({ status: "404" })).toBe(false);
    expect(hasNumericStatus(null)).toBe(false);
    expect(hasNumericStatus(undefined)).toBe(false);
    expect(hasNumericStatus("boom")).toBe(false);
    expect(hasNumericStatus(new Error("boom"))).toBe(false);
  });

  it("narrows the value so `status` and `message` are readable", () => {
    const err: unknown = { status: 422, message: "Rejected" };
    if (hasNumericStatus(err)) {
      expect(err.status).toBe(422);
      expect(err.message).toBe("Rejected");
    } else {
      throw new Error("expected the guard to match");
    }
  });
});
