import {
  ESCROW_ERRORS,
  FACTORY_ERRORS,
  getContractError,
} from "../src/utils/contract-errors.js";
import { classifySimError } from "../src/utils/soroban-call.js";

describe("contract-errors", () => {
  describe("ESCROW_ERRORS mappings", () => {
    it("maps InvalidStatus (code 7) to 409", () => {
      expect(ESCROW_ERRORS[7]).toEqual({
        name: "InvalidStatus",
        message: "Milestone or escrow status does not allow this operation",
        status: 409,
      });
    });

    it("maps DeadlineNotPassed (code 11) to 409", () => {
      expect(ESCROW_ERRORS[11]).toEqual({
        name: "DeadlineNotPassed",
        message: "The auto-release window has not passed yet",
        status: 409,
      });
    });

    it("maps NotFunded (code 4) to 400", () => {
      expect(ESCROW_ERRORS[4]).toEqual({
        name: "NotFunded",
        message: "Escrow is not yet funded",
        status: 400,
      });
    });

    it("maps Paused (code 13) to 409", () => {
      expect(ESCROW_ERRORS[13]).toEqual({
        name: "Paused",
        message: "Escrow is currently paused",
        status: 409,
      });
    });

    it("maps Unauthorized (code 5) to 403", () => {
      expect(ESCROW_ERRORS[5]).toEqual({
        name: "Unauthorized",
        message: "Caller is not authorized to perform this operation",
        status: 403,
      });
    });
  });

  describe("FACTORY_ERRORS mappings", () => {
    it("maps TokenNotAllowed (code 4) to 400", () => {
      expect(FACTORY_ERRORS[4]).toEqual({
        name: "TokenNotAllowed",
        message: "Token is not allowed by factory policy",
        status: 400,
      });
    });

    it("maps Unauthorized (code 3) to 403", () => {
      expect(FACTORY_ERRORS[3]).toEqual({
        name: "Unauthorized",
        message: "Caller is not authorized to invoke factory operation",
        status: 403,
      });
    });
  });

  describe("getContractError helper", () => {
    it("returns escrow error definition when type is escrow", () => {
      const err = getContractError(7, "escrow");
      expect(err?.name).toBe("InvalidStatus");
      expect(err?.status).toBe(409);
    });

    it("returns factory error definition when type is factory", () => {
      const err = getContractError(4, "factory");
      expect(err?.name).toBe("TokenNotAllowed");
      expect(err?.status).toBe(400);
    });

    it("returns undefined for unknown code", () => {
      expect(getContractError(999, "escrow")).toBeUndefined();
    });

    it("returns undefined when contractType is omitted", () => {
      expect(getContractError(7)).toBeUndefined();
    });
  });

  describe("classifySimError with contractType", () => {
    it("classifies escrow error #7 with friendly message and name", () => {
      const classified = classifySimError("HostError: Error(Contract, #7)", "escrow");
      expect(classified).toEqual({
        status: 409,
        message: "Milestone or escrow status does not allow this operation",
        code: 7,
        name: "InvalidStatus",
      });
    });

    it("classifies escrow error #11 (DeadlineNotPassed) with 409", () => {
      const classified = classifySimError("HostError: Error(Contract, #11)", "escrow");
      expect(classified).toEqual({
        status: 409,
        message: "The auto-release window has not passed yet",
        code: 11,
        name: "DeadlineNotPassed",
      });
    });

    it("classifies factory error #4 (TokenNotAllowed) with 400", () => {
      const classified = classifySimError("HostError: Error(Contract, #4)", "factory");
      expect(classified).toEqual({
        status: 400,
        message: "Token is not allowed by factory policy",
        code: 4,
        name: "TokenNotAllowed",
      });
    });

    it("falls back to generic 422 when code is unknown to contract type", () => {
      const classified = classifySimError("HostError: Error(Contract, #99)", "escrow");
      expect(classified).toEqual({
        status: 422,
        message: "Contract execution reverted (error code 99)",
        code: 99,
      });
    });

    it("falls back to generic 422 when contract type is omitted", () => {
      const classified = classifySimError("HostError: Error(Contract, #7)");
      expect(classified).toEqual({
        status: 422,
        message: "Contract execution reverted (error code 7)",
        code: 7,
      });
    });
  });
});
