import { formatError } from "../src/utils/format-error.js";

describe("formatError", () => {
  it("returns the message for an Error", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("returns the message for an Error subclass", () => {
    class RpcError extends Error {}
    expect(formatError(new RpcError("subclass boom"))).toBe("subclass boom");
  });

  it("serialises a JSON-RPC error object instead of [object Object]", () => {
    // Exactly what @stellar/stellar-sdk throws: jsonrpc.postObject does
    // `throw response.data.error`, handing us a bare object with no prototype.
    const jsonRpcError = { code: -32602, message: "Invalid params" };

    const formatted = formatError(jsonRpcError);

    expect(formatted).not.toBe("[object Object]");
    expect(formatted).toContain("-32602");
    expect(formatted).toContain("Invalid params");
    expect(JSON.parse(formatted)).toEqual(jsonRpcError);
  });

  it("preserves a nested data field on a JSON-RPC error", () => {
    const formatted = formatError({
      code: -32602,
      message: "Invalid params",
      data: { topic: "bad segment" },
    });
    expect(formatted).toContain("bad segment");
  });

  it("does not throw on a circular structure", () => {
    const circular: Record<string, unknown> = { code: -32603 };
    circular.self = circular;

    // The bare JSON.stringify(err) this replaces throws TypeError here, which
    // inside a catch block would discard the original error entirely.
    expect(() => JSON.stringify(circular)).toThrow(TypeError);
    expect(() => formatError(circular)).not.toThrow();
    expect(typeof formatError(circular)).toBe("string");
  });

  it("does not throw when toJSON() throws", () => {
    const hostile = {
      toJSON() {
        throw new Error("nope");
      },
    };
    expect(() => formatError(hostile)).not.toThrow();
  });

  it("handles primitives and nullish values without throwing", () => {
    expect(formatError("plain string")).toBe('"plain string"');
    expect(formatError(null)).toBe("null");
    expect(formatError(undefined)).toBe("undefined");
    expect(formatError(42)).toBe("42");
  });
});
