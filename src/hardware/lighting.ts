import type { Config, DialMode } from '../config.js';
import { SLOT_COUNT, type SlotView } from '../state/store.js';
import {
  type AmbientLighting,
  colorToNumber,
  lightingForStatus,
  type ThreadLighting,
} from './protocol.js';

/** The ring is unlit rather than black: a colour of 0 is "off", not a shade. */
const RING_OFF: AmbientLighting = { color: 0, brightness: 0, effect: 0, speed: 0, magic: 0 };

export function renderSlotLighting(view: SlotView[], config: Config): ThreadLighting[] {
  return Array.from({ length: SLOT_COUNT }, (_, id) =>
    lightingForStatus(id, view[id]?.status ?? null, config.colors),
  );
}

/**
 * The ambient ring. It indicates the dial's mode, so that turning the dial is
 * readable before it is turned -- unless a static `color` is configured, which
 * holds one colour and gives the indicator up.
 */
export function ambientLighting(config: Config, mode: DialMode = 'workspaces'): AmbientLighting {
  const { color, brightness, dial } = config.underglow;
  const value = colorToNumber(color ?? dial[mode]);

  if (value === 0) return RING_OFF;
  return { color: value, brightness, effect: 1, speed: 0, magic: 0 };
}
