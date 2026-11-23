/**
 * JSON.stringify that writes bigint values as decimal strings.
 * scValToNative returns i128, u64 and u128 as bigint, and the plain
 * JSON.stringify throws "Do not know how to serialize a BigInt".
 * Strings (not numbers) keep amounts above 2^53 exact.
 */
export function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}
