import type { Request, Response, NextFunction } from "express";

/**
 * Default API_KEY value for suites that are not themselves exercising the
 * API-key gate. jest.setup.ts installs this before every test.
 */
export const TEST_API_KEY = "jest-default-api-key";

/**
 * Test-only middleware that authenticates requests for suites whose subject
 * is something other than the API-key gate (validation, caching, error
 * mapping, rate limiting, logging).
 *
 * Background: the job routes used to skip authentication entirely when
 * API_KEY was unset, so these suites reached their handlers without sending
 * anything. That gate now fails closed, so they have to authenticate.
 *
 * Injection is deliberately conditional on API_KEY still holding
 * TEST_API_KEY. The dedicated auth suites set their own value (e.g.
 * "secret-test-key") in a beforeEach, and for those this middleware does
 * nothing — so assertions like "401 when a key is required but none is
 * provided" keep testing exactly what they did before. An explicit
 * x-api-key header on the request is likewise never overwritten, so
 * wrong-key cases still reach the gate unchanged.
 */
export function autoAuth(req: Request, _res: Response, next: NextFunction): void {
  if (
    process.env.API_KEY === TEST_API_KEY &&
    req.headers["x-api-key"] === undefined
  ) {
    req.headers["x-api-key"] = TEST_API_KEY;
  }
  next();
}
