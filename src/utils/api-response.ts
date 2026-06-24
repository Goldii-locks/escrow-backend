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

export function sendSuccess<T>(res: Response, data: T): void {
  res.status(200).json({ success: true, data } satisfies ApiSuccessBody<T>);
}
