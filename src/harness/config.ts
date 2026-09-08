/**
 * The `[harness]` section, resolved here rather than in src/config.ts so that
 * every harness-shaped decision -- key names, ring colours, defaults -- lives
 * in this directory and leaves with it.
 *
 * The validation helpers are borrowed from src/config.ts rather than
 * reimplemented, so a value here falls back exactly the way every other config
 * value does: absent is silent, present-but-wrong is logged, and neither ever
 * rejects the file.
 */

import { isHex, overlay, pick, section } from '../config-values.js';
import type { Logger } from '../log.js';

/** The ring states this layer owns. The dial's three live in UnderglowConfig. */
export const LAYER_RING_KEYS = ['active'] as const;

export type LayerRing = (typeof LAYER_RING_KEYS)[number];

export type HarnessConfig = {
  enabled: boolean;
  /**
   * Page keys per dial detent.
   *
   * It lived in `[controls]` while scrolling was a dial mode of its own.
   * Scrolling is a layer control now -- you page the agent you are working
   * with, in the mode where you are working with it -- so the setting moved
   * here with it.
   */
  scrollSteps: number;
  underglow: Record<LayerRing, string>;
};

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = Object.freeze<HarnessConfig>({
  enabled: true,
  scrollSteps: 1,
  underglow: {
    // `active` is the fallback for a harness with no colour of its own, and
    // the colour shown for the round trip before the harness is known. A
    // recognised harness overrides it -- Claude is orange, in claude.ts.
    // It is distinct from the three dial colours (green, blue, purple) at half
    // brightness on a diffused ring.
    active: '#8A6A4F',
  },
});

export function resolveHarnessConfig(obj: Record<string, unknown>, log: Logger): HarnessConfig {
  const defaults = DEFAULT_HARNESS_CONFIG;
  return {
    enabled: pick(obj, 'enabled', defaults.enabled, log, isBoolean),
    scrollSteps: pick(obj, 'scroll_steps', defaults.scrollSteps, log, isScrollSteps),
    underglow: overlay(section(obj, 'underglow'), defaults.underglow, LAYER_RING_KEYS, log, isHex),
  };
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** One dial detent sends this many page keys. Capped to keep a nudge sane. */
function isScrollSteps(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 12;
}
