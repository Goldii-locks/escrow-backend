import { jest } from "@jest/globals";
import { nativeToScVal } from "@stellar/stellar-sdk";

const VALID_CONTRACT =
  "CDD5WKK3WT3QVKXMXTJNDIXE4T73FK6GGXDSD6UTJAH6YYZU52SQ4MUH";
const SOURCE = "GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX";

const mockGetAccount = jest.fn<(address: string) => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<(tx: unknown) => Promise<unknown>>();
const mockPrepareTransaction = jest.fn<(tx: unknown) => Promise<unknown>>();

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
    prepareTransaction = mockPrepareTransaction;
  },
}));

const {
  simulateRead,
  simulateCall,
  prepareInvoke,
  classifySimError,
  SimError,
  InvokeError,
} = await import("../src/utils/soroban-call.js");

function mockAccount() {
  return {
    accountId: () => SOURCE,
    sequenceNumber: () => "123456789",
    incrementSequenceNumber: () => {},
  };
}

beforeEach(() => {
  mockGetAccount.mockReset();
  mockSimulateTransaction.mockReset();
  mockPrepareTransaction.mockReset();
  mockGetAccount.mockResolvedValue(mockAccount());
});

describe("classifySimError", () => {
  it.each([
    ["request timeout", 504],
    ["account not found", 404],
    ["contract not found", 404],
    ["HostError: contract error #1", 404],
    ["HostError: contract error #7", 422],
    ["panic in contract", 422],
    ["something odd", 500],
  ])("maps %s to %i", (raw, status) => {
    expect(classifySimError(raw).status).toBe(status);
  });
});

describe("simulateRead", () => {
  it("returns the decoded retval on success", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: nativeToScVal(42, { type: "u32" }) },
    });

    await expect(simulateRead(VALID_CONTRACT, "get_count")).resolves.toBe(42);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("throws a classified SimError when the simulation reports an error", async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: "HostError: contract error #7",
    });

    const err = await simulateRead(VALID_CONTRACT, "get_job").catch((e) => e);
    expect(err).toBeInstanceOf(SimError);
    expect(err.status).toBe(422);
    expect(err.message).toBe("Contract execution reverted (error code 7)");
    expect(err.rawError).toBe("HostError: contract error #7");
  });

  it("throws SimError(500) when the simulation has no retval", async () => {
    mockSimulateTransaction.mockResolvedValue({ result: {} });

    const err = await simulateRead(VALID_CONTRACT, "get_job").catch((e) => e);
    expect(err).toBeInstanceOf(SimError);
    expect(err.status).toBe(500);
  });

  it("propagates RPC throws unchanged", async () => {
    const rpcErr = new Error("socket hang up");
    mockSimulateTransaction.mockRejectedValue(rpcErr);

    await expect(simulateRead(VALID_CONTRACT, "get_job")).rejects.toBe(rpcErr);
  });

  it("propagates getAccount throws unchanged", async () => {
    const rpcErr = new Error("Account not found");
    mockGetAccount.mockRejectedValue(rpcErr);

    await expect(simulateRead(VALID_CONTRACT, "get_job")).rejects.toBe(rpcErr);
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });
});

describe("simulateCall", () => {
  it("returns the raw simulation response including errors", async () => {
    const response = { error: "contract error #2" };
    mockSimulateTransaction.mockResolvedValue(response);

    await expect(simulateCall(VALID_CONTRACT, "get_whitelisted_tokens")).resolves.toBe(
      response,
    );
  });
});

describe("prepareInvoke", () => {
  it("returns the prepared transaction XDR, fetching the source account", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "AAAA-XDR" });

    const xdr = await prepareInvoke(VALID_CONTRACT, SOURCE, "claim_auto_release", [
      nativeToScVal(1, { type: "u32" }),
    ]);

    expect(xdr).toBe("AAAA-XDR");
    expect(mockGetAccount).toHaveBeenCalledWith(SOURCE);
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
  });

  it("uses an already-loaded account without fetching it again", async () => {
    mockPrepareTransaction.mockResolvedValue({ toXDR: () => "XDR" });

    const xdr = await prepareInvoke(
      VALID_CONTRACT,
      mockAccount() as never,
      "approve_partial",
    );

    expect(xdr).toBe("XDR");
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it("throws InvokeError(stage=account) when the account lookup fails", async () => {
    mockGetAccount.mockRejectedValue(new Error("Account not found"));

    const err = await prepareInvoke(VALID_CONTRACT, SOURCE, "approve_partial").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(InvokeError);
    expect(err.stage).toBe("account");
    expect(err.message).toBe("Account not found");
    expect(mockPrepareTransaction).not.toHaveBeenCalled();
  });

  it("throws InvokeError(stage=prepare) when prepareTransaction fails", async () => {
    mockPrepareTransaction.mockRejectedValue(new Error("HostError: contract error #5"));

    const err = await prepareInvoke(VALID_CONTRACT, SOURCE, "approve_partial").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(InvokeError);
    expect(err.stage).toBe("prepare");
    expect(err.message).toBe("HostError: contract error #5");
  });
});
