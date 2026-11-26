import type { Response } from "express";

export type ApiErrorBody = {
  success: false;
  error: string;
};

export type ApiSuccessBody<T> = {
  success: true;
  data: T;
};

export function sendError(
  res: Response,
  status: number,
  error: string
): void {
  res.status(status).json({ success: false, error } satisfies ApiErrorBody);
}

/**
 * `legacy` keeps deprecated top-level keys alongside `data` while clients
 * migrate to the standard envelope (#874).
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  options: { status?: number; legacy?: Record<string, unknown> } = {},
): void {
  const { status = 200, legacy } = options;
  res.status(status).json({ ...legacy, success: true, data } satisfies ApiSuccessBody<T>);
}
