/**
 * Narrowing for data that arrived from outside this process -- a herdr socket,
 * the pad's firmware, a config file. None of it is typed by tsc, so every
 * shape here has to be checked at runtime or not claimed at all.
 *
 * These exist so no module has to reach for a cast to describe what it just
 * received. A cast on inbound data is a claim the compiler cannot check and
 * the wire is under no obligation to honour; the crash lands later, somewhere
 * else, wearing the wrong subsystem's name.
 */

/** A JSON object. Arrays are excluded: they are never a valid table here. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which quietly re-admits `any`
 * to every element read downstream. This narrows to `unknown[]` instead, so
 * the elements still have to be checked.
 */
export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** The array, or an empty one -- so callers never branch on its absence. */
export function asArray(v: unknown): unknown[] {
  return isArray(v) ? v : [];
}

/**
 * Membership in a fixed set of strings.
 *
 * `allowed.includes(v)` will not compile against an `unknown`, and the usual
 * workaround -- widening the array to `readonly string[]` with a cast -- throws
 * away the very literal types that make the guard worth having. Comparing
 * element by element needs no such help.
 */
export function isOneOf<T extends string>(allowed: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && allowed.some((a) => a === v);
}

/** A string, or undefined -- so an absent field stays absent rather than becoming `''`. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
