import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';

import { Coalescer, reason } from './log.js';

/**
 * A job the test finishes by hand. Each call records that it started and parks
 * until released, so "how many passes ran" is observable without timing.
 */
function controllableJob() {
  let release: (() => void) | null = null;
  let starts = 0;
  const job = () => {
    starts++;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  return {
    job,
    /** Read as a function: a getter pulled out by a spread freezes at zero. */
    starts: () => starts,
    finish() {
      const done = release;
      assert.ok(done, 'no pass is in flight to finish');
      release = null;
      done();
      // Two turns: one for the awaiting `run` to resume, one for the loop to
      // re-enter fn() before the next assertion reads `starts`.
      return delay(0);
    },
  };
}

test('a burst of triggers during one pass collapses into exactly one rerun', async () => {
  const gate = new Coalescer();
  const { job, finish, starts } = controllableJob();

  const first = gate.run(job);
  assert.equal(starts(), 1, 'the first trigger runs straight away');

  // The real shape: ten lifecycle events land while one agent.list is in
  // flight. Each must be absorbed, not queued.
  for (let i = 0; i < 10; i++) await gate.run(job);
  assert.equal(starts(), 1, 'nothing starts while a pass is running');

  await finish();
  assert.equal(starts(), 2, 'ten triggers cost one extra pass, not ten');

  await finish();
  await first;
  assert.equal(starts(), 2, 'and the rerun does not itself schedule another');
});

test('a trigger arriving during the rerun earns one more pass, not a spin', async () => {
  const gate = new Coalescer();
  const { job, finish, starts } = controllableJob();

  const first = gate.run(job);
  await gate.run(job); // collapses into the rerun below
  await finish();
  assert.equal(starts(), 2);

  // Arriving mid-rerun, this is genuinely new information and has to be seen.
  await gate.run(job);
  await finish();
  assert.equal(starts(), 3);

  await finish();
  await first;
  assert.equal(starts(), 3, 'the gate settles rather than looping forever');
});

test('the rerun runs the job asked for last, not the one already running', async () => {
  const gate = new Coalescer();
  const ran: string[] = [];
  let release: (() => void) | null = null;

  const parking = (name: string) => () => {
    ran.push(name);
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };

  const finish = async () => {
    const done = release;
    assert.ok(done, 'no pass is in flight to finish');
    release = null;
    done();
    await delay(0);
  };

  const first = gate.run(parking('first'));

  // Both gates in the client close over a connection generation, so a job made
  // for a newer one is not the same work as the job already running. Re-running
  // 'first' would drop the newer request and then bow out as stale -- which is
  // how a stream lost mid-refresh could skip its post-seed agent backfill.
  await gate.run(parking('second'));
  await gate.run(parking('third'));
  assert.deepEqual(ran, ['first'], 'nothing starts while a pass is running');

  await finish();
  // 'second' is superseded rather than queued behind: it would read the same
  // state 'third' does, so running it first is a wasted round trip.
  assert.deepEqual(ran, ['first', 'third']);

  await finish();
  await first;
  assert.deepEqual(ran, ['first', 'third'], 'the gate settles rather than looping');
});

test('the gate reopens once idle', async () => {
  const gate = new Coalescer();
  const { job, finish, starts } = controllableJob();

  const first = gate.run(job);
  await finish();
  await first;

  // A Coalescer is long-lived -- one per client, reused for the daemon's whole
  // run -- so a pass that ends must leave it usable rather than latched shut.
  const second = gate.run(job);
  assert.equal(starts(), 2);
  await finish();
  await second;
});

test('a throwing pass releases the gate instead of wedging it shut', async () => {
  const gate = new Coalescer();
  let runs = 0;

  await assert.rejects(
    () =>
      gate.run(async () => {
        runs++;
        throw new Error('agent.list refused');
      }),
    /agent.list refused/,
  );

  // The callers here already catch their own errors, but a gate that stayed
  // shut on a throw would silently stop every later refresh -- the daemon would
  // keep running and simply never self-heal again.
  await gate.run(async () => {
    runs++;
  });
  assert.equal(runs, 2);
});

test('reason unwraps an Error and stringifies anything else', () => {
  // Every warn() in the daemon routes through this, including rejections from
  // sockets and node-hid, which are not always Errors.
  assert.equal(reason(new Error('socket closed')), 'socket closed');
  assert.equal(reason(new TypeError('bad argument')), 'bad argument');
  assert.equal(reason('herdr is not running'), 'herdr is not running');
  assert.equal(reason(undefined), 'undefined');
  assert.equal(reason(null), 'null');
  assert.equal(reason(7), '7');
});
