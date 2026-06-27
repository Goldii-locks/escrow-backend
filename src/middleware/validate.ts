import type { NextFunction, Request, Response } from "express";
import { ZodSchema, ZodError } from "zod";
import { sendError } from "../utils/api-response.js";

type Target = "params" | "body" | "query";

export function validate(
  schema: ZodSchema,
  target: Target = "params",
  onReject?: (req: Request) => void,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      onReject?.(req);
      const first = (result.error as ZodError).errors[0];
      sendError(res, 400, first.message);
      return;
    }
    req[target] = result.data;
    next();
  };
}
