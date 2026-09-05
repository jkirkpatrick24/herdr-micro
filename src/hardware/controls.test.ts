import assert from 'node:assert/strict';
import { test } from 'vitest';

import { type ControlConfig, DEFAULT_CONFIG } from '../config.js';
import { HerdrClient } from '../herdr/client.js';
import type { Logger } from '../log.js';
import { Store } from '../state/store.js';
import { type FakeOptions, startFakeHerdr } from '../testing/fake-herdr.js';
import { agent, pane, silentLogger, snapshot, tab, workspace } from '../testing/fixtures.js';
import { PadControls } from './controls.js';

// The periodic agent.list refresh is startup machinery, not pad input; pushing
// it past any test's lifetime keeps the request log attributable to the pad.
const FAST = { ackTimeoutMs: 200, requestTimeoutMs: 400, refreshIntervalMs: 60_000 };

/**
 * A pad wired to a real HerdrClient over a real socket. The controls only ever
 * reach herdr through request/response, so the assertions below are on the
 * JSON-RPC the daemon actually emits -- which is what catches a wrong method
 * name or param shape. Only the herdr daemon is faked; the pad hardware is
 * bypassed by feeding PadInput values straight into handle().
 *
 * Proving a control did NOT act needs care: a timed pause only proves the
 * request had not arrived *yet*, and passes for a deleted guard on a slow box.
 * So the negative tests below follow the no-op input with an input that must
 * produce a request, then assert the whole ordered log -- the later request is
 * the receipt that the earlier one had already resolved into nothing.
 */
async function pad(
  t: { onTestFinished(fn: () => unknown): void },
  opts: FakeOptions = {},
  extra: { controls?: Partial<ControlConfig>; log?: Logger } = {},
) {
  const fake = await startFakeHerdr(opts);
  t.onTestFinished(() => fake.stop());
  // Always silent: a failing method also trips the client's own reconcile
  // logging, which would land in a test's capture buffer beside the pad's.
  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  // Registered before the awaits below so a throw in start() still tears down.
  // Vitest runs these in reverse, so the client stops before the server does;
  // the other order would make the client reconnect against a dead socket.
  t.onTestFinished(() => client.stop());
  // A client only resolves its socket path in start(), so the pad cannot reach
  // herdr through one that was never started -- run it the way the daemon does.
  await client.start();
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));

  const store = new Store(silentLogger);
  const modes: string[] = [];
  const controls = new PadControls(
    client,
    store,
    { ...DEFAULT_CONFIG.controls, ...extra.controls },
    extra.log ?? silentLogger,
    (mode) => modes.push(mode),
  );

  const base = fake.requests.length;
  /**
   * Everything the pad caused. Startup is excluded by index, except that the
   * seed's reply drives one events.subscribe per agent pane which can land
   * after that index -- the pad never subscribes, so drop those by method too.
   */
  const after = () => fake.requests.slice(base).filter((r) => r.method !== 'events.subscribe');
  const calls = (method: string) => after().filter((r) => r.method === method);

  /** Wait until `method` has been called `count` times, then hand back its params. */
  const awaitCalls = async (method: string, count: number) => {
    await fake.waitFor(() => calls(method).length >= count);
    return calls(method).map((r) => r.params);
  };

  /**
   * Drain whatever a fire-and-forget handler still had to send, then pin the
   * whole ordered log. fake.requests records arrival, not completion, so
   * awaiting a request only proves that its chain started; what this rules out
   * is a stray request issued concurrently with one already seen.
   *
   * Eight short yields, not one long sleep: each `await` releases the macrotask
   * queue so a promise chain advances one link, and the longest chain here is
   * several links deep. A single 40ms sleep waits the same wall time and lets
   * through far fewer of them.
   */
  const expectMethods = async (...expected: string[]) => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      after().map((r) => r.method),
      expected,
    );
  };

  return { fake, store, controls, modes, awaitCalls, expectMethods };
}

// ---------------------------------------------------------------------------
// Dial modes
// ---------------------------------------------------------------------------

test('dial click cycles modes and reports each one to its listener', async (t) => {
  const { controls, modes } = await pad(t);

  controls.handle({ kind: 'dial', action: 'click' });
  controls.handle({ kind: 'dial', action: 'click' });

  assert.deepEqual(modes, ['agents', 'scroll']);
  assert.equal(controls.dialMode, 'scroll');
});

test('dial click wraps back to the first configured mode', async (t) => {
  const { controls, modes } = await pad(
    t,
    {},
    { controls: { dialModeOrder: ['scroll', 'agents'] } },
  );

  assert.equal(controls.dialMode, 'scroll');
  controls.handle({ kind: 'dial', action: 'click' });
  controls.handle({ kind: 'dial', action: 'click' });

  assert.deepEqual(modes, ['agents', 'scroll']);
});

// ---------------------------------------------------------------------------
// Workspace stepping
// ---------------------------------------------------------------------------

test('dial steps workspaces in both directions and wraps around the list', async (t) => {
  const { controls, awaitCalls } = await pad(t, {
    workspaces: [
      workspace('w1', 'one', 1, { focused: true }),
      workspace('w2', 'two', 2),
      workspace('w3', 'three', 3),
    ],
  });

  controls.handle({ kind: 'dial', action: 'clockwise' });
  await awaitCalls('workspace.focus', 1);
  controls.handle({ kind: 'dial', action: 'counterclockwise' });
  const focused = await awaitCalls('workspace.focus', 2);

  // Clockwise steps backwards, so it wraps off the front of the list.
  assert.deepEqual(focused, [{ workspace_id: 'w3' }, { workspace_id: 'w2' }]);
});

test('dial leaves a lone workspace alone', async (t) => {
  const { fake, controls, awaitCalls, expectMethods } = await pad(t, {
    workspaces: [workspace('w1', 'one', 1, { focused: true })],
  });

  controls.handle({ kind: 'dial', action: 'clockwise' });
  await awaitCalls('workspace.list', 1);

  // Pins the `workspaces.length < 2` clause; the sibling test below pins the
  // `current < 0` one. They read as duplicates but kill different mutants.
  // A second workspace makes the same input act, and its focus is the receipt
  // that the first input had already finished doing nothing.
  fake.setWorkspaces([workspace('w1', 'one', 1, { focused: true }), workspace('w2', 'two', 2)]);
  controls.handle({ kind: 'dial', action: 'clockwise' });
  await awaitCalls('workspace.focus', 1);

  await expectMethods('workspace.list', 'workspace.list', 'workspace.focus');
});

test('dial does nothing when herdr reports no focused workspace', async (t) => {
  const { fake, controls, awaitCalls, expectMethods } = await pad(t, {
    workspaces: [workspace('w1', 'one'), workspace('w2', 'two', 2)],
  });

  controls.handle({ kind: 'dial', action: 'clockwise' });
  await awaitCalls('workspace.list', 1);

  fake.setWorkspaces([workspace('w1', 'one', 1, { focused: true }), workspace('w2', 'two', 2)]);
  controls.handle({ kind: 'dial', action: 'clockwise' });
  await awaitCalls('workspace.focus', 1);

  await expectMethods('workspace.list', 'workspace.list', 'workspace.focus');
});

// ---------------------------------------------------------------------------
// Tab stepping
// ---------------------------------------------------------------------------

test('tab keys step forwards and backwards within the focused workspace', async (t) => {
  const { controls, awaitCalls } = await pad(t, {
    workspaces: [workspace('w1', 'one', 1, { focused: true }), workspace('w2', 'two', 2)],
    tabs: {
      w1: [tab('t1', 'one', { focused: true }), tab('t2', 'two'), tab('t3', 'three')],
      w2: [tab('other')],
    },
  });

  controls.handle({ kind: 'key', key: 'ACT09', pressed: true });
  await awaitCalls('tab.focus', 1);
  controls.handle({ kind: 'key', key: 'ACT08', pressed: true });
  const focused = await awaitCalls('tab.focus', 2);

  assert.deepEqual(focused, [{ tab_id: 't2' }, { tab_id: 't3' }]);
});

test('tab stepping asks only the focused workspace for its tabs', async (t) => {
  const { controls, awaitCalls } = await pad(t, {
    workspaces: [workspace('w1', 'one'), workspace('w2', 'two', 2, { focused: true })],
    tabs: { w2: [tab('t1', 'one', { focused: true }), tab('t2', 'two')] },
  });

  controls.handle({ kind: 'key', key: 'ACT09', pressed: true });
  const listed = await awaitCalls('tab.list', 1);

  assert.deepEqual(listed, [{ workspace_id: 'w2' }]);
});

test('tab stepping never asks for tabs when no workspace is focused', async (t) => {
  const { fake, controls, awaitCalls, expectMethods } = await pad(t, {
    workspaces: [workspace('w1', 'one'), workspace('w2', 'two', 2)],
    tabs: { w1: [tab('t1', 'one', { focused: true }), tab('t2', 'two')] },
  });

  controls.handle({ kind: 'key', key: 'ACT09', pressed: true });
  await awaitCalls('workspace.list', 1);

  fake.setWorkspaces([workspace('w1', 'one', 1, { focused: true })]);
  controls.handle({ kind: 'key', key: 'ACT09', pressed: true });
  await awaitCalls('tab.focus', 1);

  await expectMethods('workspace.list', 'workspace.list', 'tab.list', 'tab.focus');
});

test('tab stepping stops when no tab is marked focused', async (t) => {
  const { fake, controls, awaitCalls, expectMethods } = await pad(t, {
    workspaces: [workspace('w1', 'one', 1, { focused: true })],
    tabs: { w1: [tab('t1', 'one'), tab('t2', 'two')] },
  });

  controls.handle({ kind: 'key', key: 'ACT09', pressed: true });
  await awaitCalls('tab.list', 1);

  // Without the `current < 0` clause, cycle() would wrap off -1 and yank focus
  // to a tab the user never asked for.
  fake.setTabs({ w1: [tab('t1', 'one', { focused: true }), tab('t2', 'two')] });
  controls.handle({ kind: 'key', key: 'ACT09', pressed: true });
  await awaitCalls('tab.focus', 1);

  await expectMethods('workspace.list', 'tab.list', 'workspace.list', 'tab.list', 'tab.focus');
});

test('tab stepping stops when the workspace has a single tab', async (t) => {
  const { fake, controls, awaitCalls, expectMethods } = await pad(t, {
    workspaces: [workspace('w1', 'one', 1, { focused: true })],
    tabs: { w1: [tab('t1', 'one', { focused: true })] },
  });

  controls.handle({ kind: 'key', key: 'ACT08', pressed: true });
  await awaitCalls('tab.list', 1);

  fake.setTabs({ w1: [tab('t1', 'one', { focused: true }), tab('t2', 'two')] });
  controls.handle({ kind: 'key', key: 'ACT08', pressed: true });
  await awaitCalls('tab.focus', 1);

  await expectMethods('workspace.list', 'tab.list', 'workspace.list', 'tab.list', 'tab.focus');
});

// ---------------------------------------------------------------------------
// Agent stepping -- the ordering is the whole point of the mode
// ---------------------------------------------------------------------------

test('agent mode orders by attention, not by list order', async (t) => {
  const { controls, awaitCalls } = await pad(t, {
    agents: [
      agent('p1', 'w1', 'working'),
      agent('p2', 'w1', 'blocked'),
      agent('p3', 'w1', 'idle'),
      agent('p4', 'w1', 'done'),
    ],
    currentPane: 'p2',
  });

  controls.handle({ kind: 'dial', action: 'click' });
  controls.handle({ kind: 'dial', action: 'counterclockwise' });
  await awaitCalls('agent.focus', 1);
  controls.handle({ kind: 'dial', action: 'clockwise' });
  const focused = await awaitCalls('agent.focus', 2);

  // Attention order is blocked, done, working, idle -- p2, p4, p1, p3 -- and the
  // dial starts from p2, so forwards lands on p4 and backwards wraps to p3.
  assert.deepEqual(focused, [{ target: 'p4' }, { target: 'p3' }]);
});

test('agent mode starts at the top of the attention order, ranking idle above unknown', async (t) => {
  const { controls, awaitCalls } = await pad(t, {
    agents: [agent('p-unknown', 'w1', 'unknown'), agent('p-idle', 'w1', 'idle')],
    currentPane: 'a-plain-shell',
  });

  controls.handle({ kind: 'dial', action: 'click' });
  controls.handle({ kind: 'dial', action: 'clockwise' });
  const focused = await awaitCalls('agent.focus', 1);

  // The focused pane is a plain shell, so the dial jumps to the head of the order.
  assert.deepEqual(focused, [{ target: 'p-idle' }]);
});

test('agents at equal attention are ordered by most recent change', async (t) => {
  const { controls, awaitCalls } = await pad(t, {
    agents: [
      agent('p-stale', 'w1', 'blocked', 'claude', { stateChangeSeq: 4 }),
      agent('p-fresh', 'w1', 'blocked', 'claude', { stateChangeSeq: 9 }),
      agent('p-none', 'w1', 'blocked'),
    ],
    currentPane: 'p-stale',
  });

  controls.handle({ kind: 'dial', action: 'click' });
  controls.handle({ kind: 'dial', action: 'clockwise' });
  await awaitCalls('agent.focus', 1);
  controls.handle({ kind: 'dial', action: 'counterclockwise' });
  const focused = await awaitCalls('agent.focus', 2);

  // All three are blocked, so only state_change_seq separates them. Stepping
  // both ways off the middle one pins the whole order: p-fresh, p-stale, and
  // the one with no seq at all sorting last rather than anywhere convenient.
  assert.deepEqual(focused, [{ target: 'p-fresh' }, { target: 'p-none' }]);
});

test('agent mode gives up before asking which pane is current when there are none', async (t) => {
  const { fake, controls, awaitCalls, expectMethods } = await pad(t, {
    agents: [],
    currentPane: 'p1',
  });

  controls.handle({ kind: 'dial', action: 'click' });
  controls.handle({ kind: 'dial', action: 'clockwise' });
  await awaitCalls('agent.list', 1);

  fake.setAgents([agent('p1', 'w1', 'blocked')]);
  controls.handle({ kind: 'dial', action: 'clockwise' });
  await awaitCalls('agent.focus', 1);

  // The empty list short-circuits, so the first turn costs one request, not two.
  await expectMethods('agent.list', 'agent.list', 'pane.current', 'agent.focus');
});

// ---------------------------------------------------------------------------
// Scroll mode and key sending
// ---------------------------------------------------------------------------

test('scroll mode sends one page key per configured step to the focused pane', async (t) => {
  const { controls, awaitCalls } = await pad(
    t,
    { currentPane: 'p1' },
    { controls: { scrollSteps: 3 } },
  );

  controls.handle({ kind: 'dial', action: 'click' });
  controls.handle({ kind: 'dial', action: 'click' });
  controls.handle({ kind: 'dial', action: 'counterclockwise' });
  await awaitCalls('pane.send_text', 1);
  controls.handle({ kind: 'dial', action: 'clockwise' });
  const sent = await awaitCalls('pane.send_text', 2);

  // send_text rather than send_keys, and the literal escape sequences rather
  // than a key name: herdr has no page key to ask for. Asserted as bytes
  // because that is the whole content of the fix -- a name here would be
  // checked by nothing, which is how `pageup` survived.
  assert.deepEqual(sent, [
    { pane_id: 'p1', text: '\x1b[6~\x1b[6~\x1b[6~' },
    { pane_id: 'p1', text: '\x1b[5~\x1b[5~\x1b[5~' },
  ]);
});

test('the key names the daemon sends are ones herdr accepts', async (t) => {
  // The fake validates key names exactly as herdr does, so this is a live
  // check on the vocabulary in rpc.ts rather than a restatement of it. Escape
  // and enter are the only names the pad still sends by name.
  const { controls, awaitCalls } = await pad(t, { currentPane: 'p1' });

  controls.handle({ kind: 'key', key: 'ACT07', pressed: true });
  await awaitCalls('pane.send_keys', 1);
  controls.handle({ kind: 'key', key: 'ACT12', pressed: true });
  const keys = await awaitCalls('pane.send_keys', 2);

  assert.deepEqual(
    keys.map((p) => p.keys),
    [['esc'], ['enter']],
  );
});

test('key sending is skipped when herdr reports no focused pane', async (t) => {
  const { fake, controls, awaitCalls, expectMethods } = await pad(t, { currentPane: null });

  controls.handle({ kind: 'key', key: 'ACT07', pressed: true });
  await awaitCalls('pane.current', 1);

  fake.setCurrentPane('p1');
  controls.handle({ kind: 'key', key: 'ACT07', pressed: true });
  await awaitCalls('pane.send_keys', 1);

  await expectMethods('pane.current', 'pane.current', 'pane.send_keys');
});

test('auxiliary defaults route popup, escape, and enter', async (t) => {
  const { controls, awaitCalls, expectMethods } = await pad(t, { currentPane: 'p1' });

  // Each key is awaited in turn: escape and enter are two round trips apiece on
  // separate sockets, so firing them together would leave the order to chance.
  controls.handle({ kind: 'key', key: 'ACT06', pressed: true });
  await awaitCalls('popup.close', 1);
  controls.handle({ kind: 'key', key: 'ACT07', pressed: true });
  await awaitCalls('pane.send_keys', 1);
  controls.handle({ kind: 'key', key: 'ACT12', pressed: true });
  const keys = await awaitCalls('pane.send_keys', 2);

  await expectMethods(
    'popup.close',
    'pane.current',
    'pane.send_keys',
    'pane.current',
    'pane.send_keys',
  );
  assert.deepEqual(
    keys.map((p) => p.keys),
    [['esc'], ['enter']],
  );
});

test('the popup key falls back to the plugin pane when nothing is open', async (t) => {
  const { controls, awaitCalls } = await pad(t, { failMethods: ['popup.close'] });

  controls.handle({ kind: 'key', key: 'ACT06', pressed: true });
  const opened = await awaitCalls('plugin.pane.open', 1);

  assert.deepEqual(opened, [
    { plugin_id: 'jkirkpatrick24.herdr-micro', entrypoint: 'keys', placement: 'popup' },
  ]);
});

test('the popup key falls back to a notification on a standalone install', async (t) => {
  const { controls, awaitCalls, expectMethods } = await pad(t, {
    failMethods: ['popup.close', 'plugin.pane.open'],
  });

  controls.handle({ kind: 'key', key: 'ACT06', pressed: true });
  const shown = await awaitCalls('notification.show', 1);

  await expectMethods('popup.close', 'plugin.pane.open', 'notification.show');
  assert.deepEqual(shown, [{ title: 'Creator Micro controls' }]);
});

// ---------------------------------------------------------------------------
// Agent slot keys
// ---------------------------------------------------------------------------

test('agent keys focus the pane the store has parked in that slot', async (t) => {
  const { store, controls, awaitCalls, expectMethods } = await pad(t);
  store.applySeed(
    snapshot(
      [workspace('w1')],
      [pane('w1:p1', 'w1', { agent: 'claude' }), pane('w1:p2', 'w1', { agent: 'omp' })],
    ),
  );

  controls.handle({ kind: 'key', key: 'AG01', pressed: true });
  const focused = await awaitCalls('agent.focus', 1);

  assert.deepEqual(focused, [{ target: 'w1:p2' }]);
  // The slot map is local, so the key costs no agent.list round trip.
  await expectMethods('agent.focus');
});

test('an agent key for an empty slot is ignored', async (t) => {
  const { store, controls, awaitCalls, expectMethods } = await pad(t);
  store.applySeed(snapshot([workspace('w1')], [pane('w1:p1', 'w1', { agent: 'claude' })]));

  controls.handle({ kind: 'key', key: 'AG05', pressed: true });
  controls.handle({ kind: 'key', key: 'AG00', pressed: true });
  const focused = await awaitCalls('agent.focus', 1);

  // Only the occupied slot produced a request, and it is the only one.
  await expectMethods('agent.focus');
  assert.deepEqual(focused, [{ target: 'w1:p1' }]);
});

test('key releases and unmapped keys do nothing', async (t) => {
  const { controls, awaitCalls, expectMethods } = await pad(t, { currentPane: 'p1' });

  controls.handle({ kind: 'key', key: 'ACT06', pressed: false });
  controls.handle({ kind: 'key', key: 'ACT10', pressed: true });
  controls.handle({ kind: 'key', key: 'ACT99', pressed: true });
  controls.handle({ kind: 'key', key: 'ACT12', pressed: true });
  await awaitCalls('pane.send_keys', 1);

  // Only the mapped press shows up, and it is not preceded by anything.
  await expectMethods('pane.current', 'pane.send_keys');
});

// ---------------------------------------------------------------------------
// Joystick
// ---------------------------------------------------------------------------

test('joystick focuses the nearest pane direction once per sector', async (t) => {
  const { controls, awaitCalls } = await pad(t);

  controls.handle({ kind: 'joystick', angle: 0, distance: 0.3 });
  controls.handle({ kind: 'joystick', angle: 0.02, distance: 0.9 });
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.1 });
  controls.handle({ kind: 'joystick', angle: 0.5, distance: 0.9 });
  const directions = await awaitCalls('pane.focus_direction', 2);

  assert.deepEqual(directions, [{ direction: 'right' }, { direction: 'left' }]);
});

test('every sector maps to its own direction', async (t) => {
  const { controls, awaitCalls } = await pad(t);

  for (const angle of [0, 0.25, 0.5, 0.75]) {
    controls.handle({ kind: 'joystick', angle, distance: 0.9 });
    controls.handle({ kind: 'joystick', angle, distance: 0 });
  }
  const directions = await awaitCalls('pane.focus_direction', 4);

  assert.deepEqual(directions, [
    { direction: 'right' },
    { direction: 'down' },
    { direction: 'left' },
    { direction: 'up' },
  ]);
});

test('an angle between cardinals snaps to the nearest, not the lower', async (t) => {
  const { controls, awaitCalls } = await pad(t);

  // 0.2 is nearer sector 1 than sector 0. Truncating instead of rounding would
  // read it as 'right'. protocol.ts forwards the device's angle unnormalised,
  // so the rounding rule is a live path, not an internal detail.
  controls.handle({ kind: 'joystick', angle: 0.2, distance: 0.9 });
  const directions = await awaitCalls('pane.focus_direction', 1);

  assert.deepEqual(directions, [{ direction: 'down' }]);
});

test('an angle past the last sector wraps to the first', async (t) => {
  const { controls, awaitCalls } = await pad(t);

  // 0.9 rounds to sector 4, which only exists as sector 0 after the wrap.
  // Without it the lookup is undefined and the push silently does nothing.
  controls.handle({ kind: 'joystick', angle: 0.9, distance: 0.9 });
  const directions = await awaitCalls('pane.focus_direction', 1);

  assert.deepEqual(directions, [{ direction: 'right' }]);
});

test('a negative angle maps to its direction rather than being dropped', async (t) => {
  const { controls, awaitCalls } = await pad(t);

  // protocol.ts forwards whatever finite angle the pad reports, so a signed one
  // is a live path. Taking the modulo of the sector alone kept the sign, and a
  // negative index found nothing in SECTORS: up, left and down were all
  // silently unreachable while right still worked, so the stick looked broken
  // in three directions out of four.
  controls.handle({ kind: 'joystick', angle: -0.25, distance: 0.9 });
  controls.handle({ kind: 'joystick', angle: -0.5, distance: 0.9 });
  controls.handle({ kind: 'joystick', angle: -0.75, distance: 0.9 });
  const directions = await awaitCalls('pane.focus_direction', 3);

  assert.deepEqual(directions, [{ direction: 'up' }, { direction: 'left' }, { direction: 'down' }]);
});

test('a joystick nudge inside the dead zone never engages a direction', async (t) => {
  const { controls, awaitCalls, expectMethods } = await pad(t);

  // The nudge and the push are in different sectors on purpose: were the dead
  // zone ignored, the nudge would fire 'down' of its own and show up here. A
  // same-sector pair would be swallowed by the dedupe and prove nothing.
  controls.handle({ kind: 'joystick', angle: 0.25, distance: 0.2 });
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.3 });
  const directions = await awaitCalls('pane.focus_direction', 1);

  await expectMethods('pane.focus_direction');
  assert.deepEqual(directions, [{ direction: 'right' }]);
});

test('releasing through the inner ring re-arms the same direction', async (t) => {
  const { controls, awaitCalls } = await pad(t);

  controls.handle({ kind: 'joystick', angle: 0, distance: 0.9 });
  await awaitCalls('pane.focus_direction', 1);

  // Falling below the release ring clears the sector, so pushing back to the
  // very same direction has to fire again rather than being deduped.
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.05 });
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.9 });
  const directions = await awaitCalls('pane.focus_direction', 2);

  assert.deepEqual(directions, [{ direction: 'right' }, { direction: 'right' }]);
});

test('a push of exactly the engage distance counts as engaged', async (t) => {
  const { controls, awaitCalls } = await pad(t);

  // Exactly ENGAGE_DISTANCE: the guard is `< ENGAGE`, so this must act. Were it
  // `<=`, the push would be swallowed and nothing would ever fire.
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.25 });
  const directions = await awaitCalls('pane.focus_direction', 1);

  assert.deepEqual(directions, [{ direction: 'right' }]);
});

test('a fall to exactly the release distance counts as released', async (t) => {
  const { controls, awaitCalls } = await pad(t);

  controls.handle({ kind: 'joystick', angle: 0, distance: 0.9 });
  await awaitCalls('pane.focus_direction', 1);

  // Exactly RELEASE_DISTANCE: the guard is `<= RELEASE`, so the sector clears
  // and the same direction re-arms. Were it `<`, the dedupe would swallow it.
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.1 });
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.9 });
  const directions = await awaitCalls('pane.focus_direction', 2);

  assert.deepEqual(directions, [{ direction: 'right' }, { direction: 'right' }]);
});

test('a held joystick keeps its sector without falling through the release ring', async (t) => {
  const { controls, awaitCalls, expectMethods } = await pad(t);

  controls.handle({ kind: 'joystick', angle: 0, distance: 0.9 });
  await awaitCalls('pane.focus_direction', 1);

  // Above the release ring but below engage: still held, so no re-fire. The
  // opposite sector then fires, and is the receipt that it never did.
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.15 });
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.9 });
  controls.handle({ kind: 'joystick', angle: 0.5, distance: 0.9 });
  const directions = await awaitCalls('pane.focus_direction', 2);

  await expectMethods('pane.focus_direction', 'pane.focus_direction');
  assert.deepEqual(directions, [{ direction: 'right' }, { direction: 'left' }]);
});

test('changing dial mode re-arms the joystick', async (t) => {
  const { controls, awaitCalls } = await pad(t);

  controls.handle({ kind: 'joystick', angle: 0, distance: 0.9 });
  await awaitCalls('pane.focus_direction', 1);

  // Without the re-arm the held sector would swallow the second push.
  controls.handle({ kind: 'dial', action: 'click' });
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.9 });
  const directions = await awaitCalls('pane.focus_direction', 2);

  assert.deepEqual(directions, [{ direction: 'right' }, { direction: 'right' }]);
});

test('a joystick direction mapped away from pane focus is ignored', async (t) => {
  const { controls, awaitCalls, expectMethods } = await pad(
    t,
    {},
    { controls: { joystick: { ...DEFAULT_CONFIG.controls.joystick, up: 'none' } } },
  );

  controls.handle({ kind: 'joystick', angle: 0.75, distance: 0.9 });
  controls.handle({ kind: 'joystick', angle: 0, distance: 0.9 });
  const directions = await awaitCalls('pane.focus_direction', 1);

  await expectMethods('pane.focus_direction');
  assert.deepEqual(directions, [{ direction: 'right' }]);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('a store that throws is contained rather than crashing the pad', async (t) => {
  const warnings: string[] = [];
  const log: Logger = {
    info: () => {},
    warn: (message: string) => void warnings.push(message),
    error: () => {},
  };
  const { store, controls, expectMethods } = await pad(t, {}, { log });
  // One method of a real Store replaced, to reach the synchronous catch in
  // handle() -- the net that stops a bad pad event taking the daemon down.
  store.agentForSlot = () => {
    throw new Error('slot lookup exploded');
  };

  assert.doesNotThrow(() => controls.handle({ kind: 'key', key: 'AG00', pressed: true }));

  assert.deepEqual(warnings, ['pad control failed']);
  await expectMethods();
});

test('a failing herdr call is warned about, not retried', async (t) => {
  const warnings: string[] = [];
  const log: Logger = {
    info: () => {},
    warn: (message: string) => void warnings.push(message),
    error: () => {},
  };
  const { fake, controls, expectMethods } = await pad(
    t,
    { failMethods: ['workspace.list'] },
    { log },
  );

  controls.handle({ kind: 'dial', action: 'clockwise' });
  await fake.waitFor(() => warnings.includes('workspace navigation failed'));

  await expectMethods('workspace.list');
});
