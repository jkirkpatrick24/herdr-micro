/**
 * Reading values out of a parsed TOML table, with the fallback discipline the
 * whole config depends on: absent falls back silently, present-but-wrong falls
 * back loudly, and neither ever rejects the file.
 *
 * These live in a leaf module rather than in config.ts because more than one
 * section resolver needs them and config.ts is not the only place resolvers
 * live -- src/harness/config.ts owns the `[harness]` section. Importing them
 * from config.ts instead would make that a cycle: config.ts reads
 * DEFAULT_HARNESS_CONFIG at module-evaluation time, so whichever module is
 * evaluated second wins, and the loser sees `undefined`. A leaf has no such
 * order to get wrong.
 */

import { isRecord } from './json.js';
import type { Logger } from './log.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHex(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

/** A TOML table, or an empty one so callers never branch on its absence. */
export function section(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  return isRecord(v) ? v : {};
}

/**
 * One key, validated: absent falls back silently, present-but-wrong falls back
 * loudly. A bad value must never reject the whole file -- a typo in one colour
 * should not cost the user every other setting.
 */
export function pick<T>(
  obj: Record<string, unknown>,
  key: string,
  fallback: T,
  log: Logger,
  valid: (v: unknown) => v is T,
): T {
  const v = obj[key];

  if (v === undefined) return fallback;
  if (valid(v)) return v;

  log.warn('ignoring invalid config value', { key, value: v, using: fallback });
  return fallback;
}

/**
 * The same, for a whole table. `keys` is the key set, so an unknown key in the
 * file is ignored rather than carried into the config.
 *
 * The keys are passed in rather than recovered from `Object.keys`, which is
 * typed `string[]` -- deliberately, since a value may carry properties its type
 * never declared. Naming the set is what makes this readable without a cast,
 * and it is the same list the validators are built from.
 */
export function overlay<K extends string, T extends string>(
  obj: Record<string, unknown>,
  defaults: Record<K, T>,
  keys: readonly K[],
  log: Logger,
  valid: (v: unknown) => v is T,
): Record<K, T> {
  const out = { ...defaults };
  for (const key of keys) out[key] = pick(obj, key, out[key], log, valid);
  return out;
}
