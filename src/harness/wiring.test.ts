import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';

import { type Config, DEFAULT_CONFIG, type DialMode } from '../config.js';
import { type PadControlSurface, wirePad } from '../daemon.js';
import { PadControls } from '../hardware/controls.js';
import { CreatorMicro } from '../hardware/device.js';
import { ambientLighting, ringLighting } from '../hardware/lighting.js';
import type { PadInput } from '../hardware/protocol.js';
import { HerdrClient } from '../herdr/client.js';
import { Store } from '../state/store.js';
import { startFakeHerdr } from '../testing/fake-herdr.js';
import { fakeHid, padDeviceInfo } from '../testing/fake-pad.js';
import { agent, silentLogger } from '../testing/fixtures.js';
import { HarnessLayer, type LayerClient } from './layer.js';
import { attachFocusEvents, attachHarnessLayer, harnessSurface } from './wiring.js';

const client: LayerClient = {
  agentList: async () => [],
  currentPaneId: async () => null,
  sendTextToPane: async () => {},
  sendKeysToPane: async () => {},
};

const surface = (
  handle: (input: PadInput, consumed?: boolean) => void = () => {},
  dialMode: DialMode = 'workspaces',
): PadControlSurface => ({ dialMode, handle });

function layerOn(rings: Array<string | null>): HarnessLayer {
  return new HarnessLayer(client, DEFAULT_CONFIG, silentLogger, (ring) => rings.push(ring));
}

test('the stick changes hands with the layer, and neither side replays a held push', async (t) => {
  const fake = await startFakeHerdr({ currentPane: 'w1:p1' });
  t.onTestFinished(() => fake.stop());
  const herdr = new HerdrClient(silentLogger, {
    socketPath: fake.path,
    ackTimeoutMs: 200,
    requestTimeoutMs: 400,
    refreshIntervalMs: 60_000,
  });
  t.onTestFinished(() => herdr.stop());
  await herdr.start();
  await fake.waitFor(() => fake.requests.some((request) => request.method === 'agent.list'));

  const layer = new HarnessLayer(herdr, DEFAULT_CONFIG, silentLogger, () => {});
  t.onTestFinished(() => layer.setLatched(false));
  const controls = new PadControls(
    herdr,
    new Store(silentLogger),
    { ...DEFAULT_CONFIG.controls, dialModeOrder: ['workspaces', 'harness'] },
    silentLogger,
    (mode) => layer.setLatched(mode === 'harness'),
  );
  const composed = harnessSurface(controls, layer);

  // Outside the layer the stick moves panes.
  composed.handle({ kind: 'joystick', angle: 0, distance: 0 });
  composed.handle({ kind: 'joystick', angle: 0, distance: 0.6 });
  await fake.waitFor(() =>
    fake.requests.some((request) => request.method === 'pane.focus_direction'),
  );

  // Clicking into harness mode hands it to the layer, still leaning right.
  composed.handle({ kind: 'dial', action: 'click' });
  composed.handle({ kind: 'joystick', angle: 0, distance: 0.6 });
  composed.handle({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await fake.waitFor(() => fake.requests.some((request) => request.method === 'pane.send_keys'));

  // And clicking back out hands it to navigation, still leaning down.
  composed.handle({ kind: 'dial', action: 'click' });
  composed.handle({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  composed.handle({ kind: 'joystick', angle: 0, distance: 0 });
  composed.handle({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await fake.waitFor(
    () => fake.requests.filter((request) => request.method === 'pane.focus_direction').length >= 2,
  );
  for (let i = 0; i < 8; i++) await delay(5);

  assert.deepEqual(
    fake.requests
      .filter((request) => request.method === 'pane.focus_direction')
      .map((request) => request.params),
    [{ direction: 'right' }, { direction: 'down' }],
    'the layer observes its positions silently, so handing the stick back cannot navigate',
  );
  assert.deepEqual(
    fake.requests
      .filter((request) => request.method === 'pane.send_keys')
      .map((request) => request.params),
    [{ pane_id: 'w1:p1', keys: ['down'] }],
    'taking the stick cannot replay the right push that navigation already handled',
  );
});

test('dialMode is read through, not snapshotted', () => {
  let mode: 'workspaces' | 'harness' = 'workspaces';
  const composed = harnessSurface(
    {
      get dialMode() {
        return mode;
      },
      handle: () => {},
    },
    layerOn([]),
  );

  assert.equal(composed.dialMode, 'workspaces');
  mode = 'harness';
  assert.equal(composed.dialMode, 'harness', 'a snapshot would still say workspaces');
});

test('the layer repaints its ring after the reconnect paint, not before', async () => {
  // Two colours that must not be confused: what the dial paints for `harness`
  // mode, and what the layer paints over it.
  const config: Config = {
    ...DEFAULT_CONFIG,
    underglow: {
      ...DEFAULT_CONFIG.underglow,
      dial: { ...DEFAULT_CONFIG.underglow.dial, harness: '#112233' },
    },
  };

  const hid = fakeHid([padDeviceInfo()]);
  const pad = new CreatorMicro(silentLogger, { hid: hid.backend, retryMs: 5 });

  // Every ambient write, in the order it was issued -- the only place the two
  // painters are visible together.
  const painted: number[] = [];
  const write = pad.setAmbientLighting.bind(pad);
  pad.setAmbientLighting = (ambient) => {
    painted.push(ambient.color);
    return write(ambient);
  };

  const layer = new HarnessLayer(
    {
      ...client,
      agentList: async () => [agent('w1:p1', 'w1', 'idle', 'claude', { focused: true })],
    },
    config,
    silentLogger,
    (ring) => {
      const lighting =
        ring === null ? ambientLighting(config, 'harness') : ringLighting(config, ring);
      void pad.setAmbientLighting(lighting).catch(() => {});
    },
  );

  wirePad(
    pad,
    surface(() => {}, 'harness'),
    new Store(silentLogger),
    config,
    silentLogger,
  );
  attachHarnessLayer(pad, layer);

  // Latched as a dial mode, so the layer survives the pad going away -- and
  // wirePad's `connected` handler paints the dial's colour knowing nothing
  // about that. Registering later is the only thing that puts the layer's ring
  // back on top rather than under it.
  layer.setLatched(true);
  painted.length = 0;

  pad.emit('connected');
  await delay(20);

  assert.deepEqual(
    painted,
    [0x112233, 0x8a6a4f, 0xff7a00],
    'the dial paints first, then the layer, then the harness it resolved',
  );
  pad.stop();
});

test('a disconnect abandons a control press, since the pad it typed at has gone', async () => {
  const hid = fakeHid([padDeviceInfo()]);
  const pad = new CreatorMicro(silentLogger, { hid: hid.backend, retryMs: 5 });
  const sent: string[][] = [];
  const rings: Array<string | null> = [];
  const layer = new HarnessLayer(
    {
      ...client,
      agentList: async () => {
        await delay(30);
        return [agent('w1:p1', 'w1', 'idle', 'claude', { focused: true })];
      },
      currentPaneId: async () => 'w1:p1',
      sendKeysToPane: async (_paneId, keys) => void sent.push(keys),
    },
    DEFAULT_CONFIG,
    silentLogger,
    (ring) => rings.push(ring),
  );

  attachHarnessLayer(pad, layer);
  layer.setLatched(true);
  layer.intercept({ kind: 'key', key: 'ACT08', pressed: true });

  // Unplugged before the round trip lands. The dial mode survives the pad, so
  // the layer stays open -- but the press must not, or it opens a picker over a
  // list nobody put on screen.
  pad.emit('disconnected', 'unplugged');
  await delay(60);

  assert.deepEqual(sent, [], 'nothing is typed at a pad that has gone');
  assert.notEqual(rings.at(-1), null, 'the dial still says harness, so the layer stays open');
  pad.stop();
});

test('the layer re-reads when herdr says the focus moved, not when the pad asks', async () => {
  let lists = 0;
  const listeners: Array<() => void> = [];
  const layer = new HarnessLayer(
    {
      ...client,
      agentList: async () => {
        lists++;
        return [agent('w1:p1', 'w1', 'idle', 'claude', { focused: true })];
      },
    },
    DEFAULT_CONFIG,
    silentLogger,
    () => {},
  );

  attachFocusEvents(
    {
      on: (event, listener) => {
        assert.equal(event, 'focus', 'nothing else is subscribed');
        listeners.push(listener as () => void);
        return undefined;
      },
    },
    layer,
  );
  layer.setLatched(true);
  await delay(10);
  assert.equal(lists, 1, 'opening the layer');

  for (const listener of listeners) listener();
  await delay(10);
  assert.equal(lists, 2, 'and the event is what re-reads');
});
