import assert from 'node:assert/strict';
import { test } from 'vitest';

import { type Config, DEFAULT_CONFIG, DIAL_MODES, type UnderglowConfig } from '../config.js';
import type { SlotView } from '../state/store.js';
import { ambientLighting, renderSlotLighting, ringLighting } from './lighting.js';

function slot(index: number, status: SlotView['status']): SlotView {
  return {
    slot: index,
    paneId: `p${index}`,
    workspaceId: 'w1',
    label: `agent ${index}`,
    status,
  };
}

const DIAL = DEFAULT_CONFIG.underglow.dial;

function ringConfig(underglow: Partial<UnderglowConfig>): Config {
  return { ...DEFAULT_CONFIG, underglow: { ...DEFAULT_CONFIG.underglow, ...underglow } };
}

/** An unoccupied slot's thread: no colour, no light, no animation. */
const DARK_THREAD = { color: 0, brightness: 0, effect: 0, speed: 0 };

test('renderSlotLighting always fills six threads and darkens the empty ones', () => {
  const threads = renderSlotLighting([slot(0, 'working')], DEFAULT_CONFIG);

  assert.deepEqual(
    threads.map((thread) => thread.id),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(threads.slice(1), [
    { id: 1, ...DARK_THREAD },
    { id: 2, ...DARK_THREAD },
    { id: 3, ...DARK_THREAD },
    { id: 4, ...DARK_THREAD },
    { id: 5, ...DARK_THREAD },
  ]);
});

test('renderSlotLighting follows the configured palette rather than a fixed one', () => {
  const config = {
    ...DEFAULT_CONFIG,
    colors: { idle: '#010203', working: '#040506', done: '#070809', blocked: '#0a0b0c' },
  };

  const threads = renderSlotLighting(
    [slot(0, 'idle'), slot(1, 'working'), slot(2, 'done'), slot(3, 'blocked')],
    config,
  );

  assert.deepEqual(
    threads.slice(0, 4).map((thread) => thread.color),
    [0x010203, 0x040506, 0x070809, 0x0a0b0c],
  );
});

test('renderSlotLighting ignores slots past the six the pad has', () => {
  const view = Array.from({ length: 9 }, (_, index) => slot(index, 'done'));

  assert.equal(renderSlotLighting(view, DEFAULT_CONFIG).length, 6);
});

test('every dial mode lights the ring in its own colour', () => {
  const lit = { brightness: 0.5, effect: 1, speed: 0, magic: 0 };

  assert.deepEqual(ambientLighting(DEFAULT_CONFIG, 'workspaces'), { color: 0x95bf47, ...lit });
  assert.deepEqual(ambientLighting(DEFAULT_CONFIG, 'agents'), { color: 0x2c6ecb, ...lit });
  assert.deepEqual(ambientLighting(DEFAULT_CONFIG, 'harness'), { color: 0x8a6a4f, ...lit });

  // The parameter defaults to workspaces, so an absent argument lands there.
  assert.deepEqual(ambientLighting(DEFAULT_CONFIG), { color: 0x95bf47, ...lit });
});

test('the ring follows the configured mode colours and brightness', () => {
  const config = ringConfig({ brightness: 0.25, dial: { ...DIAL, agents: '#010203' } });

  assert.deepEqual(ambientLighting(config, 'agents'), {
    color: 0x010203,
    brightness: 0.25,
    effect: 1,
    speed: 0,
    magic: 0,
  });
});

test('a static colour holds every mode and gives up the indicator', () => {
  const config = ringConfig({ color: '#FF6600' });
  const expected = { color: 0xff6600, brightness: 0.5, effect: 1, speed: 0, magic: 0 };

  for (const mode of DIAL_MODES) assert.deepEqual(ambientLighting(config, mode), expected);
});

/** Black is off rather than a shade, so a mode can still be given no ring. */
test('a colour of black darkens the ring outright', () => {
  const config = ringConfig({ dial: { ...DIAL, workspaces: '#000000' } });

  assert.deepEqual(ambientLighting(config, 'workspaces'), {
    color: 0,
    brightness: 0,
    effect: 0,
    speed: 0,
    magic: 0,
  });
});

test('an off-dial colour is rendered at the same brightness the modes use', () => {
  const config = ringConfig({ brightness: 0.25 });

  assert.deepEqual(ringLighting(config, '#E07B39'), {
    color: 0xe07b39,
    brightness: 0.25,
    effect: 1,
    speed: 0,
    magic: 0,
  });
});

test('a static colour wins over an off-dial one too', () => {
  const config = ringConfig({ color: '#123456' });

  assert.equal(ringLighting(config, '#E07B39').color, 0x123456);
});
