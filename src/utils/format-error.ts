/**
 * Render an unknown thrown value as a string suitable for a log field.
 *
 * `String(err)` collapses any non-Error to "[object Object]", which is exactly
 * what the Soroban RPC hands us: `@stellar/stellar-sdk`'s `jsonrpc.postObject`
 * does `throw response.data.error`, so a JSON-RPC failure arrives as a bare
 * `{ code, message }` object with no Error prototype. Serialising it keeps the
 * code and message in the log line instead of discarding both.
 *
 * `JSON.stringify` throws a TypeError on circular structures (and on a
 * `toJSON()` that throws). Every caller here is inside a catch block, where a
 * throw would replace the original error with a meaningless one and lose the
 * failure entirely — so serialisation is guarded and falls back to `String`.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;

  try {
    const serialised = JSON.stringify(err);
    // JSON.stringify returns undefined for undefined, functions and symbols.
    if (serialised !== undefined) return serialised;
  } catch {
    // Circular structure or a throwing toJSON() — fall through to String().
  }

  return String(err);
}
