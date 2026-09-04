import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeHerdr } from '../testing/fake-herdr.js';
import { agent, frame, silentLogger, simpleSession, statusFrame } from '../testing/fixtures.js';
import { HerdrClient, parseSessionList, requestOnce, Subscriber } from './client.js';
import { reqSnapshot } from './rpc.js';

const FAST = { ackTimeoutMs: 200, requestTimeoutMs: 400, backoffMinMs: 20, backoffMaxMs: 60 };

// ---------------------------------------------------------------------------
// The constraint the whole architecture rests on
// ---------------------------------------------------------------------------

test('subscribe and snapshot use separate connections', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());
  await client.start();

  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));

  const conns = new Set(fake.requests.map((r) => r.conn));
  assert.equal(
    conns.size,
    fake.requests.length,
    'herdr accepts one request per connection; every request needs its own socket',
  );
  assert.ok(fake.requests.some((r) => r.method === 'events.subscribe'));
  assert.ok(fake.requests.some((r) => r.method === 'session.snapshot'));
});

test('subscribe is sent before the snapshot', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());
  await client.start();
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'session.snapshot'));

  const subIdx = fake.requests.findIndex((r) => r.method === 'events.subscribe');
  const snapIdx = fake.requests.findIndex((r) => r.method === 'session.snapshot');
  assert.ok(subIdx >= 0 && snapIdx > subIdx, 'a gap here loses transitions silently');
});

test('one status subscription is opened per agent pane', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(3) });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());
  await client.start();

  await fake.waitFor(
    () =>
      fake.requests.filter(
        (r) =>
          r.method === 'events.subscribe' &&
          JSON.stringify(r.params).includes('pane.agent_status_changed'),
      ).length === 3,
  );
});

// ---------------------------------------------------------------------------
// Events must not be lost at the edges
// ---------------------------------------------------------------------------

test('an event batched into the ack chunk is not dropped', async (t) => {
  const fake = await startFakeHerdr({
    snapshot: simpleSession(1),
    ackChunkFrame: frame('workspace_renamed', { workspace_id: 'w1', label: 'renamed' }),
  });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());

  const events: string[] = [];
  client.on('event', (f) => events.push(f.event));
  await client.start();

  await fake.waitFor(() => events.includes('workspace_renamed'), 1500);
});

test('events arriving before the seed are replayed after it', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());

  const order: string[] = [];
  client.on('seed', () => order.push('seed'));
  client.on('event', (f) => order.push(f.event));
  await client.start();
  await fake.waitFor(() => order.includes('seed'));

  assert.equal(order[0], 'seed', 'the seed rebuilds from scratch, so it must come first');
});

test('statuses are backfilled after subscriptions open', async (t) => {
  // The snapshot says idle; agent.list says blocked. The subscription only
  // reports future changes, so without a backfill the key would stay idle.
  const fake = await startFakeHerdr({
    snapshot: simpleSession(1),
    agents: [agent('w1:p1', 'w1', 'blocked')],
  });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());

  const seen: string[] = [];
  client.on('agents', (list) => {
    for (const a of list) seen.push(a.agent_status);
  });
  await client.start();

  await fake.waitFor(() => seen.includes('blocked'), 1500);
});

test('a live status change reaches the consumer', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());

  const seen: string[] = [];
  client.on('paneStatus', (s) => seen.push(s.status));
  await client.start();
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));

  fake.push(statusFrame('w1:p1', 'w1', 'blocked'));
  await fake.waitFor(() => seen.includes('blocked'));
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

test('a dropped stream reconnects and reseeds', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());

  let seeds = 0;
  let drops = 0;
  client.on('seed', () => seeds++);
  client.on('disconnected', () => drops++);
  await client.start();
  await fake.waitFor(() => seeds === 1);

  fake.dropAll();
  await fake.waitFor(() => drops >= 1, 2000);
  await fake.waitFor(() => seeds >= 2, 3000);
});

test('a global stream lost mid-connect still triggers a reconnect', async (t) => {
  // Regression guard for the latched `lost`.
  //
  // The drop lands after the first per-pane subscribe, killing the global
  // subscriber while connectOnce still has three panes and the backfill to go.
  // Those reopen on fresh connections and succeed, so connectOnce returns
  // normally -- and by then the global subscriber has already emitted its loss
  // to nobody. EventEmitter.emit with no listener is a silent no-op, so without
  // a latch the reconnect loop attaches to an emitter that will never fire
  // again and parks forever, holding stale colours with nothing logged.
  const fake = await startFakeHerdr({
    snapshot: simpleSession(4),
    dropAllAfterRequests: 3, // subscribe(global), snapshot, first pane subscribe
  });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());

  let drops = 0;
  client.on('disconnected', () => drops++);
  await client.start();

  await fake.waitFor(() => drops >= 1, 4000);
});

test('a subscribe that never acks fails rather than wedging', async (t) => {
  const fake = await startFakeHerdr({ stallSubscribe: true });
  t.after(() => fake.stop());

  const sub = new Subscriber(fake.path, [{ type: 'pane.updated' }], silentLogger, 't', 150);
  await assert.rejects(() => sub.start(), /ack timeout/);
});

test('a stalled daemon does not reset the backoff into a reconnect storm', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, {
    socketPath: fake.path,
    ackTimeoutMs: 200,
    requestTimeoutMs: 400,
    backoffMinMs: 30,
    backoffMaxMs: 1000,
    healthyAfterMs: 60_000, // nothing in this test ever counts as healthy
  });
  t.after(() => client.stop());

  const drops: number[] = [];
  client.on('disconnected', () => drops.push(Date.now()));
  // Kill the stream the moment it comes up, forever.
  client.on('seed', () => setTimeout(() => fake.dropAll(), 5));

  await client.start();
  await fake.waitFor(() => drops.length >= 4, 6000);

  const gaps = drops.slice(1).map((t2, i) => t2 - drops[i]!);
  assert.ok(
    gaps[gaps.length - 1]! > gaps[0]!,
    `backoff must grow against a sick daemon, saw gaps ${gaps.join()}`,
  );
});

// ---------------------------------------------------------------------------
// requestOnce
// ---------------------------------------------------------------------------

test('requestOnce rejects when the server closes without responding', async (t) => {
  const fake = await startFakeHerdr({ stallRequests: true });
  t.after(() => fake.stop());

  const p = requestOnce(fake.path, reqSnapshot('x'), silentLogger, 5000);
  await delay(20);
  fake.dropAll();
  await assert.rejects(p, /closed before responding/);
});

test('requestOnce rejects on timeout', async (t) => {
  const fake = await startFakeHerdr({ stallRequests: true });
  t.after(() => fake.stop());

  await assert.rejects(
    () => requestOnce(fake.path, reqSnapshot('x'), silentLogger, 100),
    /timed out/,
  );
});

test('requestOnce rejects an error envelope', async (t) => {
  const fake = await startFakeHerdr({ rejectSubscribe: 'nope' });
  t.after(() => fake.stop());

  const sub = new Subscriber(fake.path, [{ type: 'pane.updated' }], silentLogger, 't', 500);
  await assert.rejects(() => sub.start(), /nope/);
});

// ---------------------------------------------------------------------------
// Socket resolution
// ---------------------------------------------------------------------------

test('parseSessionList finds the socket for a named session', () => {
  const out = [
    'name       status   directory        socket',
    'default    running  /a               /a/herdr.sock',
    'micro      running  /b               /b/herdr.sock',
  ].join('\n');
  assert.equal(parseSessionList(out, 'micro'), '/b/herdr.sock');
  assert.equal(parseSessionList(out, 'absent'), null);
});

test('a burst of membership events collapses into few workspace.list reads', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());
  await client.start();
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));

  const before = fake.requests.filter((r) => r.method === 'workspace.list').length;
  for (let i = 0; i < 10; i++) fake.push(frame('workspace_created', { workspace_id: `x${i}` }));

  await fake.waitFor(
    () => fake.requests.filter((r) => r.method === 'workspace.list').length > before,
  );
  await delay(150);

  const reads = fake.requests.filter((r) => r.method === 'workspace.list').length - before;
  assert.ok(reads <= 2, `10 events should coalesce to at most 2 reads, saw ${reads}`);
});

test('pane subscriptions open concurrently, not one ack at a time', async (t) => {
  // Sequential opening cost one ack round trip per pane before the pad showed
  // anything -- and a full ackTimeoutMs each on a sick daemon, which is the
  // difference between a slow start and an apparently broken one.
  const fake = await startFakeHerdr({ snapshot: simpleSession(4), ackDelayMs: 150 });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, {
    socketPath: fake.path,
    ackTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    backoffMinMs: 20,
    backoffMaxMs: 60,
  });
  t.after(() => client.stop());

  const t0 = Date.now();
  await client.start();
  await fake.waitFor(
    () =>
      fake.requests.filter(
        (r) =>
          r.method === 'events.subscribe' &&
          JSON.stringify(r.params).includes('pane.agent_status_changed'),
      ).length === 4,
    3000,
  );
  const elapsed = Date.now() - t0;
  // Concurrent: ~1 ack delay. Serialised: 4+ of them.
  assert.ok(elapsed < 450, `four pane subscriptions serialised (${elapsed}ms)`);
});

test('a pane subscription failing during initial connect triggers a reconnect', async (t) => {
  // Regression guard for a latched loss one level above Subscriber. watchPane
  // runs inside connectOnce's Promise.all, so its failure is signalled before
  // the reconnect loop is waiting. Unlatched, that signal goes nowhere and the
  // client settles into a "connected" state with a pane that has no status
  // source -- every other key updating while that one holds its seed colour.
  const fake = await startFakeHerdr({ snapshot: simpleSession(2), failPaneSubscribe: true });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST });
  t.after(() => client.stop());

  let drops = 0;
  client.on('disconnected', () => drops++);
  await client.start();

  await fake.waitFor(() => drops >= 1, 4000);
});

// ---------------------------------------------------------------------------
// Self-healing: what the periodic authoritative refresh buys
// ---------------------------------------------------------------------------

test('agent.list is polled periodically, not only on events', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, {
    socketPath: fake.path,
    ...FAST,
    refreshIntervalMs: 60,
  });
  t.after(() => client.stop());
  await client.start();

  // No events at all -- purely the timer.
  await fake.waitFor(
    () => fake.requests.filter((r) => r.method === 'agent.list').length >= 3,
    3000,
  );
});

test('a subscription is opened for an agent that appears with no lifecycle event', async (t) => {
  const fake = await startFakeHerdr({
    snapshot: simpleSession(1),
    agents: [agent('w1:p1', 'w1', 'idle')],
  });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, {
    socketPath: fake.path,
    ...FAST,
    refreshIntervalMs: 60,
  });
  t.after(() => client.stop());
  await client.start();
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));

  // A second agent simply shows up in the list. herdr sent no
  // pane_agent_detected, which is exactly the case events cannot cover.
  fake.setAgents([agent('w1:p1', 'w1', 'idle'), agent('w2:p1', 'w2', 'working')]);

  await fake.waitFor(
    () =>
      fake.requests.some(
        (r) => r.method === 'events.subscribe' && JSON.stringify(r.params).includes('w2:p1'),
      ),
    3000,
  );
});

test('an agent that vanishes from the list has its subscription closed', async (t) => {
  const fake = await startFakeHerdr({
    snapshot: simpleSession(2),
    agents: [agent('w1:p1', 'w1', 'idle'), agent('w2:p1', 'w2', 'idle')],
  });
  t.after(() => fake.stop());

  const client = new HerdrClient(silentLogger, {
    socketPath: fake.path,
    ...FAST,
    refreshIntervalMs: 60,
  });
  t.after(() => client.stop());

  let drops = 0;
  client.on('disconnected', () => drops++);
  await client.start();
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));

  const before = fake.openConnections;
  fake.setAgents([agent('w1:p1', 'w1', 'idle')]);
  await fake.waitFor(() => fake.openConnections < before, 3000);

  assert.equal(drops, 0, 'closing a stale subscription must not look like a stream loss');
});
