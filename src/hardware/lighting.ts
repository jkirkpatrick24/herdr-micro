import type { Config, DialMode } from '../config.js';
import { SLOT_COUNT, type SlotView } from '../state/store.js';
import { type AmbientLighting, lightingForStatus, type ThreadLighting } from './protocol.js';

/**
 * The dial's mode, shown on the ambient ring. Workspace mode is the resting
 * mode, so its ring is off rather than a third colour to learn.
 */
const RINGS: Record<DialMode, AmbientLighting> = {
  workspaces: { color: 0, brightness: 0, effect: 0, speed: 0, magic: 0 },
  agents: { color: 0x2277ff, brightness: 0.5, effect: 1, speed: 0, magic: 0 },
  scroll: { color: 0xaa55ff, brightness: 0.5, effect: 1, speed: 0, magic: 0 },
};

export function renderSlotLighting(view: SlotView[], config: Config): ThreadLighting[] {
  return Array.from({ length: SLOT_COUNT }, (_, id) =>
    lightingForStatus(id, view[id]?.status ?? null, config.colors),
  );
}

export function ambientLighting(mode: DialMode = 'workspaces'): AmbientLighting {
  return RINGS[mode];
}
