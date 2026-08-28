import type { NextFunction, Request, Response } from "express";
import { ZodSchema, ZodError } from "zod";
import { sendError } from "../utils/api-response.js";
import { formatValidationError } from "../utils/validation.js";

type Target = "params" | "body" | "query";

export type RequestWithValidatedQuery = Request & {
  validatedQuery?: unknown;
};

export type ValidationErrorDetail = {
  field: string;
  message: string;
};

export function validate(
  schema: ZodSchema,
  target: Target = "params",
  onReject?: (req: Request) => void,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      onReject?.(req);
      const zodError = result.error as ZodError;
      
      // Build details array from all Zod errors
      const details: ValidationErrorDetail[] = zodError.errors.map((err) => {
        // Use the first path element as the field name (e.g., "contractId", "index")
        const field = Array.isArray(err.path) && err.path.length > 0
          ? String(err.path[0])
          : "unknown";
        return {
          field,
          message: err.message,
        };
      });
      
      // Send ValidationError response with details array
      res.status(400).json({
        success: false,
        error: "ValidationError",
        message: "Invalid request parameters",
        details,
      });
      return;
    }
    // Express 5 exposes req.query as a getter-only property, so validated
    // query data is attached on a custom field instead of reassignment.
    if (target === "query") {
      (req as RequestWithValidatedQuery).validatedQuery = result.data;
    } else {
      req[target] = result.data;
    }
    next();
  };
}
export function validateWithFields(
  schema: ZodSchema,
  target: Target = "params",
  onReject?: (req: Request) => void,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      onReject?.(req);
      const errors = (result.error as ZodError).errors;

      const fields = errors.reduce((acc, err) => {
        const path = err.path.join(".");
        if (path) {
          acc[path] = err.message;
        } else {
          acc["_root"] = err.message;
        }
        return acc;
      }, {} as Record<string, string>);

      // Same body as validate(), plus a `fields` map keyed by dotted path for
      // clients that bind errors straight onto form inputs.
      const details: ValidationErrorDetail[] = errors.map((err) => ({
        field:
          Array.isArray(err.path) && err.path.length > 0
            ? String(err.path[0])
            : "unknown",
        message: err.message,
      }));

      res.status(400).json({
        success: false,
        error: "ValidationError",
        message: "Invalid request parameters",
        details,
        fields,
      });
      return;
    }
    
    if (target === "query") {
      (req as RequestWithValidatedQuery).validatedQuery = result.data;
    } else {
      req[target] = result.data;
    }
    next();
  };
}
