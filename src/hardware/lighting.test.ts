import assert from 'node:assert/strict';
import { test } from 'vitest';

import { DEFAULT_CONFIG } from '../config.js';
import type { SlotView } from '../state/store.js';
import { ambientLighting, renderSlotLighting } from './lighting.js';

function slot(index: number, status: SlotView['status']): SlotView {
  return {
    slot: index,
    paneId: `p${index}`,
    workspaceId: 'w1',
    label: `agent ${index}`,
    status,
  };
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

test('the workspaces ring is fully dark', () => {
  const darkRing = { color: 0, brightness: 0, effect: 0, speed: 0, magic: 0 };
  assert.deepEqual(ambientLighting('workspaces'), darkRing);
  // The parameter defaults to this mode, so an absent argument lands here too.
  assert.deepEqual(ambientLighting(), darkRing);
});

test('the agent and scroll rings are lit in their own colours', () => {
  assert.deepEqual(ambientLighting('agents'), {
    color: 0x2277ff,
    brightness: 0.5,
    effect: 1,
    speed: 0,
    magic: 0,
  });
  assert.deepEqual(ambientLighting('scroll'), {
    color: 0xaa55ff,
    brightness: 0.5,
    effect: 1,
    speed: 0,
    magic: 0,
  });
});
