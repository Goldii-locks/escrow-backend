import { jest } from "@jest/globals";
import {
  getAllowedOrigins,
  jobContractSecurityHeaders,
  timeRemainingSecurityHeaders,
} from "../src/middleware/job-contract-security.js";

function mocks() {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
  };
  const next = jest.fn();
  return { req: {} as any, res, next, headers };
}

describe("job-contract-security helpers", () => {
  const OLD = process.env.ALLOWED_ORIGINS;
  afterAll(() => {
    if (OLD === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = OLD;
  });

  it("getAllowedOrigins handles unset/empty/whitespace", () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(getAllowedOrigins()).toEqual(["http://localhost:3000"]);
    process.env.ALLOWED_ORIGINS = "";
    expect(getAllowedOrigins()).toEqual(["http://localhost:3000"]);
    process.env.ALLOWED_ORIGINS = "   ";
    expect(getAllowedOrigins()).toEqual(["http://localhost:3000"]);
    process.env.ALLOWED_ORIGINS =
      " https://a.example , ,https://b.example ";
    expect(getAllowedOrigins()).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it.each([
    ["jobContractSecurityHeaders", jobContractSecurityHeaders],
    ["timeRemainingSecurityHeaders", timeRemainingSecurityHeaders],
  ])("%s sets nosniff, frame and CSP headers then calls next()", (_name, mw) => {
    const { req, res, next, headers } = mocks();
    (mw as any)(req, res, next);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Content-Security-Policy"]).toBeDefined();
    expect(next).toHaveBeenCalled();
  });
});
