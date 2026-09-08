import assert from 'node:assert/strict';
import { test } from 'vitest';

import { type Config, DEFAULT_CONFIG } from '../config.js';
import type { PadInput } from '../hardware/protocol.js';
import type { AgentInfo, AgentStatus } from '../herdr/rpc.js';
import type { Logger } from '../log.js';
import { agent, silentLogger } from '../testing/fixtures.js';
import { claude } from './claude.js';
import { HarnessLayer, type LayerClient, type RingState } from './layer.js';

const MODEL = 'ACT08';
const ESCAPE = 'ACT07'; // DEFAULT_CONFIG binds this to the `escape` action.
const ENTER = 'ACT12'; // DEFAULT_CONFIG binds this to the `enter` action.

/** One send, flattened so assertions read as the wire order. */
type Sent = { text: string } | { keys: string[] };
const MODEL_OPEN: Sent[] = [{ text: '/model' }, { keys: ['enter'] }];

/**
 * Let the layer finish everything it has already started.
 *
 * It schedules no timers of its own, so one turn of the event loop drains every
 * promise chain that is not parked on a `gate` below. That makes every wait in
 * this file exact rather than a bet on how fast the machine is.
 */
const settle = (): Promise<void> => new Promise((resolve) => void setImmediate(resolve));

/** A round trip the test holds open, in place of a sleep long enough to hope. */
function gate(): Gate {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    held,
    open: async () => {
      release();
      await settle();
    },
  };
}

type Gate = { held: Promise<void>; open: () => Promise<void> };

type Harnessed = {
  layer: HarnessLayer;
  sent: Sent[];
  rings: RingState[];
  open(): Promise<void>;
  press(key: string): boolean;
};

function config(overrides: Partial<Config['harness']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    harness: { ...DEFAULT_CONFIG.harness, ...overrides },
  };
}

function harnessed(
  agents: AgentInfo[],
  opts: {
    config?: Config;
    /** Holds `agent.list` open until the test releases it. */
    listGate?: Gate;
    listFails?: boolean;
    client?: Partial<LayerClient>;
  } = {},
): Harnessed {
  const sent: Sent[] = [];
  const rings: RingState[] = [];

  const client: LayerClient = {
    agentList: async () => {
      // Snapshotted before the wait, not after: a round trip answers the
      // question as it was when it was asked. Returning the live array made
      // every in-flight resolution see the newest agents, which quietly made
      // the staleness tests below assert nothing.
      const answer = [...agents];
      if (opts.listGate) await opts.listGate.held;
      if (opts.listFails) throw new Error('herdr said no');
      return answer;
    },
    currentPaneId: async () => agents.find((candidate) => candidate.focused)?.pane_id ?? null,
    sendTextToPane: async (_paneId, text) => void sent.push({ text }),
    sendKeysToPane: async (_paneId, keys) => void sent.push({ keys }),
    ...opts.client,
  };

  const layer = new HarnessLayer(client, opts.config ?? config(), silentLogger, (ring) =>
    rings.push(ring),
  );
  layer.intercept({ kind: 'joystick', angle: 0, distance: 0 });

  return {
    layer,
    sent,
    rings,
    /** Latch the layer via the dial, and let harness resolution land. */
    async open() {
      layer.setLatched(true);
      await settle();
    },
    press: (key) => layer.intercept({ kind: 'key', key, pressed: true }),
  };
}

const claudeAgent = (status: AgentStatus = 'idle') =>
  agent('w1:p1', 'w1', status, 'claude', { focused: true });

const AGENT_KEY: PadInput = { kind: 'key', key: 'AG00', pressed: true };

const EVERY_INPUT: PadInput[] = [
  AGENT_KEY,
  { kind: 'key', key: MODEL, pressed: true },
  { kind: 'key', key: MODEL, pressed: false },
  { kind: 'dial', action: 'clockwise' },
  { kind: 'dial', action: 'counterclockwise' },
  { kind: 'dial', action: 'click' },
  { kind: 'joystick', angle: 0, distance: 0.5 },
];

// ---------------------------------------------------------------------------
// The default. A layer that claimed too much would swallow the whole pad.
// ---------------------------------------------------------------------------

test('an inactive layer passes every kind of input through untouched', () => {
  const { layer, sent } = harnessed([claudeAgent()]);

  for (const input of EVERY_INPUT) {
    assert.equal(layer.intercept(input), false, `${input.kind} must reach PadControls`);
  }
  assert.deepEqual(sent, []);
});

test('a disabled layer is not built into the input path at all', () => {
  const { layer } = harnessed([claudeAgent()], { config: config({ enabled: false }) });

  layer.setLatched(true);
  for (const input of EVERY_INPUT) assert.equal(layer.intercept(input), false);
});

// ---------------------------------------------------------------------------
// Opening the layer. The dial is the only way in.
// ---------------------------------------------------------------------------

test('the dial opens the layer and hands the ring back when it leaves', async () => {
  const { layer, rings, open } = harnessed([claudeAgent()]);

  await open();
  // Painted twice: once immediately, then again once the harness is known.
  assert.deepEqual(rings, [DEFAULT_CONFIG.harness.underglow.active, '#FF7A00']);

  layer.setLatched(false);
  assert.equal(rings.at(-1), null, 'leaving must return the ring to the dial mode');
});

test('the agent keys keep focusing while the layer is held', async () => {
  const { layer, open } = harnessed([claudeAgent()]);
  await open();

  // They are how you change which agent is focused, and the layer acts on the
  // focused agent -- swallowing them would make it impossible to re-aim without
  // letting go first.
  for (let slot = 0; slot < 6; slot++) {
    const key = `AG0${slot}`;
    assert.equal(layer.intercept({ kind: 'key', key, pressed: true }), false, key);
  }
});

test('the ring follows the focus onto whatever herdr says is there now', async () => {
  const agents = [claudeAgent()];
  const { layer, rings, open } = harnessed(agents);
  await open();
  assert.equal(rings.at(-1), '#FF7A00', 'claude to begin with');

  // PadControls does the focusing, on its own connection with nothing to await.
  // herdr says when it happened, and only then is there anything to re-read.
  agents[0] = agent('w1:p1', 'w1', 'idle', 'omp', { focused: true });
  layer.intercept({ kind: 'key', key: 'AG00', pressed: true });
  layer.focusMoved();

  await settle();
  assert.equal(
    rings.at(-1),
    DEFAULT_CONFIG.harness.underglow.active,
    'the ring must land on the harness the layer would now act against',
  );
});

test('pad input costs no read; only herdr saying the focus moved does', async () => {
  let lists = 0;
  const layer = new HarnessLayer(
    {
      agentList: async () => {
        lists++;
        return [claudeAgent()];
      },
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async () => {},
      sendKeysToPane: async () => {},
    },
    config(),
    silentLogger,
    () => {},
  );

  layer.setLatched(true);
  await settle();
  assert.equal(lists, 1, 'opening the layer');

  // Asking for a focus change is not a focus change. The layer used to guess,
  // on a timer started here, that one had landed; now it waits to be told.
  layer.intercept({ kind: 'key', key: 'AG00', pressed: true });
  layer.intercept({ kind: 'key', key: 'AG00', pressed: false });
  await settle();
  assert.equal(lists, 1, 'nothing has moved yet');

  layer.focusMoved();
  await settle();
  assert.equal(lists, 2, 'and one move is one re-read');
});

test('an agent key release does not abandon a picker opened while it was down', async () => {
  const h = harnessed([claudeAgent()]);
  await h.open();
  h.layer.intercept({ kind: 'key', key: 'AG00', pressed: true });
  h.press(MODEL);
  await settle();

  // The release belongs to a press that happened before the picker existed.
  h.layer.intercept({ kind: 'key', key: 'AG00', pressed: false });
  assert.equal(h.rings.at(-1), '#FF7A00', 'the picker must survive it');
  assert.equal(
    h.layer.intercept({ kind: 'key', key: 'AG00', pressed: false }),
    false,
    'and it reaches PadControls, like the press it belongs to',
  );
});

test('an agent key abandons an open picker instead of steering it', async () => {
  const { layer, sent, rings } = await picking();

  // Re-aiming ends ownership of the old picker without dismissing its screen.
  assert.equal(layer.intercept(AGENT_KEY), false, 'the focus itself still happens');
  await settle();

  assert.deepEqual(sent, [], 'nothing is sent to dismiss the list');
  assert.equal(rings.at(-1), '#FF7A00');

  layer.intercept({ kind: 'dial', action: 'clockwise' });
  await settle();
  assert.deepEqual(
    sent,
    [{ text: '\x1b[5~' }],
    'and the dial pages the pane it landed on rather than steering the abandoned list',
  );
});

test('a focus moved by a route the pad never saw abandons the picker too', async () => {
  const { layer, sent, rings } = await picking();

  // The keyboard, or another herdr client. No pad input to be pre-emptive on,
  // so herdr saying so is the only notice the layer gets.
  layer.focusMoved();
  await settle();

  assert.deepEqual(sent, [], 'nothing is sent to dismiss the list');
  assert.equal(
    rings.at(-1),
    '#FF7A00',
    'the pad must not go on capturing keys, red, against a list it can no longer steer',
  );
  assert.equal(
    layer.intercept({ kind: 'key', key: ESCAPE, pressed: true }),
    false,
    'and Esc reaches the navigation layer again, as everywhere else in the layer',
  );
});

test('a send still queued when the focus moves is dropped, not redirected', async () => {
  const order: string[] = [];
  const opener = gate();
  const layer = new HarnessLayer(
    {
      agentList: async () => [claudeAgent()],
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async (_paneId, text) => {
        if (text === '/model') await opener.held;
        order.push(text);
      },
      sendKeysToPane: async (_paneId, keys) => void order.push(keys.join('+')),
    },
    config(),
    silentLogger,
    () => {},
  );

  layer.setLatched(true);
  await settle();
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  await settle();
  layer.intercept({ kind: 'dial', action: 'clockwise' });
  // The focus moves while the opener is still on the wire and `up` is behind it.
  layer.intercept({ kind: 'key', key: 'AG00', pressed: true });

  await opener.open();
  // The opener already in flight cannot be recalled; pending arrows can.
  assert.deepEqual(order, ['/model', 'enter'], 'the arrow key must be dropped');
});

test('an agent key abandons a control resolution from the focus it leaves', async () => {
  const agents = [claudeAgent()];
  const list = gate();
  const { layer, sent, rings, press } = harnessed(agents, { listGate: list });
  layer.setLatched(true);
  await list.open();

  press(MODEL);
  assert.equal(layer.intercept(AGENT_KEY), false);
  agents[0] = agent('w1:p2', 'w1', 'idle', 'claude', { focused: true });
  await settle();

  assert.deepEqual(sent, [], 'the old lookup must not open a picker in either pane');
  assert.equal(rings.at(-1), '#FF7A00');
  press(MODEL);
  await settle();
  assert.deepEqual(sent, MODEL_OPEN, 'a fresh press still works in the same visit');
  assert.equal(rings.at(-1), '#FF7A00');
});

test('navigation after a control press still abandons that press', async () => {
  const list = gate();
  const { layer, sent, rings, press } = harnessed([claudeAgent()], { listGate: list });
  layer.setLatched(true);
  press(MODEL);
  assert.equal(layer.intercept(AGENT_KEY), false);
  await list.open();

  assert.deepEqual(sent, [], 'the press no longer belongs to the selected pane');
  assert.equal(rings.at(-1), '#FF7A00', 'navigation must not resurrect its picker');
});

test('a picker keeps its resolved pane through delayed opening, steering and commit', async () => {
  const agents = [claudeAgent()];
  const opener = gate();
  const delivered: Array<{ paneId: string } & Sent> = [];
  const { layer, open, press } = harnessed(agents, {
    client: {
      sendTextToPane: async (paneId, text) => {
        if (text === '/model') await opener.held;
        delivered.push({ paneId, text });
      },
      sendKeysToPane: async (paneId, keys) => void delivered.push({ paneId, keys }),
    },
  });
  await open();
  press(MODEL);
  await settle();
  // Focus can also change outside the pad. It must not redirect a latched picker.
  agents[0] = agent('w1:p2', 'w1', 'idle', 'claude', { focused: true });
  layer.intercept({ kind: 'dial', action: 'counterclockwise' });
  layer.intercept({ kind: 'dial', action: 'click' });
  await opener.open();

  assert.deepEqual(delivered, [
    { paneId: 'w1:p1', text: '/model' },
    { paneId: 'w1:p1', keys: ['enter'] },
    { paneId: 'w1:p1', keys: ['down'] },
    { paneId: 'w1:p1', keys: ['enter'] },
  ]);
});

test('a text effect already sending stays pinned to the pane it was aimed at', async () => {
  const controls = claude.controls;
  claude.controls = [
    {
      id: 'typed-text',
      label: 'typed text',
      key: MODEL,
      when: ['idle'],
      effect: { via: 'text', text: 'test command' },
    },
  ];
  try {
    const agents = [claudeAgent()];
    const send = gate();
    const delivered: Array<{ paneId: string } & Sent> = [];
    const { layer, open, press } = harnessed(agents, {
      client: {
        sendTextToPane: async (paneId, text) => {
          await send.held;
          delivered.push({ paneId, text });
        },
      },
    });
    await open();
    press(MODEL);
    await settle();
    layer.intercept(AGENT_KEY);
    agents[0] = agent('w1:p2', 'w1', 'idle', 'claude', { focused: true });
    await send.open();

    assert.deepEqual(delivered, [{ paneId: 'w1:p1', text: 'test command' }]);
  } finally {
    claude.controls = controls;
  }
});

test('a held arrow discards a current-pane lookup overtaken by navigation', async () => {
  const sent: Array<{ paneId: string; keys: string[] }> = [];
  const lookup = gate();
  const { layer, open } = harnessed([], {
    client: {
      currentPaneId: async () => {
        await lookup.held;
        return 'w1:p1';
      },
      sendKeysToPane: async (paneId, keys) => void sent.push({ paneId, keys }),
    },
  });
  await open();
  layer.intercept({ kind: 'joystick', angle: 0, distance: 0.6 });
  await settle();
  layer.intercept(AGENT_KEY);
  await lookup.open();
  assert.deepEqual(sent, [], 'an old pane answer is not permission to send');

  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await settle();
  assert.deepEqual(
    sent,
    [{ paneId: 'w1:p1', keys: ['down'] }],
    'unbound arrows still resolve a pane',
  );
});

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

test('the model control opens and latches the picker', async () => {
  const { sent, rings, open, press } = harnessed([claudeAgent()]);
  await open();

  assert.equal(press(MODEL), true);
  await settle();

  assert.deepEqual(sent, MODEL_OPEN);
  assert.equal(rings.at(-1), '#FF7A00');
});

test('a control declines in a status where typing would only queue characters', async () => {
  for (const status of ['working', 'blocked'] as const) {
    const { sent, open, press } = harnessed([claudeAgent(status)]);
    await open();

    assert.equal(press(MODEL), true, 'the key is still consumed, it just does nothing');
    await settle();
    assert.deepEqual(sent, [], `${status} must not be typed at`);
  }
});

test('an unrecognised harness, and no focused agent, both leave the layer inert', async () => {
  const cases: AgentInfo[][] = [
    [agent('w1:p1', 'w1', 'idle', 'omp', { focused: true })],
    [agent('w1:p1', 'w1', 'idle', 'claude')], // focused absent entirely
    [],
  ];

  for (const agents of cases) {
    const { sent, open, press } = harnessed(agents);
    await open();
    press(MODEL);
    await settle();
    assert.deepEqual(sent, []);
  }
});

test('a control pressed before the ring settles still fires, against a fresh read', async () => {
  const list = gate();
  const { layer, sent } = harnessed([claudeAgent()], { listGate: list });

  layer.setLatched(true);
  assert.equal(layer.intercept({ kind: 'key', key: MODEL, pressed: true }), true);

  await list.open();
  // What a key does is decided at press time from its own lookup, so a press
  // that beats the ring is not a press against an unknown harness.
  assert.deepEqual(sent, MODEL_OPEN);
});

test('the status gate re-reads, so sitting through idle -> working still declines', async () => {
  const agents = [claudeAgent('idle')];
  const { layer, sent } = harnessed(agents);

  layer.setLatched(true);
  await settle();

  // A mode is sat in for as long as the user likes; the agent can start
  // working while they are in it.
  agents[0] = claudeAgent('working');
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  await settle();

  assert.deepEqual(sent, [], 'the open-time snapshot must not authorise this');
});

test('a press from an abandoned visit does not fire inside the next one', async () => {
  const list = gate();
  const { layer, sent } = harnessed([claudeAgent()], { listGate: list });

  layer.setLatched(true);
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  layer.setLatched(false);
  // The mode is latched again before the first press's round trip lands. Being
  // active again is not consent: the command would be typed at whatever is
  // focused now, which is the whole reason they left and came back.
  layer.setLatched(true);

  await list.open();
  assert.deepEqual(sent, [], 'the abandoned visit must not fire into this one');
});

test('a key no harness binds is swallowed without a round trip', async () => {
  let lists = 0;
  const layer = new HarnessLayer(
    {
      agentList: async () => {
        lists++;
        return [claudeAgent()];
      },
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async () => {},
      sendKeysToPane: async () => {},
    },
    config(),
    silentLogger,
    () => {},
  );

  layer.setLatched(true);
  await settle();

  // Which harness is focused takes a socket round trip to learn, but "no
  // harness binds ACT06 at all" does not, so it is answered locally and the
  // key keeps its popup meaning rather than costing a connection per press.
  for (let i = 0; i < 5; i++) {
    assert.equal(layer.intercept({ kind: 'key', key: 'ACT06', pressed: true }), false);
  }
  await settle();

  assert.equal(lists, 1, 'still just the open');
});

test('a stale resolution from a previous visit does not repaint the current one', async () => {
  const agents = [claudeAgent()];
  const list = gate();
  const { layer, rings } = harnessed(agents, { listGate: list });

  // Clicked out and back in while the first round trip is still in flight, so
  // the layer is legitimately active again when the stale answer lands. Only
  // the generation token can tell them apart -- `state.kind` cannot.
  layer.setLatched(true);
  layer.setLatched(false);
  agents[0] = agent('w1:p1', 'w1', 'idle', 'omp', { focused: true });
  layer.setLatched(true);

  await list.open();
  assert.equal(
    rings.at(-1),
    DEFAULT_CONFIG.harness.underglow.active,
    "claude's ring from the abandoned visit must not win over the omp one",
  );
  assert.ok(
    !rings.includes('#FF7A00'),
    'and must never be painted at all -- landing first and being overwritten ' +
      'is a flicker, not a pass',
  );
});

test('sends are ordered, so a dial turn cannot overtake the command that opened the picker', async () => {
  const order: string[] = [];
  const opener = gate();
  const layer = new HarnessLayer(
    {
      agentList: async () => [claudeAgent()],
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async (_paneId, text) => {
        if (text === '/model') await opener.held;
        order.push(text);
      },
      // The opener is held; an unqueued arrow would land in front of it.
      sendKeysToPane: async (_paneId, keys) => void order.push(keys.join('+')),
    },
    config(),
    silentLogger,
    () => {},
  );

  layer.setLatched(true);
  await settle();
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  await settle();
  layer.intercept({ kind: 'dial', action: 'counterclockwise' });

  await opener.open();
  assert.deepEqual(order, ['/model', 'enter', 'down'], 'an arrow key must not land first');
});

test('a failed agent.list leaves the layer open but inert', async () => {
  const { sent, open, press } = harnessed([claudeAgent()], { listFails: true });
  await open();

  press(MODEL);
  await settle();
  assert.deepEqual(sent, []);
});

// ---------------------------------------------------------------------------
// Inside the picker
// ---------------------------------------------------------------------------

/** Lift the keycap, so the next picker exit closes the layer rather than
 *  returning to the held state. */
async function picking(): Promise<Harnessed> {
  const h = harnessed([claudeAgent()]);
  await h.open();
  h.press(MODEL);
  await settle();
  h.sent.length = 0;
  return h;
}

test('the dial drives the picker, clockwise stepping backwards as it does elsewhere', async () => {
  const { layer, sent } = await picking();

  layer.intercept({ kind: 'dial', action: 'clockwise' });
  layer.intercept({ kind: 'dial', action: 'counterclockwise' });
  await settle();

  assert.deepEqual(sent, [{ keys: ['up'] }, { keys: ['down'] }]);
});

test('the stick is the arrow keys while a picker is open', async () => {
  const { layer, sent } = await picking();

  // A quarter turn per sector, clockwise from 0 = right. The dial has one axis
  // and the picker reads two, so the stick is how the other one is reachable.
  for (const angle of [0, 0.25, 0.5, 0.75]) {
    layer.intercept({ kind: 'joystick', angle, distance: 0.5 });
  }
  await settle();

  assert.deepEqual(sent, [
    { keys: ['right'] },
    { keys: ['down'] },
    { keys: ['left'] },
    { keys: ['up'] },
  ]);
});

test('a held stick is one arrow, not one per report', async () => {
  const { layer, sent } = await picking();

  // The pad streams position continuously; a list wants key presses.
  for (let i = 0; i < 5; i++) {
    layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  }
  await settle();
  assert.deepEqual(sent, [{ keys: ['down'] }], 'holding it down moves one row');

  // Back to centre and pushed again, which is a second press.
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0 });
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await settle();
  assert.deepEqual(sent, [{ keys: ['down'] }, { keys: ['down'] }]);
});

test('a nudge short of the dead zone moves nothing', async () => {
  const { layer, sent } = await picking();

  layer.intercept({ kind: 'joystick', angle: 0.5, distance: 0.2 });
  await settle();

  assert.deepEqual(sent, [], 'engaging takes a deliberate push');
});

test('the stick still drives once the list is gone but the layer is not', async () => {
  const h = await picking();

  h.layer.intercept({ kind: 'dial', action: 'click' }); // commits; picker state ends
  await settle();
  h.sent.length = 0;

  // Whatever committing put on screen, the cap is still down. This is the case
  // that was a dead pad: every key swallowed, with a dialog waiting on one.
  h.layer.intercept({ kind: 'joystick', angle: 0.5, distance: 0.6 });
  await settle();

  assert.deepEqual(h.sent, [{ keys: ['left'] }]);
});

test('Enter commits from inside the layer, behind whatever the stick just chose', async () => {
  const { layer, sent, open, press } = harnessed([claudeAgent()]);
  await open();

  // The arrow chooses the row and Enter takes it, so the two must not race:
  // both go out on the layer's own chain, in finger order.
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  assert.equal(press(ENTER), true, 'a held layer used to swallow this into nothing');
  await settle();

  assert.deepEqual(sent, [{ keys: ['down'] }, { keys: ['enter'] }]);
});

test('Enter still commits once the list is gone but the layer is not', async () => {
  const h = await picking();

  h.layer.intercept({ kind: 'dial', action: 'click' }); // commits; picker state ends
  await settle();
  h.sent.length = 0;

  // A commit can put a confirmation up, and the pad has left picker state by
  // the time it appears -- so Enter cannot depend on being in that state.
  assert.equal(h.layer.intercept({ kind: 'key', key: ENTER, pressed: true }), true);
  await settle();

  assert.deepEqual(h.sent, [{ keys: ['enter'] }]);
});

test('the stick retains its position across a picker commit', async () => {
  const h = await picking();

  h.layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await settle();
  h.sent.length = 0;

  // The same push, still held, across a commit. One finger, one press: resting
  // the stick per picker would have counted it twice.
  h.layer.intercept({ kind: 'dial', action: 'click' });
  h.layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await settle();

  assert.deepEqual(h.sent, [{ keys: ['enter'] }], 'the push it is still holding is not new');
});

test('a stick already deflected when the layer opens is not a new push', async () => {
  const { layer, sent, open } = harnessed([claudeAgent()]);
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await open();
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await settle();
  assert.deepEqual(sent, [], 'the stick was already down when the layer opened');

  layer.intercept({ kind: 'joystick', angle: 0, distance: 0 });
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await settle();
  assert.deepEqual(sent, [{ keys: ['down'] }], 'the first push after known neutral is intentional');

  // Handing the stick back and taking it again is not a new push either.
  layer.setLatched(false);
  layer.intercept({ kind: 'joystick', angle: 0.5, distance: 0.6 });
  await open();
  layer.intercept({ kind: 'joystick', angle: 0.5, distance: 0.6 });
  await settle();
  assert.deepEqual(
    sent,
    [{ keys: ['down'] }],
    'position changes while navigation owns it are observed',
  );
});

test('a stick already leaning is not a fresh push when the picker reopens', async () => {
  const { layer, sent, press } = harnessed([claudeAgent()]);
  layer.setLatched(true);
  layer.intercept({ kind: 'joystick', angle: 0, distance: 0.6 });
  press(MODEL);
  await settle();
  sent.length = 0;

  layer.intercept({ kind: 'joystick', angle: 0, distance: 0.6 });
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  layer.intercept({ kind: 'dial', action: 'click' });
  await settle();
  assert.deepEqual(sent, [{ keys: ['down'] }, { keys: ['enter'] }]);

  // The commit left picker state, but not the layer, so the stick is still ours.
  assert.equal(layer.intercept({ kind: 'joystick', angle: 0.5, distance: 0.6 }), true);
  press(MODEL);
  await settle();
  sent.length = 0;
  layer.intercept({ kind: 'joystick', angle: 0.5, distance: 0.6 });
  await settle();
  assert.deepEqual(sent, [], 'reopening the picker does not invent another push');
});

test('reconnect waits for an observed stick transition instead of replaying a held direction', async () => {
  const { layer, sent, open } = harnessed([claudeAgent()]);
  layer.reset();
  await open();
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await settle();
  assert.deepEqual(sent, [], 'unknown deflection could predate reconnect');

  layer.intercept({ kind: 'joystick', angle: 0, distance: 0 });
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  await settle();
  assert.deepEqual(sent, [{ keys: ['down'] }]);
});

test('the dial pages the focused pane, one step per configured page key', async () => {
  const cfg = config({ scrollSteps: 3 });
  const { layer, sent, open } = harnessed([claudeAgent()], { config: cfg });
  await open();

  assert.equal(layer.intercept({ kind: 'dial', action: 'counterclockwise' }), true);
  assert.equal(layer.intercept({ kind: 'dial', action: 'clockwise' }), true);
  await settle();

  // send_text rather than send_keys, and the literal escape sequences rather
  // than a key name: herdr has no page key to ask for. Asserted as bytes
  // because that is the whole content of it -- a name here would be checked by
  // nothing, which is how `pageup` survived once before.
  assert.deepEqual(sent, [{ text: '\x1b[6~\x1b[6~\x1b[6~' }, { text: '\x1b[5~\x1b[5~\x1b[5~' }]);
});

test('a dial click still leaves harness mode rather than scrolling', async () => {
  const { layer, sent, open } = harnessed([claudeAgent()]);
  await open();

  assert.equal(layer.intercept({ kind: 'dial', action: 'click' }), false, 'PadControls cycles it');
  await settle();
  assert.deepEqual(sent, []);
});

test('a page cannot overtake the arrow in front of it', async () => {
  const order: string[] = [];
  const arrow = gate();
  const { layer, open } = harnessed([claudeAgent()], {
    client: {
      sendKeysToPane: async (_paneId, keys) => {
        await arrow.held;
        order.push(keys.join('+'));
      },
      sendTextToPane: async () => void order.push('page'),
    },
  });
  await open();

  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  layer.intercept({ kind: 'dial', action: 'counterclockwise' });
  await arrow.open();

  assert.deepEqual(order, ['down', 'page'], 'both go out on the one chain, in finger order');
});

test('the latched layer takes the stick as arrow keys', async () => {
  const { layer, sent } = harnessed([claudeAgent()]);
  layer.setLatched(true);
  await settle();

  // Inside the layer the stick is the agent's arrow keys, not pane focus.
  assert.equal(layer.intercept({ kind: 'joystick', angle: 0, distance: 0.6 }), true);
  await settle();
  assert.deepEqual(sent, [{ keys: ['right'] }]);
});

test('a dial click commits and returns to the layer', async () => {
  const { layer, sent, rings } = await picking();

  assert.equal(layer.intercept({ kind: 'dial', action: 'click' }), true);
  await settle();

  assert.deepEqual(sent, [{ keys: ['enter'] }]);
  assert.equal(rings.at(-1), '#FF7A00', 'back to the layer, which the dial is still sitting on');
});

test('the escape binding cancels the picker on both the pad and the screen', async () => {
  const { layer, sent, rings } = await picking();

  layer.intercept({ kind: 'key', key: ESCAPE, pressed: true });
  await settle();

  assert.deepEqual(sent, [{ keys: ['esc'] }]);
  assert.equal(rings.at(-1), '#FF7A00', 'back to the layer, which the dial is still sitting on');
});

test('the enter binding commits the picker, as the dial click does', async () => {
  const { layer, sent, rings } = await picking();

  layer.intercept({ kind: 'key', key: ENTER, pressed: true });
  await settle();

  assert.deepEqual(sent, [{ keys: ['enter'] }]);
  assert.equal(rings.at(-1), '#FF7A00', 'back to the layer, which the dial is still sitting on');
});

test('every other key is swallowed while the picker is open', async () => {
  const { layer, sent, rings } = await picking();

  for (const input of EVERY_INPUT.filter((i) => i.kind === 'key' && !/^AG0[0-5]$/.test(i.key))) {
    assert.equal(layer.intercept(input), true, 'a leaked key would desync pad and screen');
  }
  await settle();

  assert.deepEqual(sent, []);
  assert.equal(rings.at(-1), '#FF7A00', 'still in the picker');
});

test('a picker is held until the user ends it, however long that takes', async () => {
  const { layer, sent, rings } = await picking();

  // Nothing has been pressed, and nothing the layer has scheduled can end a
  // picker: only an input does. A list being read is not an abandoned one, and
  // expiring underneath it would hand the dial back to workspace navigation
  // while the models are still on screen.
  await settle();

  assert.deepEqual(sent, [], 'nothing is sent at a list nobody dismissed');
  assert.equal(rings.at(-1), '#FF7A00', 'still driving it');
  assert.equal(layer.intercept({ kind: 'dial', action: 'click' }), true, 'and still owns the pad');
});

// ---------------------------------------------------------------------------
// The dial mode itself: latching in, latching out, and surviving the pad.
// ---------------------------------------------------------------------------

test('latching the dial mode opens the layer with no key held', async () => {
  const { layer, rings } = harnessed([claudeAgent()]);

  layer.setLatched(true);
  await settle();

  assert.equal(rings.at(-1), '#FF7A00', 'the ring resolves against the focused harness');
  assert.equal(layer.intercept({ kind: 'key', key: MODEL, pressed: true }), true);
});

test('unlatching closes it, and re-latching is not a second open', async () => {
  const { layer, rings } = harnessed([claudeAgent()]);

  layer.setLatched(true);
  await settle();
  const opens = rings.length;

  // Idempotent: PadControls reports its mode on every click, including clicks
  // that land back where they were.
  layer.setLatched(true);
  assert.equal(rings.length, opens, 'no repaint for a mode that did not change');

  layer.setLatched(false);
  assert.equal(rings.at(-1), null);
  assert.equal(layer.intercept({ kind: 'key', key: MODEL, pressed: true }), false);
});

test('a latched picker returns to the layer rather than closing it', async () => {
  const { layer, rings } = harnessed([claudeAgent()]);
  layer.setLatched(true);
  await settle();

  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  await settle();
  assert.equal(rings.at(-1), '#FF7A00');

  layer.intercept({ kind: 'dial', action: 'click' });
  await settle();
  assert.notEqual(rings.at(-1), null, 'committing does not leave harness mode');
  assert.equal(layer.intercept({ kind: 'key', key: MODEL, pressed: true }), true);
});

test('latched tab navigation discards stale controls and re-aims the ring', async () => {
  const cfg = config();
  cfg.controls = {
    ...cfg.controls,
    buttons: { ...cfg.controls.buttons, ACT06: 'tab-prev' },
  };
  // The stick is not in this list: inside the layer it types arrows rather than
  // moving the focus, so it has nothing to re-aim.
  const navigation: PadInput[] = [
    { kind: 'key', key: 'ACT06', pressed: true },
    { kind: 'key', key: 'ACT09', pressed: true },
  ];
  for (const input of navigation) {
    const agents = [claudeAgent()];
    const list = gate();
    const { layer, rings, sent, press } = harnessed(agents, { config: cfg, listGate: list });
    layer.setLatched(true);
    await list.open();
    assert.equal(rings.at(-1), '#FF7A00');
    press(MODEL);
    assert.equal(layer.intercept(input), false, 'navigation must reach PadControls');
    agents[0] = agent('w1:p2', 'w1', 'idle', 'omp', { focused: true });
    layer.focusMoved();
    await settle();

    assert.deepEqual(sent, [], 'the pre-navigation control lookup was abandoned');
    assert.equal(
      rings.at(-1),
      DEFAULT_CONFIG.harness.underglow.active,
      'the destination owns the ring',
    );
    layer.setLatched(false);
  }
});

test('a latched tab move cancels a commit queued behind an opener', async () => {
  const navigation: PadInput[] = [{ kind: 'key', key: 'ACT09', pressed: true }];
  for (const input of navigation) {
    const order: string[] = [];
    const opener = gate();
    const { layer, press } = harnessed([claudeAgent()], {
      client: {
        sendTextToPane: async (_paneId, text) => {
          if (text === '/model') await opener.held;
          order.push(text);
        },
        sendKeysToPane: async (_paneId, keys) => void order.push(keys.join('+')),
      },
    });
    layer.setLatched(true);
    press(MODEL);
    await settle();
    layer.intercept({ kind: 'dial', action: 'click' });
    assert.equal(layer.intercept(input), false);
    await opener.open();

    assert.deepEqual(
      order,
      ['/model', 'enter'],
      'the old picker must not receive its queued commit',
    );
    layer.setLatched(false);
  }
});

test('a latched stick types arrows without re-aiming the layer, whatever the bindings say', async () => {
  let lists = 0;
  // `[controls.joystick]` says where a *pane* push should go. Inside the layer
  // no pane is being focused, so a direction switched off there is still an
  // arrow key -- the setting has nothing to say about it.
  const cfg = config();
  cfg.controls = { ...cfg.controls, joystick: { ...cfg.controls.joystick, down: 'none' } };
  const { layer, sent } = harnessed([claudeAgent()], {
    config: cfg,
    client: {
      agentList: async () => {
        lists++;
        return [claudeAgent()];
      },
    },
  });
  layer.setLatched(true);
  await settle();
  for (let i = 0; i < 5; i++) {
    layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  }
  await settle();
  assert.deepEqual(sent, [{ keys: ['down'] }], 'a held stick is one arrow, not one per report');
  assert.equal(lists, 1, 'opening only: the stick no longer moves the focus, so nothing re-aims');

  layer.intercept({ kind: 'joystick', angle: 0, distance: 0 });
  layer.intercept({ kind: 'joystick', angle: 0.25, distance: 0.6 });
  layer.intercept({ kind: 'key', key: 'ACT09', pressed: false });
  await settle();
  assert.deepEqual(sent, [{ keys: ['down'] }, { keys: ['down'] }], 'a fresh push is a fresh arrow');
  assert.equal(lists, 1, 'and a release still moves nothing');
  layer.setLatched(false);
});

test('the ring is re-asserted when the pad comes back to a latched layer', async () => {
  const { layer, rings } = harnessed([claudeAgent()]);
  layer.setLatched(true);
  await settle();

  // wirePad repaints the dial's own colour on reconnect and knows nothing about
  // the layer, so main.ts calls this after it to put the truth back on top.
  rings.length = 0;
  layer.repaintRing();
  await settle();
  assert.equal(rings.at(-1), '#FF7A00');

  // A picker that survived the reconnect keeps the harness colour while it
  // continues capturing every key.
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  await settle();
  rings.length = 0;
  layer.repaintRing();
  assert.equal(rings.at(-1), '#FF7A00');
});

test('a closed layer has no ring to re-assert', async () => {
  const { layer, rings } = harnessed([claudeAgent()]);

  rings.length = 0;
  layer.repaintRing();
  await settle();
  assert.deepEqual(rings, [], 'the dial owns the ring when the layer is shut');
});

test('a latched layer leaves the rest of the pad alone', async () => {
  const { layer } = harnessed([claudeAgent()]);
  layer.setLatched(true);
  await settle();

  // This is a context the user sits in, and killing Esc, the popup and tab
  // navigation for as long as a mode is selected -- with nothing held down and
  // nothing to show for it -- is not a layer, it is a dead pad.
  for (const key of ['ACT06', ESCAPE, 'ACT09']) {
    assert.equal(layer.intercept({ kind: 'key', key, pressed: true }), false, key);
  }

  // What the layer does claim: whatever a harness binds, plus the two controls
  // that drive a list -- the stick and Enter.
  assert.equal(layer.intercept({ kind: 'key', key: MODEL, pressed: true }), true);
  assert.equal(layer.intercept({ kind: 'joystick', angle: 0, distance: 0.5 }), true);
  assert.equal(layer.intercept({ kind: 'key', key: ENTER, pressed: true }), true);
});

test('a dial click commits rather than dropping what it just committed', async () => {
  const order: string[] = [];
  const opener = gate();
  const layer = new HarnessLayer(
    {
      agentList: async () => [claudeAgent()],
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async (_paneId, text) => {
        if (text === '/model') await opener.held;
        order.push(text);
      },
      sendKeysToPane: async (_paneId, keys) => void order.push(keys.join('+')),
    },
    config(),
    silentLogger,
    () => {},
  );

  layer.setLatched(true);
  await settle();
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  await settle();
  // The first click commits the list -- `routePicker` owns it. The second is
  // the one that reaches the latched branch, and it leaves harness mode. It
  // does not move the focus, so treating it as a re-aim would drop the commit
  // still queued behind the held opener.
  layer.intercept({ kind: 'dial', action: 'click' });
  assert.equal(layer.intercept({ kind: 'dial', action: 'click' }), false, 'the way out');

  await opener.open();
  assert.deepEqual(order, ['/model', 'enter', 'enter'], 'the commit must survive');
});

test('a slow read from before a re-aim cannot repaint after it', async () => {
  const agents = [claudeAgent()];
  const opening = gate();
  let calls = 0;
  const rings: RingState[] = [];
  const layer = new HarnessLayer(
    {
      agentList: async () => {
        // The layer-open read is held and sees claude; everything after it
        // lands at once and sees wherever the re-aim went.
        const answer = [...agents];
        if (calls++ === 0) await opening.held;
        return answer;
      },
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async () => {},
      sendKeysToPane: async () => {},
    },
    config(),
    silentLogger,
    (ring) => rings.push(ring),
  );

  layer.setLatched(true);
  await settle();
  agents[0] = agent('w1:p1', 'w1', 'idle', 'omp', { focused: true });
  layer.focusMoved();
  await settle();

  // The move's read lands first and sees omp; the opening read lands after it,
  // still holding claude. Without a generation on each the two are
  // indistinguishable, and the stale one paints last simply by being slower.
  await opening.open();
  assert.equal(rings.at(-1), DEFAULT_CONFIG.harness.underglow.active, 'the re-aim wins');
});

test('a burst of moves leaves the ring where the last one landed', async () => {
  const agents = [claudeAgent()];
  const rings: RingState[] = [];
  const reads: Gate[] = [];
  const layer = new HarnessLayer(
    {
      agentList: async () => {
        const answer = [...agents];
        const read = gate();
        reads.push(read);
        await read.held;
        return answer;
      },
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async () => {},
      sendKeysToPane: async () => {},
    },
    config(),
    silentLogger,
    (ring) => rings.push(ring),
  );

  layer.setLatched(true);
  await settle();
  await reads[0]?.open();

  // Five moves in flight at once. Only the answer to the last question may
  // paint, and they are released in the reverse of the order they were asked
  // so that being slowest is what a stale answer has going for it.
  for (let i = 0; i < 4; i++) layer.focusMoved();
  agents[0] = agent('w1:p1', 'w1', 'idle', 'omp', { focused: true });
  layer.focusMoved();
  await settle();

  assert.equal(reads.length, 6, 'one read per move, none coalesced');
  for (const read of reads.slice(1).reverse()) await read.open();

  assert.equal(rings.at(-1), DEFAULT_CONFIG.harness.underglow.active, 'omp, the last answer');
});

test('clicking out of harness mode abandons a control press still in flight', async () => {
  const list = gate();
  const { layer, sent, rings } = harnessed([claudeAgent()], { listGate: list });

  layer.setLatched(true);
  await settle();
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  // The dial click that leaves harness mode arrives before the press resolves.
  // Unlike a keycap release -- which only means the finger is done, and which a
  // press deliberately outlives -- this is the user saying they have left.
  layer.setLatched(false);

  await list.open();
  assert.deepEqual(sent, [], 'nothing is typed into the pane they left');
  assert.equal(rings.at(-1), null, 'and no picker opens in a mode they are not in');
  assert.equal(layer.intercept({ kind: 'dial', action: 'clockwise' }), false, 'pad is free');
});

test('a press still in flight when the pad goes does not resurrect a picker', async () => {
  const list = gate();
  const { layer, sent, rings } = harnessed([claudeAgent()], { listGate: list });

  layer.setLatched(true);
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  // Unplugged before the round trip lands. Letting the press land here types at
  // a pad that is not there and then captures every key on it with a picker
  // nobody can end.
  layer.reset();

  await list.open();
  assert.deepEqual(sent, [], 'nothing is typed at a pad that has gone');
  assert.equal(rings.at(-1), '#FF7A00', 'the layer keeps the harness colour');
});

test('a second control press cannot type into the list the first one opened', async () => {
  const list = gate();
  const { layer, sent } = harnessed([claudeAgent()], { listGate: list });

  layer.setLatched(true);
  // Both presses pass the active check: the state only becomes `picker` when
  // the first round trip resolves. A double tap must not reopen the picker.
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });
  layer.intercept({ kind: 'key', key: MODEL, pressed: true });

  await list.open();
  assert.deepEqual(sent, MODEL_OPEN);
});

test('reset leaves a latched layer open, since no release is what held it', async () => {
  const { layer, rings, open } = harnessed([claudeAgent()]);
  layer.setLatched(true);
  await settle();
  await open();

  // The pad unplugged. `held` is fiction now, but the dial mode is not -- it is
  // still `harness` on the other side of a reconnect.
  layer.reset();
  assert.notEqual(rings.at(-1), null, 'the mode still asks for the layer');
  assert.equal(layer.intercept({ kind: 'key', key: MODEL, pressed: true }), true);
});

// ---------------------------------------------------------------------------
// The composite in main.ts: decline means PadControls sees it.
// ---------------------------------------------------------------------------

test('declined input reaches the navigation layer and consumed input does not', async () => {
  const { layer, open } = harnessed([claudeAgent()]);
  const seen: PadInput[] = [];
  const handle = (input: PadInput) => {
    if (!layer.intercept(input)) seen.push(input);
  };

  for (const input of EVERY_INPUT) handle(input);
  assert.equal(seen.length, EVERY_INPUT.length, 'everything passes while inactive');

  await open();
  seen.length = 0;
  // Everything except the control key, which would fire and move the layer on
  // into the picker -- that path has its own tests above.
  const handled = EVERY_INPUT.filter((input) => input.kind !== 'key' || input.key !== MODEL);
  for (const input of handled) handle(input);

  assert.deepEqual(
    seen,
    handled.filter(
      (input) => input.kind !== 'joystick' && !(input.kind === 'dial' && input.action !== 'click'),
    ),
    'the stick and the dial turn are what the layer claims; the rest means itself',
  );
});

// ---------------------------------------------------------------------------
// Failure modes. The pad must degrade rather than stop.
// ---------------------------------------------------------------------------

function recordingLogger(): { log: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    log: { info: () => {}, error: () => {}, warn: (msg) => void warnings.push(msg) },
  };
}

test('a throw inside the layer fails open, handing the input to PadControls', () => {
  const { log, warnings } = recordingLogger();
  const rings: RingState[] = [];
  const cfg = config();
  const layer = new HarnessLayer(
    {
      agentList: async () => [claudeAgent()],
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async () => {},
      sendKeysToPane: async () => {},
    },
    cfg,
    log,
    (ring) => rings.push(ring),
  );

  // Corrupted after construction, so the throw lands on the input path rather
  // than at startup. loadConfig cannot produce this -- the point is only that
  // if routing ever throws, the navigation layer still gets the key.
  cfg.controls = null as unknown as Config['controls'];

  assert.equal(layer.intercept({ kind: 'key', key: 'ACT06', pressed: true }), false);
  assert.deepEqual(warnings, ['harness layer failed']);

  // And it must still open afterwards: a layer that cannot reopen is a layer
  // that failed closed, which is the opposite of the point.
  cfg.controls = DEFAULT_CONFIG.controls;
  layer.setLatched(true);
  assert.equal(rings.at(-1), DEFAULT_CONFIG.harness.underglow.active, 'it really reopened');
});

test('a throw in a background step is logged, not left as an unhandled rejection', async () => {
  const { log, warnings } = recordingLogger();
  let paints = 0;
  const layer = new HarnessLayer(
    {
      agentList: async () => [claudeAgent()],
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async () => {},
      sendKeysToPane: async () => {},
    },
    config(),
    log,
    () => {
      // The first paint is the layer opening, which is synchronous and reaches
      // `intercept`'s catch. The second is the harness settling a round trip
      // later, long after `intercept` returned -- nothing on the input path can
      // see that one.
      paints++;
      if (paints > 1) throw new Error('the pad went away mid-paint');
    },
  );

  layer.setLatched(true);
  await settle();

  assert.deepEqual(warnings, ['harness step failed']);
});

test('a send that herdr rejects is logged, never thrown at the input path', async () => {
  const { log, warnings } = recordingLogger();
  const layer = new HarnessLayer(
    {
      agentList: async () => [claudeAgent()],
      currentPaneId: async () => 'w1:p1',
      sendTextToPane: async () => {},
      sendKeysToPane: async () => {
        throw new Error('herdr said no');
      },
    },
    config(),
    log,
    () => {},
  );

  layer.setLatched(true);
  await settle();
  assert.doesNotThrow(() => layer.intercept({ kind: 'key', key: MODEL, pressed: true }));

  await settle();
  assert.deepEqual(warnings, ['harness effect failed']);
});
