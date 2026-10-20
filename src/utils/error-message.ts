import { formatError } from "./format-error.js";

/**
 * Narrow an unknown thrown value to a record with a numeric `status`.
 *
 * `catch (err: unknown)` is the safe way to catch, but the codebase has a
 * handful of places that read an HTTP-ish `status` off the caught value. This
 * type guard keeps those call sites type-safe without an `any` cast.
 */
export function hasNumericStatus(
  err: unknown,
): err is { status: number; message?: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

/**
 * Render an unknown thrown value as a loggable message string.
 *
 * Prefer this over `err?.message ?? String(err)`: the optional-chaining form
 * is only valid when the caught value is typed `any`, and `String(err)` on a
 * bare JSON-RPC error object collapses to `"[object Object]"`, losing the
 * code and message the Soroban SDK actually hands us.
 *
 * Delegates to {@link formatError}, so JSON-RPC error objects keep their
 * `code`/`message` payload in the log line.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return formatError(err);
}

/**
 * Return the stack of an unknown thrown value, when it has one.
 *
 * Only `Error` instances carry a stack; a bare JSON-RPC error object does
 * not, so this returns `undefined` for those rather than inventing one.
 */
export function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}
