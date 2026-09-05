import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { isOneOf, isRecord } from './json.js';
import { type Logger, reason } from './log.js';

export const CONFIG_PATH = join(homedir(), '.config', 'herdr-micro', 'config.toml');

/**
 * There is deliberately no colour for `unknown`: it is never rendered. Brief
 * unknown holds the previous colour, sustained unknown settles to idle.
 * See Store.applyStatus.
 */
export const COLOR_KEYS = ['idle', 'working', 'done', 'blocked'] as const;

export type ColorConfig = Record<(typeof COLOR_KEYS)[number], string>;

export const DIAL_MODES = ['workspaces', 'agents', 'scroll'] as const;
export const CONTROL_ACTIONS = [
  'popup',
  'escape',
  'tab-prev',
  'tab-next',
  'enter',
  'none',
] as const;
export const JOYSTICK_ACTIONS = ['pane', 'none'] as const;
export const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

export type DialMode = (typeof DIAL_MODES)[number];
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export type JoystickAction = (typeof JOYSTICK_ACTIONS)[number];
export type Direction = (typeof DIRECTIONS)[number];

export type ControlConfig = {
  scrollSteps: number;
  dialModeOrder: DialMode[];
  buttons: Record<string, ControlAction>;
  joystick: Record<Direction, JoystickAction>;
};

export type Config = {
  colors: ColorConfig;
  controls: ControlConfig;
  metricsEnabled: boolean;
};

export const DEFAULT_CONFIG: Config = Object.freeze<Config>({
  colors: {
    idle: '#302820',
    working: '#1E5AA8',
    done: '#1E8A3C',
    blocked: '#C87A0A',
  },
  controls: {
    scrollSteps: 1,
    dialModeOrder: ['workspaces', 'agents', 'scroll'],
    buttons: {
      ACT06: 'popup',
      ACT07: 'escape',
      ACT08: 'tab-prev',
      ACT09: 'tab-next',
      ACT10: 'none',
      ACT11: 'none',
      ACT12: 'enter',
    },
    joystick: { up: 'pane', down: 'pane', left: 'pane', right: 'pane' },
  },
  metricsEnabled: true,
});

const HEX = /^#[0-9a-fA-F]{6}$/;

function isHex(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

/**
 * All keys optional; anything missing or malformed falls back to the default.
 * A config file is a convenience, so no failure here should stop the daemon --
 * the worst case is running on defaults with a warning.
 */
export async function loadConfig(log: Logger, path = CONFIG_PATH): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // No file is the normal case, not an error.
    log.info('no config file, using defaults', { path });
    return DEFAULT_CONFIG;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    log.warn('config file is not valid TOML, using defaults', {
      path,
      reason: reason(err),
    });
    return DEFAULT_CONFIG;
  }

  const colors = section(parsed, 'colors');
  const controls = section(parsed, 'controls');

  const config: Config = {
    colors: overlay(colors, DEFAULT_CONFIG.colors, COLOR_KEYS, log, isHex),
    controls: resolveControls(controls, log),
    metricsEnabled: pick(
      section(parsed, 'metrics'),
      'enabled',
      DEFAULT_CONFIG.metricsEnabled,
      log,
      (v): v is boolean => typeof v === 'boolean',
    ),
  };

  log.info('config loaded', { path });
  return config;
}

function resolveControls(obj: Record<string, unknown>, log: Logger): ControlConfig {
  const defaults = DEFAULT_CONFIG.controls;
  return {
    scrollSteps: pick(obj, 'scroll_steps', defaults.scrollSteps, log, isScrollSteps),
    dialModeOrder: [...pick(obj, 'dial_mode_order', defaults.dialModeOrder, log, isDialModeOrder)],
    buttons: overlay(
      section(obj, 'bindings'),
      defaults.buttons,
      Object.keys(defaults.buttons),
      log,
      oneOf(CONTROL_ACTIONS),
    ),
    joystick: overlay(
      section(obj, 'joystick'),
      defaults.joystick,
      DIRECTIONS,
      log,
      oneOf(JOYSTICK_ACTIONS),
    ),
  };
}

// -- Validators. Each answers "is this value usable?", never "is it correct?" --

/** Every mode exactly once: a partial order would make some modes unreachable. */
function isDialModeOrder(v: unknown): v is DialMode[] {
  return (
    Array.isArray(v) &&
    v.length === DIAL_MODES.length &&
    new Set(v).size === DIAL_MODES.length &&
    v.every(isDialMode)
  );
}

const isDialMode = oneOf(DIAL_MODES);

/** One dial detent sends this many page keys. Capped to keep a nudge sane. */
function isScrollSteps(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 12;
}

/** Builds a type guard for a fixed set of allowed strings. */
function oneOf<T extends string>(allowed: readonly T[]): (v: unknown) => v is T {
  return (v): v is T => isOneOf(allowed, v);
}

/** A TOML table, or an empty one so callers never branch on its absence. */
function section(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  return isRecord(v) ? v : {};
}

/**
 * One key, validated: absent falls back silently, present-but-wrong falls back
 * loudly. A bad value must never reject the whole file -- a typo in one colour
 * should not cost the user every other setting.
 */
function pick<T>(
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
function overlay<K extends string, T extends string>(
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
