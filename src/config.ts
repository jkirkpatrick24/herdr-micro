import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { isHex, overlay, pick, section } from './config-values.js';
import {
  DEFAULT_HARNESS_CONFIG,
  type HarnessConfig,
  resolveHarnessConfig,
} from './harness/config.js';
import { isOneOf } from './json.js';
import { type Logger, reason } from './log.js';

export const CONFIG_PATH = join(homedir(), '.config', 'herdr-micro', 'config.toml');

/**
 * There is deliberately no colour for `unknown`: it is never rendered. Brief
 * unknown holds the previous colour, sustained unknown settles to idle.
 * See Store.applyStatus.
 */
export const COLOR_KEYS = ['idle', 'working', 'done', 'blocked'] as const;

export type ColorConfig = Record<(typeof COLOR_KEYS)[number], string>;

export const DIAL_MODES = ['workspaces', 'agents', 'harness'] as const;
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
  dialModeOrder: DialMode[];
  buttons: Record<string, ControlAction>;
  joystick: Record<Direction, JoystickAction>;
};

/**
 * The underglow. `color` holds one colour and stops the ring indicating the
 * dial mode; leaving it unset keeps the indicator and uses `dial`.
 */
export type UnderglowConfig = {
  color: string | null;
  brightness: number;
  dial: Record<DialMode, string>;
};

export type Config = {
  colors: ColorConfig;
  controls: ControlConfig;
  underglow: UnderglowConfig;
  /** The second layer. Resolved in src/harness/config.ts, which owns its shape. */
  harness: HarnessConfig;
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
    dialModeOrder: ['workspaces', 'agents', 'harness'],
    buttons: {
      ACT06: 'popup',
      ACT07: 'escape',
      ACT08: 'tab-prev',
      ACT09: 'tab-next',
      // The two switches under the wide keycap. Reserved for dictation, which
      // has not landed yet -- bind them yourself in the meantime.
      ACT10: 'none',
      ACT11: 'none',
      ACT12: 'enter',
    },
    joystick: { up: 'pane', down: 'pane', left: 'pane', right: 'pane' },
  },
  underglow: {
    color: null,
    brightness: 0.5,
    // Shopify's palette: the logo green, then Polaris blue. Three Shopify
    // greens would be truer to the brand and unreadable on a diffused ring at
    // half brightness, which is the whole job of the indicator.
    //
    // `harness` is the odd one out and is nearly always painted over: the layer
    // shows the focused harness's own colour instead. It is what the ring falls
    // back to before that resolves, so it matches `[harness.underglow] active`.
    dial: { workspaces: '#95BF47', agents: '#2C6ECB', harness: '#8A6A4F' },
  },
  harness: DEFAULT_HARNESS_CONFIG,
  metricsEnabled: true,
});

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

  const harness = resolveHarnessConfig(section(parsed, 'harness'), log);

  const config: Config = {
    colors: overlay(colors, DEFAULT_CONFIG.colors, COLOR_KEYS, log, isHex),
    controls: resolveControls(controls, log, harness.enabled),
    underglow: resolveUnderglow(section(parsed, 'underglow'), log),
    harness,
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

function resolveControls(
  obj: Record<string, unknown>,
  log: Logger,
  harnessEnabled: boolean,
): ControlConfig {
  const defaults = DEFAULT_CONFIG.controls;
  const order = pick(obj, 'dial_mode_order', defaults.dialModeOrder, log, isDialModeOrder);

  return {
    // A disabled layer must not leave a mode in the cycle that does nothing --
    // `[harness] enabled = false` is meant to read as "this never shipped", and
    // a dead detent on the dial is the most visible way to break that promise.
    dialModeOrder: withoutDisabledHarness(order, harnessEnabled, log),
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

function resolveUnderglow(obj: Record<string, unknown>, log: Logger): UnderglowConfig {
  const defaults = DEFAULT_CONFIG.underglow;
  return {
    color: pick(obj, 'color', defaults.color, log, isHexOrNull),
    brightness: pick(obj, 'brightness', defaults.brightness, log, isBrightness),
    dial: overlay(section(obj, 'dial'), defaults.dial, DIAL_MODES, log, isHex),
  };
}

// -- Validators. Each answers "is this value usable?", never "is it correct?" --
//
// The generic ones -- isHex, section, pick, overlay -- live in config-values.ts
// so that src/harness/config.ts can resolve its own section without importing
// this module back. See the note there.

/**
 * A non-empty set of distinct modes. An omitted mode is unreachable, which is
 * a choice the user is allowed to make -- and one made for them when
 * `[harness] enabled` is false. A duplicate is not: a mode reached twice per
 * cycle is nothing anyone means.
 */
function isDialModeOrder(v: unknown): v is DialMode[] {
  return Array.isArray(v) && v.length > 0 && new Set(v).size === v.length && v.every(isDialMode);
}

const isDialMode = oneOf(DIAL_MODES);

/** Unset means "show the dial mode", so absent is a value here rather than a gap. */
function isHexOrNull(v: unknown): v is string | null {
  return v === null || isHex(v);
}

/** The firmware takes a 0-1 fraction; anything outside it is a typo, not a dim. */
function isBrightness(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * `harness` removed when the layer is switched off, unless that would leave the
 * dial with no modes at all -- an order of exactly `["harness"]` is a config the
 * user can write, and an empty cycle would strand the dial rather than honour it.
 */
function withoutDisabledHarness(
  order: readonly DialMode[],
  enabled: boolean,
  log: Logger,
): DialMode[] {
  if (enabled) return [...order];

  const kept = order.filter((mode) => mode !== 'harness');
  if (kept.length > 0) return kept;

  // Every other fallback in this file is either absent-and-silent or
  // present-but-wrong-and-loud. This one is neither: the order is well formed
  // and the layer is switched off, and the two are only contradictory together.
  // Handing back an order the user never wrote is worth saying out loud.
  const using = DEFAULT_CONFIG.controls.dialModeOrder.filter((m) => m !== 'harness');
  log.warn('dial_mode_order names only harness, which is disabled', { using });
  return using;
}

/** Builds a type guard for a fixed set of allowed strings. */
function oneOf<T extends string>(allowed: readonly T[]): (v: unknown) => v is T {
  return (v): v is T => isOneOf(allowed, v);
}
