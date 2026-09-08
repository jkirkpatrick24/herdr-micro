import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { asArray, isRecord } from '../json.js';
import type { Logger } from '../log.js';
import { type FakeOptions, type FakeRequest, startFakeHerdr } from '../testing/fake-herdr.js';
import {
  agent,
  frame,
  pane,
  silentLogger,
  simpleSession,
  statusFrame,
} from '../testing/fixtures.js';
import {
  type ClientOptions,
  HerdrClient,
  parseSessionList,
  requestOnce,
  resolveSocketPath,
  Subscriber,
} from './client.js';
import { Evt, Key, reqSnapshot } from './rpc.js';

const FAST = { ackTimeoutMs: 200, requestTimeoutMs: 400, backoffMinMs: 20, backoffMaxMs: 60 };

/**
 * The pane ids named by a recorded events.subscribe request.
 *
 * Read out rather than asserted: `params` is a Record<string, unknown> off a
 * socket, and claiming `Array<{ pane_id?: string }>` from it meant the
 * assertions below were comparing against a shape nothing had checked.
 */
function subscribedPaneIds(req: FakeRequest | undefined): string[] {
  const ids: string[] = [];

  for (const entry of asArray(req?.params.subscriptions)) {
    if (isRecord(entry) && typeof entry.pane_id === 'string') ids.push(entry.pane_id);
  }

  return ids;
}

/**
 * A fake herdr and a client aimed at it, torn down in the right order. Left
 * unstarted: the seed, the status backfill and anything batched into the
 * subscribe ack are all emitted from inside start(), so a test that counts them
 * has to attach its listeners first. Tests that only watch what happens after
 * the connection is up use `connected` below instead.
 */
async function wired(
  t: { onTestFinished(fn: () => unknown): void },
  opts: FakeOptions = {},
  clientOpts: ClientOptions = {},
) {
  const fake = await startFakeHerdr(opts);
  t.onTestFinished(() => fake.stop());

  const client = new HerdrClient(silentLogger, { socketPath: fake.path, ...FAST, ...clientOpts });
  // Registered second, and before start() runs, so a throw in start() still
  // tears both down. Vitest runs these in reverse, so the client stops before
  // the server does; the other order would make the client reconnect against a
  // dead socket.
  t.onTestFinished(() => client.stop());

  return { fake, client };
}

/** The same pair, already started -- a client connected to a fresh fake herdr. */
async function connected(
  t: { onTestFinished(fn: () => unknown): void },
  opts: FakeOptions = {},
  clientOpts: ClientOptions = {},
) {
  const { fake, client } = await wired(t, opts, clientOpts);
  await client.start();
  return { fake, client };
}

// ---------------------------------------------------------------------------
// The constraint the whole architecture rests on
// ---------------------------------------------------------------------------

test('subscribe and snapshot use separate connections', async (t) => {
  const { fake } = await connected(t, { snapshot: simpleSession(1) });

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

test('a second request on one connection closes it, taking any subscription', async (t) => {
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.onTestFinished(() => fake.stop());

  // Measured against herdr 0.8.2 (tools/herdr-probe.mjs): a socket that
  // receives a second request is closed ~95ms later. A control socket on the
  // same subscriptions, sending nothing further, stayed open for the whole run.
  // So multiplexing does not merely fail -- it destroys the subscription. This
  // is why Subscriber is one connection per subscription set.
  const socket = net.createConnection(fake.path);
  t.onTestFinished(() => {
    socket.destroy();
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.resume(); // a paused socket buffers the reply and never emits close

  socket.write(`${JSON.stringify({ id: 'a', method: 'workspace.list', params: {} })}\n`);
  await fake.waitFor(() => fake.requests.length === 1);
  socket.write(`${JSON.stringify({ id: 'b', method: 'agent.list', params: {} })}\n`);

  await closed;
  assert.equal(fake.requests.length, 1, 'the second request is never processed');
});

test('subscribe is sent before the snapshot', async (t) => {
  const { fake } = await connected(t, { snapshot: simpleSession(1) });
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'session.snapshot'));

  const subIdx = fake.requests.findIndex((r) => r.method === 'events.subscribe');
  const snapIdx = fake.requests.findIndex((r) => r.method === 'session.snapshot');
  assert.ok(subIdx >= 0 && snapIdx > subIdx, 'a gap here loses transitions silently');
});

test('every agent pane shares one status subscription', async (t) => {
  // herdr accepts one pane.agent_status_changed entry per pane on a single
  // subscribe (tools/herdr-probe.mjs), so three agent panes cost one connection
  // rather than three. The pane_id is what routes a frame, not the socket.
  const { fake } = await connected(t, { snapshot: simpleSession(3) });

  const statusSubs = () =>
    fake.requests.filter(
      (r) =>
        r.method === 'events.subscribe' &&
        JSON.stringify(r.params).includes('pane.agent_status_changed'),
    );
  await fake.waitFor(() => statusSubs().length === 1);

  assert.deepEqual(
    subscribedPaneIds(statusSubs()[0]).sort(),
    ['w1:p1', 'w2:p1', 'w3:p1'],
    'the one subscription must name every agent pane',
  );
});

// ---------------------------------------------------------------------------
// Events must not be lost at the edges
// ---------------------------------------------------------------------------

test('an event batched into the ack chunk is not dropped', async (t) => {
  const { fake, client } = await wired(t, {
    snapshot: simpleSession(1),
    ackChunkFrame: frame('workspace_renamed', { workspace_id: 'w1', label: 'renamed' }),
  });

  const events: string[] = [];
  client.on('event', (f) => events.push(f.event));
  await client.start();

  await fake.waitFor(() => events.includes('workspace_renamed'), 1500);
});

test('events arriving before the seed are replayed after it', async (t) => {
  // The frame has to be batched into the subscribe ack to reach the client
  // while the snapshot request is still in flight, which is the only way to
  // put anything in the pending buffer at all. Without one, `order` holds
  // nothing but the seed and asserting it comes first asserts nothing --
  // dropping the buffer entirely and emitting straight through still passed.
  const { fake, client } = await wired(t, {
    snapshot: simpleSession(1),
    ackChunkFrame: frame('workspace_renamed', { workspace_id: 'w1', label: 'renamed' }),
  });

  const order: string[] = [];
  client.on('seed', () => order.push('seed'));
  client.on('event', (f) => order.push(f.event));
  await client.start();
  await fake.waitFor(() => order.includes('workspace_renamed'));

  // Ordering is the whole point: that frame describes state newer than the
  // snapshot, and applySeed rebuilds from scratch, so replaying it first
  // would have the rebuild quietly discard it and strand the stale label.
  assert.deepEqual(order, ['seed', 'workspace_renamed']);
});

test('statuses are backfilled after subscriptions open', async (t) => {
  // The snapshot says idle; agent.list says blocked. The subscription only
  // reports future changes, so without a backfill the key would stay idle.
  const { fake, client } = await wired(t, {
    snapshot: simpleSession(1),
    agents: [agent('w1:p1', 'w1', 'blocked')],
  });

  const seen: string[] = [];
  client.on('agents', (list) => {
    for (const a of list) seen.push(a.agent_status);
  });
  await client.start();

  await fake.waitFor(() => seen.includes('blocked'), 1500);
});

test('a live status change reaches the consumer', async (t) => {
  const { fake, client } = await wired(t, { snapshot: simpleSession(1) });

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
  const { fake, client } = await wired(t, { snapshot: simpleSession(1) });

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
  const { fake, client } = await wired(t, {
    snapshot: simpleSession(4),
    dropAllAfterRequests: 3, // subscribe(global), snapshot, first pane subscribe
  });

  let drops = 0;
  client.on('disconnected', () => drops++);
  await client.start();

  await fake.waitFor(() => drops >= 1, 4000);
});

test('a subscribe that never acks fails rather than wedging', async (t) => {
  const fake = await startFakeHerdr({ stallSubscribe: true });
  t.onTestFinished(() => fake.stop());

  const sub = new Subscriber(fake.path, [{ type: 'pane.updated' }], silentLogger, 't', 150);
  await assert.rejects(() => sub.start(), /ack timeout/);
});

test('a stalled daemon does not reset the backoff into a reconnect storm', async (t) => {
  const { fake, client } = await wired(
    t,
    { snapshot: simpleSession(1) },
    {
      backoffMinMs: 30,
      backoffMaxMs: 1000,
      healthyAfterMs: 60_000, // nothing in this test ever counts as healthy
    },
  );

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
  t.onTestFinished(() => fake.stop());

  const p = requestOnce(fake.path, reqSnapshot('x'), silentLogger, 5000);
  await delay(20);
  fake.dropAll();
  await assert.rejects(p, /closed before responding/);
});

test('requestOnce rejects on timeout', async (t) => {
  const fake = await startFakeHerdr({ stallRequests: true });
  t.onTestFinished(() => fake.stop());

  await assert.rejects(
    () => requestOnce(fake.path, reqSnapshot('x'), silentLogger, 100),
    /timed out/,
  );
});

test('requestOnce rejects an error envelope', async (t) => {
  const fake = await startFakeHerdr({ rejectSubscribe: 'nope' });
  t.onTestFinished(() => fake.stop());

  const sub = new Subscriber(fake.path, [{ type: 'pane.updated' }], silentLogger, 't', 500);
  await assert.rejects(() => sub.start(), /nope/);
});

// ---------------------------------------------------------------------------
// Pane input targets survive focus changes between a command and its submission
// ---------------------------------------------------------------------------

test('explicit pane input stays on the captured pane after focus changes or disappears', async (t) => {
  const { fake, client } = await connected(t, { currentPane: 'p-agent' });
  const target = await client.currentPaneId();
  assert.equal(target, 'p-agent');
  assert.ok(target);

  fake.setCurrentPane('p-other');
  await client.sendTextToPane(target, '/model');
  fake.setCurrentPane(null);
  await client.sendKeysToPane(target, [Key.enter]);

  // Inspect the real socket boundary, not a stubbed client method. Both writes
  // must reach the captured pane even though neither runs while it is focused.
  assert.deepEqual(
    fake.requests
      .filter((req) => req.method === 'pane.send_text' || req.method === 'pane.send_keys')
      .map(({ method, params }) => ({ method, params })),
    [
      { method: 'pane.send_text', params: { pane_id: 'p-agent', text: '/model' } },
      { method: 'pane.send_keys', params: { pane_id: 'p-agent', keys: [Key.enter] } },
    ],
  );
  assert.equal(fake.requests.filter((req) => req.method === 'pane.current').length, 1);
});

test('explicit pane keys propagate server-side key validation errors without focused input', async (t) => {
  const { client } = await connected(t, { currentPane: null });

  await assert.rejects(
    () => client.sendKeysToPane('p-agent', ['not-a-herdr-key']),
    /unsupported key/,
  );
});

test('explicit pane text propagates RPC refusal without focused input', async (t) => {
  const { client } = await connected(t, {
    currentPane: null,
    failMethods: ['pane.send_text'],
  });

  await assert.rejects(() => client.sendTextToPane('p-agent', 'hello'), /pane\.send_text refused/);
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

/**
 * Resolution reads process-wide environment and the real home directory, so
 * each case gets a throwaway HOME and a cleared set of HERDR_* vars, restored
 * afterwards. Vitest gives each test file its own worker process, so mutating
 * process.env here cannot reach another file's tests.
 */
function sandbox(t: { onTestFinished(fn: () => unknown): void }): string {
  const keys = ['HOME', 'HERDR_SOCKET_PATH', 'HERDR_SESSION', 'HERDR_BIN_PATH'];
  const saved = keys.map((k) => [k, process.env[k]] as const);
  t.onTestFinished(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const home = mkdtempSync(join(tmpdir(), 'hm-home-'));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  for (const k of keys) delete process.env[k];
  process.env.HOME = home;
  return home;
}

/** Captures the resolution log, which is the only evidence of which path won. */
function resolutions() {
  const info: Array<Record<string, unknown> | undefined> = [];
  const warn: Array<Record<string, unknown> | undefined> = [];
  const log: Logger = {
    info: (_m, f) => void info.push(f),
    warn: (_m, f) => void warn.push(f),
    error() {},
  };
  return { info, warn, log };
}

/** A stub `herdr` on PATH-free disk, printing one canned `session list` table. */
function stubHerdrBin(home: string, table: string): string {
  const bin = join(home, 'herdr-stub');
  writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${table}\nEOF\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test('HERDR_SOCKET_PATH wins outright, without consulting the session', async (t) => {
  const home = sandbox(t);
  process.env.HERDR_SOCKET_PATH = '/explicit/override.sock';
  // A session is named too, and one that WOULD resolve: if the override did not
  // short-circuit, this is the path that would win instead, silently pointing
  // the daemon at a different herdr than the operator asked for.
  process.env.HERDR_SESSION = 'micro';
  const dir = join(home, '.config', 'herdr', 'sessions', 'micro');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'herdr.sock'), '');
  const { log, info } = resolutions();

  assert.equal(await resolveSocketPath(log), '/explicit/override.sock');
  assert.deepEqual(info, [{ path: '/explicit/override.sock', via: 'HERDR_SOCKET_PATH' }]);
});

test('a named session resolves to the socket under its own session directory', async (t) => {
  const home = sandbox(t);
  process.env.HERDR_SESSION = 'micro';
  const dir = join(home, '.config', 'herdr', 'sessions', 'micro');
  mkdirSync(dir, { recursive: true });
  const sock = join(dir, 'herdr.sock');
  writeFileSync(sock, '');
  const { log, info } = resolutions();

  assert.equal(await resolveSocketPath(log), sock);
  // The `via` is not decoration. A daemon that resolves the wrong socket
  // connects, seeds zero workspaces and looks perfectly healthy, so the log
  // line is the only way to tell that case from an idle session.
  assert.deepEqual(info, [{ path: sock, via: 'HERDR_SESSION=micro' }]);
});

test('a named session with no socket file yet falls back to `herdr session list`', async (t) => {
  const home = sandbox(t);
  process.env.HERDR_SESSION = 'micro';
  // The session directory only exists once a named session has been created,
  // so its absence proves nothing -- the listing is what settles it.
  process.env.HERDR_BIN_PATH = stubHerdrBin(
    home,
    [
      'name       status   directory        socket',
      'default    running  /a               /a/herdr.sock',
      'micro      running  /b               /b/herdr.sock',
    ].join('\n'),
  );
  const { log, info, warn } = resolutions();

  assert.equal(await resolveSocketPath(log), '/b/herdr.sock');
  assert.deepEqual(info, [{ path: '/b/herdr.sock', via: 'herdr session list (micro)' }]);
  assert.deepEqual(warn, [], 'a session found by listing is not a degraded resolution');
});

test('a named session that resolves nowhere warns and falls back to the default path', async (t) => {
  const home = sandbox(t);
  process.env.HERDR_SESSION = 'micro';
  process.env.HERDR_BIN_PATH = join(home, 'no-such-herdr');
  const { log, info, warn } = resolutions();

  const fallback = join(home, '.config', 'herdr', 'herdr.sock');
  assert.equal(await resolveSocketPath(log), fallback);

  // Falling back silently is the trap: the daemon would come up against the
  // default session's socket while the operator believes it is on `micro`, and
  // every colour on the pad would belong to the wrong session.
  assert.deepEqual(warn, [
    { session: 'micro', tried: join(home, '.config', 'herdr', 'sessions', 'micro', 'herdr.sock') },
  ]);
  assert.deepEqual(info, [{ path: fallback, via: 'default path' }]);
});

test('an empty environment resolves the default path', async (t) => {
  const home = sandbox(t);
  const { log, info } = resolutions();

  const fallback = join(home, '.config', 'herdr', 'herdr.sock');
  assert.equal(await resolveSocketPath(log), fallback);
  assert.deepEqual(info, [{ path: fallback, via: 'default path' }]);
});

// ---------------------------------------------------------------------------
// Lifecycle events are triggers, and only when a refresh could say anything new
// ---------------------------------------------------------------------------

/**
 * Proving a frame did NOT cause a round trip needs a receipt, because a timed
 * pause only shows the request had not arrived *yet*. A membership event serves:
 * it runs on a different Coalescer to the agent refresh, so it cannot collapse
 * into one, and its `workspace.list` landing proves the frame before it had
 * already resolved into nothing. The refresh timer is pushed past the test's
 * lifetime so every request in the log is attributable to a pushed frame.
 */
async function quiesced(t: { onTestFinished(fn: () => unknown): void }) {
  const { fake } = await connected(
    t,
    { snapshot: simpleSession(1) },
    { refreshIntervalMs: 60_000 },
  );
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));

  let base = fake.requests.length;
  const since = () => fake.requests.slice(base).map((r) => r.method);
  /** Push the receipt, wait for it, and hand back everything since the mark. */
  const receipt = async () => {
    fake.push(frame('workspace_created', { workspace_id: 'w-receipt' }));
    await fake.waitFor(() => since().includes('workspace.list'));
    // A refresh racing in behind the receipt would still be a failure, so give
    // one a chance to land before reading the log.
    await delay(100);
    const seen = since();
    base = fake.requests.length;
    return seen;
  };
  return { fake, since, receipt, mark: () => void (base = fake.requests.length) };
}

test('a shell pane opening costs no agent.list round trip', async (t) => {
  const { fake, receipt } = await quiesced(t);

  // pane_created carries the whole pane record, so a pane with no agent is
  // filtered before it costs anything. Shell panes open and close constantly;
  // refreshing on each would put agent.list on the critical path of ordinary
  // terminal use, for a list that cannot have changed.
  fake.push(frame(Evt.paneCreated, { pane: pane('w1:p9', 'w1', { agent: null }) }));

  assert.deepEqual(await receipt(), ['workspace.list']);
});

test('a pane opening WITH an agent does refresh, so the filter is not a mute', async (t) => {
  const { fake, since } = await quiesced(t);

  fake.push(frame(Evt.paneCreated, { pane: pane('w1:p9', 'w1', { agent: 'claude' }) }));
  await fake.waitFor(() => since().includes('agent.list'));
});

test('pane_agent_detected refreshes even though it carries no pane record', async (t) => {
  const { fake, since } = await quiesced(t);

  // Unlike pane_created this frame has only ids, so there is nothing to filter
  // on -- and it always implies an agent, so it must never be filtered out.
  fake.push(frame(Evt.paneAgentDetected, { pane_id: 'w1:p9', workspace_id: 'w1' }));
  await fake.waitFor(() => since().includes('agent.list'));
});

test('a pane closing costs a round trip only if it held a status subscription', async (t) => {
  const { fake, receipt, since } = await quiesced(t);

  // w1:p9 never held an agent, so it was never in the watched set and
  // agent.list cannot have anything new to say about its exit.
  fake.push(frame(Evt.paneExited, { pane_id: 'w1:p9' }));
  assert.deepEqual(await receipt(), ['workspace.list']);

  // The watched pane is the receipt that this is a filter and not a mute: its
  // exit is exactly the case that must reach agent.list, or the key would hold
  // a dead agent's colour until the next timer pass.
  fake.push(frame(Evt.paneExited, { pane_id: 'w1:p1' }));
  await fake.waitFor(() => since().includes('agent.list'));
});

test('a protocol bump is reported rather than discovered later as a wrong colour', async (t) => {
  const fake = await startFakeHerdr({
    snapshot: { ...simpleSession(1), protocol: 999 },
  });
  t.onTestFinished(() => fake.stop());

  const warnings: Array<Record<string, unknown> | undefined> = [];
  const client = new HerdrClient(
    { info() {}, warn: (_m, f) => void warnings.push(f), error() {} },
    { socketPath: fake.path, ...FAST },
  );
  t.onTestFinished(() => client.stop());

  await client.start();
  await fake.waitFor(() => warnings.some((w) => w?.herdr === 999), 3000);

  // rpc.ts was verified against exactly one protocol version. A bump does not
  // necessarily break anything, which is precisely why it has to be announced:
  // otherwise the first sign is a key showing the wrong status weeks later.
  assert.ok(warnings.some((w) => w?.herdr === 999 && typeof w?.expected === 'number'));
});

test('a listener attached after the stream is already gone still hears the loss', async (t) => {
  const fake = await startFakeHerdr({});
  t.onTestFinished(() => fake.stop());

  const sub = new Subscriber(fake.path, [{ type: 'pane.updated' }], silentLogger, 't', 500);
  await sub.start();

  const losses: Error[] = [];
  fake.dropAll();
  // Wait for the loss to have already happened, then subscribe to it. Without
  // the latch this is a plain EventEmitter listener attached after the emit --
  // a silent no-op -- and the reconnect loop above it parks forever holding
  // stale colours with nothing logged. connectOnce hits this window whenever a
  // drop lands between the subscribe and the seed.
  await fake.waitFor(() => fake.openConnections === 0);
  await delay(50);
  sub.onLost((err) => losses.push(err));

  assert.equal(losses.length, 1, 'the loss must fire immediately, not wait for a second one');
});

test('a burst of membership events collapses into few workspace.list reads', async (t) => {
  const { fake } = await connected(t, { snapshot: simpleSession(1) });
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

test('connecting costs one status ack, not one per pane', async (t) => {
  // The fan-out this replaced paid an ack round trip per pane, and a full
  // ackTimeoutMs each on a sick daemon -- the difference between a slow start
  // and an apparently broken one. It opened them concurrently to hide that.
  // One subscription removes the problem rather than hiding it.
  const { fake, client } = await wired(
    t,
    { snapshot: simpleSession(4), ackDelayMs: 150 },
    { ackTimeoutMs: 2000, requestTimeoutMs: 2000 },
  );

  const t0 = Date.now();
  await client.start();
  await fake.waitFor(
    () =>
      fake.requests.some(
        (r) =>
          r.method === 'events.subscribe' &&
          JSON.stringify(r.params).includes('pane.agent_status_changed'),
      ),
    3000,
  );
  const elapsed = Date.now() - t0;
  // Two acks: the topology subscribe, then the status one. Not 4+.
  assert.ok(elapsed < 450, `status subscription took ${elapsed}ms; expected ~2 acks`);
});

test('a pane subscription failing during initial connect triggers a reconnect', async (t) => {
  // Regression guard for a latched loss one level above Subscriber. The status
  // subscribe runs inside connectOnce, so its failure is signalled before the
  // reconnect loop is waiting. Unlatched, that signal goes nowhere and the
  // client settles into a "connected" state with no status source at all --
  // every key holding its seed colour while the daemon looks healthy.
  const { fake, client } = await wired(t, { snapshot: simpleSession(2), failPaneSubscribe: true });

  let drops = 0;
  client.on('disconnected', () => drops++);
  await client.start();

  await fake.waitFor(() => drops >= 1, 4000);
});

// ---------------------------------------------------------------------------
// Self-healing: what the periodic authoritative refresh buys
// ---------------------------------------------------------------------------

test('agent.list is polled periodically, not only on events', async (t) => {
  const { fake } = await connected(t, { snapshot: simpleSession(1) }, { refreshIntervalMs: 60 });

  // No events at all -- purely the timer.
  await fake.waitFor(
    () => fake.requests.filter((r) => r.method === 'agent.list').length >= 3,
    3000,
  );
});

test('a subscription is opened for an agent that appears with no lifecycle event', async (t) => {
  const { fake } = await connected(
    t,
    { snapshot: simpleSession(1), agents: [agent('w1:p1', 'w1', 'idle')] },
    { refreshIntervalMs: 60 },
  );
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

test('an agent vanishing rebuilds the subscription without looking like a loss', async (t) => {
  // A pane cannot be dropped from a live subscription any more than one can be
  // added -- a second request closes the socket -- so the set shrinking means
  // the status connection is replaced. That deliberate close must not reach the
  // reconnect loop as a stream loss, or every agent exit would reseed the pad.
  const { fake, client } = await wired(
    t,
    {
      snapshot: simpleSession(2),
      agents: [agent('w1:p1', 'w1', 'idle'), agent('w2:p1', 'w2', 'idle')],
    },
    { refreshIntervalMs: 60 },
  );

  let drops = 0;
  client.on('disconnected', () => drops++);
  await client.start();

  const statusSubs = () =>
    fake.requests.filter(
      (r) =>
        r.method === 'events.subscribe' &&
        JSON.stringify(r.params).includes('pane.agent_status_changed'),
    );
  await fake.waitFor(() => statusSubs().length === 1);

  fake.setAgents([agent('w1:p1', 'w1', 'idle')]);
  await fake.waitFor(() => statusSubs().length === 2, 3000);

  assert.deepEqual(
    subscribedPaneIds(statusSubs().at(-1)),
    ['w1:p1'],
    'the rebuilt subscription must drop the vanished pane',
  );
  assert.equal(drops, 0, 'a deliberate rebuild must not look like a stream loss');
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('a stopped client refuses to restart instead of silently not connecting', async (t) => {
  const warnings: string[] = [];
  const fake = await startFakeHerdr({ snapshot: simpleSession(1) });
  t.onTestFinished(() => fake.stop());
  const client = new HerdrClient(
    { ...silentLogger, warn: (m) => void warnings.push(m) },
    { socketPath: fake.path, ...FAST },
  );
  t.onTestFinished(() => client.stop());

  await client.start();
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));
  const before = fake.connections;

  client.stop();
  await client.start();
  await delay(60);

  // The failure this guards is a start() that returns normally and then never
  // connects, leaving a client that looks healthy and holds nothing.
  assert.equal(fake.connections, before, 'a restarted client must not reconnect');
  assert.ok(
    warnings.some((w) => w.includes('cannot be restarted')),
    `expected a restart warning, got ${JSON.stringify(warnings)}`,
  );
});

test('an oversized frame is dropped and the stream resyncs at the next newline', async (t) => {
  const { fake, client } = await wired(t, { snapshot: simpleSession(1) });
  const seen: string[] = [];
  client.on('event', (f) => void seen.push(f.event));

  await client.start();
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));

  // One frame far past the cap, unterminated, then its tail, then a real frame
  // behind it. The tail must be discarded rather than parsed as a frame of its
  // own, and the real frame must still arrive.
  fake.pushRaw(`{"event":"junk","data":{"pad":"${'x'.repeat(1_100_000)}`);
  fake.pushRaw('"}}\n');
  fake.push(frame(Evt.paneUpdated, { pane: pane('w1:p1', 'w1') }));

  await fake.waitFor(() => seen.includes(Evt.paneUpdated));
  assert.ok(!seen.includes('junk'), 'the oversized frame must not be delivered');
});

test('a focused pane is announced without costing an agent.list', async (t) => {
  const fake = await startFakeHerdr({ agents: [agent('p1', 'w1', 'idle')] });
  t.onTestFinished(() => fake.stop());
  const client = new HerdrClient(silentLogger, {
    socketPath: fake.path,
    ackTimeoutMs: 200,
    requestTimeoutMs: 400,
    refreshIntervalMs: 60_000,
  });
  t.onTestFinished(() => client.stop());

  let moves = 0;
  client.on('focus', () => void moves++);
  await client.start();
  await fake.waitFor(() => fake.requests.some((r) => r.method === 'agent.list'));
  const listed = fake.requests.filter((r) => r.method === 'agent.list').length;

  fake.push({ event: 'pane_focused', data: { pane_id: 'p1', workspace_id: 'w1' } });
  for (let i = 0; i < 8; i++) await delay(5);

  assert.equal(moves, 1, 'the event reaches its consumer');
  assert.equal(
    fake.requests.filter((r) => r.method === 'agent.list').length,
    listed,
    'and costs no round trip: focus moves far too often to spend one on each',
  );
});
