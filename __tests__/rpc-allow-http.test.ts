import { rpcAllowHttp } from "../src/utils/rpc-allow-http.js";

describe("rpcAllowHttp", () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("allows an http:// URL outside production", () => {
    process.env.NODE_ENV = "development";
    expect(rpcAllowHttp("http://localhost:8000/soroban/rpc")).toBe(true);
  });

  it("never allows http:// in production", () => {
    process.env.NODE_ENV = "production";
    expect(rpcAllowHttp("http://localhost:8000/soroban/rpc")).toBe(false);
  });

  it("does not need it for https:// URLs", () => {
    process.env.NODE_ENV = "development";
    expect(rpcAllowHttp("https://soroban-testnet.stellar.org")).toBe(false);
  });
});
