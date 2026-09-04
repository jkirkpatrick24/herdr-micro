import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import type { Logger } from './log.js';

export const CONFIG_PATH = join(homedir(), '.config', 'herdr-micro', 'config.toml');

export type GestureConfig = {
  tapMaxMs: number;
  doubleGapMs: number;
  holdMs: number;
};

/**
 * There is deliberately no colour for `unknown`: it is never rendered. Brief
 * unknown holds the previous colour, sustained unknown settles to idle.
 * See Store.applyStatus.
 */
export type ColorConfig = {
  idle: string;
  working: string;
  done: string;
  blocked: string;
};

export type Config = {
  gestures: GestureConfig;
  colors: ColorConfig;
  metricsEnabled: boolean;
};

export const DEFAULT_CONFIG: Config = Object.freeze({
  gestures: { tapMaxMs: 400, doubleGapMs: 250, holdMs: 500 },
  colors: {
    idle: '#302820',
    working: '#1E5AA8',
    done: '#1E8A3C',
    blocked: '#C87A0A',
  },
  metricsEnabled: true,
}) as Config;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** All keys optional; anything missing or malformed falls back to the default. */
export async function loadConfig(log: Logger, path = CONFIG_PATH): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    log.info('no config file, using defaults', { path });
    return DEFAULT_CONFIG;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn('config file is not valid TOML, using defaults', {
      path,
      reason: err instanceof Error ? err.message : String(err),
    });
    return DEFAULT_CONFIG;
  }

  const gestures = section(parsed, 'gestures');
  const colors = section(parsed, 'colors');

  const config: Config = {
    gestures: {
      tapMaxMs: num(gestures, 'tap_max_ms', DEFAULT_CONFIG.gestures.tapMaxMs, log),
      doubleGapMs: num(gestures, 'double_gap_ms', DEFAULT_CONFIG.gestures.doubleGapMs, log),
      holdMs: num(gestures, 'hold_ms', DEFAULT_CONFIG.gestures.holdMs, log),
    },
    colors: {
      idle: hex(colors, 'idle', DEFAULT_CONFIG.colors.idle, log),
      working: hex(colors, 'working', DEFAULT_CONFIG.colors.working, log),
      done: hex(colors, 'done', DEFAULT_CONFIG.colors.done, log),
      blocked: hex(colors, 'blocked', DEFAULT_CONFIG.colors.blocked, log),
    },
    metricsEnabled: bool(section(parsed, 'metrics'), 'enabled', DEFAULT_CONFIG.metricsEnabled, log),
  };

  log.info('config loaded', { path });
  return config;
}

function section(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function num(obj: Record<string, unknown>, key: string, fallback: number, log: Logger): number {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  log.warn('ignoring invalid config value', { key, value: v, using: fallback });
  return fallback;
}

function bool(obj: Record<string, unknown>, key: string, fallback: boolean, log: Logger): boolean {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  log.warn('ignoring invalid config value', { key, value: v, using: fallback });
  return fallback;
}

function hex(obj: Record<string, unknown>, key: string, fallback: string, log: Logger): string {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'string' && HEX.test(v)) return v;
  log.warn('ignoring invalid colour', { key, value: v, using: fallback });
  return fallback;
}
