import { z } from "zod";

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const clientErrorSourceSchema = z.enum(["api", "tx", "render", "unhandled"]);

export const clientErrorBodySchema = z.object({
  source: clientErrorSourceSchema,
  message: z
    .string({ required_error: "message is required" })
    .min(1, "message cannot be empty")
    .max(500, "message must not exceed 500 characters"),
  route: z
    .string()
    .regex(/^\/[^?#]*$/, "route must be a path without a query string")
    .optional(),
  status: z.number().int().min(100).max(599).optional(),
  requestId: z
    .string()
    .regex(REQUEST_ID_PATTERN, "requestId must match the request-ID pattern")
    .optional(),
});

export type ClientErrorBody = z.infer<typeof clientErrorBodySchema>;
