import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import type { Logger } from '../log.js';
import { agent, pane, silentLogger, snapshot, workspace } from '../testing/fixtures.js';
import { type SlotView, Store, type Transition } from './store.js';

const SETTLE = 20;
const newStore = () => new Store(silentLogger, { settleMs: SETTLE });

const statuses = (v: SlotView[]) => v.map((s) => s.status);
const panes = (v: SlotView[]) => v.map((s) => s.paneId);
const labels = (v: SlotView[]) => v.map((s) => s.label);

/** Two agents in one workspace, plus one in another -- the real shape. */
function mixedSession() {
  return snapshot(
    [workspace('w1', 'herdr-micro'), workspace('w2', 'test-alpha', 2)],
    [
      pane('w1:p1', 'w1', { agent: 'claude' }),
      pane('w1:p2', 'w1', { agent: 'omp' }),
      pane('w2:p1', 'w2', { agent: 'pi' }),
      pane('w2:p9', 'w2', { agent: null }), // a plain shell pane, never a key
    ],
  );
}

// ---------------------------------------------------------------------------
// Agents, not workspaces
// ---------------------------------------------------------------------------

test('each agent gets its own key, including two in one workspace', () => {
  const store = newStore();
  store.applySeed(mixedSession());

  assert.deepEqual(panes(store.view()).slice(0, 4), ['w1:p1', 'w1:p2', 'w2:p1', null]);
  assert.deepEqual(labels(store.view()).slice(0, 3), [
    'herdr-micro/claude',
    'herdr-micro/omp',
    'test-alpha/pi',
  ]);
});

test('two agents in one workspace hold independent statuses', () => {
  const store = newStore();
  store.applySeed(mixedSession());

  store.applyPaneStatus('w1:p1', 'blocked');
  store.applyPaneStatus('w1:p2', 'working');

  // The whole point of agent keys: neither masks the other.
  assert.deepEqual(statuses(store.view()).slice(0, 3), ['blocked', 'working', 'idle']);
});

test('a shell pane never occupies a key', () => {
  const store = newStore();
  store.applySeed(mixedSession());
  assert.ok(!panes(store.view()).includes('w2:p9'));

  // And a status event for a non-agent pane is ignored rather than creating one.
  store.applyPaneStatus('w2:p9', 'working');
  assert.ok(!panes(store.view()).includes('w2:p9'));
});

// ---------------------------------------------------------------------------
// Slot stability -- a key must not move while the user is reaching for it
// ---------------------------------------------------------------------------

test('slots do not move on a status change', () => {
  const store = newStore();
  store.applySeed(mixedSession());
  const before = panes(store.view());

  store.applyPaneStatus('w2:p1', 'blocked');
  store.applyPaneStatus('w1:p1', 'done');

  assert.deepEqual(panes(store.view()), before);
});

test('agent.list is authoritative for membership and order', () => {
  const store = newStore();
  store.applySeed(mixedSession());

  store.applyAgents([
    agent('w2:p1', 'w2', 'working', 'pi'),
    agent('w1:p1', 'w1', 'idle', 'claude'),
  ]);

  assert.deepEqual(panes(store.view()).slice(0, 3), ['w2:p1', 'w1:p1', null]);
  assert.equal(statuses(store.view())[0], 'working');
});

test('only the first six agents are displayed', () => {
  const store = newStore();
  store.applyAgents(Array.from({ length: 8 }, (_, i) => agent(`w1:p${i}`, 'w1', 'idle', 'claude')));
  assert.equal(store.view().length, 6);
  assert.deepEqual(panes(store.view()), ['w1:p0', 'w1:p1', 'w1:p2', 'w1:p3', 'w1:p4', 'w1:p5']);
});

test('overflow is reported once, not on every refresh, and re-arms after it clears', () => {
  const warnings: Array<Record<string, unknown> | undefined> = [];
  const log: Logger = { info() {}, warn: (_m, fields) => void warnings.push(fields), error() {} };
  const store = new Store(log, { settleMs: SETTLE });
  const listOf = (n: number) =>
    Array.from({ length: n }, (_, i) => agent(`w1:p${i}`, 'w1', 'idle', 'claude'));

  store.applyAgents(listOf(8));
  store.applyAgents(listOf(8));

  // agent.list refreshes every couple of seconds forever; warning per pass
  // would bury every other line in the log.
  assert.equal(warnings.length, 1, 'the same overflow must not be re-reported');
  assert.deepEqual(warnings[0], { agents: 8, slots: 6, hidden: 2 });

  // Dropping back within the slot count re-arms it, so a later overflow is
  // reported rather than swallowed by the first one having already fired.
  store.applyAgents(listOf(3));
  store.applyAgents(listOf(7));

  assert.equal(warnings.length, 2, 'a fresh overflow after a quiet period is news again');
  assert.deepEqual(warnings[1], { agents: 7, slots: 6, hidden: 1 });
});

test('an overflow cleared by closing panes re-arms the warning too', () => {
  const warnings: Array<Record<string, unknown> | undefined> = [];
  const log: Logger = { info() {}, warn: (_m, fields) => void warnings.push(fields), error() {} };
  const store = new Store(log, { settleMs: SETTLE });
  const listOf = (n: number) =>
    Array.from({ length: n }, (_, i) => agent(`w1:p${i}`, 'w1', 'idle', 'claude'));

  store.applyAgents(listOf(8));
  assert.equal(warnings.length, 1, 'the overflow is reported');

  // Panes closing is the ordinary way an overflow clears, and it goes through
  // removePane rather than agent.list. That path did not re-arm the warning,
  // so the next overflow was swallowed by the first one having already fired.
  store.removePane('w1:p7');
  store.removePane('w1:p6');
  store.applyAgents(listOf(8));

  assert.equal(warnings.length, 2, 'the overflow that came back is news again');
  assert.deepEqual(warnings[1], { agents: 8, slots: 6, hidden: 2 });
});

// ---------------------------------------------------------------------------
// unknown-settling -- the anti-flicker measure
// ---------------------------------------------------------------------------

test('brief unknown holds the previous colour', async () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'working');

  store.applyPaneStatus('w1:p1', 'unknown');
  assert.equal(store.view()[0]?.status, 'working', 'unknown must not repaint immediately');

  store.applyPaneStatus('w1:p1', 'working');
  await delay(SETTLE * 3);
  assert.equal(store.view()[0]?.status, 'working', 'a resolved unknown must not settle later');
});

test('sustained unknown settles to idle', async () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'working');
  store.applyPaneStatus('w1:p1', 'unknown');

  await delay(SETTLE * 3);
  assert.equal(store.view()[0]?.status, 'idle');
});

test('sustained unknown preserves done rather than eating the notification', async () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'done');
  store.applyPaneStatus('w1:p1', 'unknown');

  await delay(SETTLE * 3);
  assert.equal(store.view()[0]?.status, 'done');
});

test('settling one agent does not disturb its neighbour', async () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'working');
  store.applyPaneStatus('w1:p2', 'blocked');

  store.applyPaneStatus('w1:p1', 'unknown');
  await delay(SETTLE * 3);

  assert.deepEqual(statuses(store.view()).slice(0, 2), ['idle', 'blocked']);
});

// ---------------------------------------------------------------------------
// The dedupe gate
// ---------------------------------------------------------------------------

test('changed fires only when the rendered view differs', () => {
  const store = newStore();
  let changes = 0;
  store.on('changed', () => changes++);

  store.applySeed(mixedSession());
  const afterSeed = changes;

  for (let i = 0; i < 100; i++) {
    store.applyPane(pane('w1:p1', 'w1', { agent: 'claude', revision: i + 2 }));
  }
  assert.equal(changes, afterSeed, 'identical frames must not repaint');

  store.applyPaneStatus('w1:p1', 'blocked');
  assert.equal(changes, afterSeed + 1, 'a real change must repaint exactly once');
});

test('pane.updated never applies status', () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'idle');

  store.applyPane(pane('w1:p1', 'w1', { agent: 'claude', status: 'blocked', revision: 50 }));
  assert.equal(store.view()[0]?.status, 'idle', 'a 10 Hz sample must not set status');
});

// ---------------------------------------------------------------------------
// Stale colour across a gap
// ---------------------------------------------------------------------------

test('disconnect paints every key idle', () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'blocked');
  store.applyPaneStatus('w1:p2', 'working');

  store.setDisconnected();
  assert.deepEqual(statuses(store.view()).slice(0, 2), ['idle', 'idle']);
  assert.deepEqual(panes(store.view()).slice(0, 2), ['w1:p1', 'w1:p2'], 'labels survive');
});

test('no colour survives a reconnect and reseed', () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'blocked');

  store.setDisconnected();
  store.applySeed(mixedSession());

  assert.equal(store.view()[0]?.status, 'idle');
});

test('the first transition after a reseed is dated from the reseed, not from before the outage', async () => {
  const store = newStore();
  const seen: Transition[] = [];
  const OUTAGE = 40;

  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'working');
  await delay(OUTAGE);

  store.on('transition', (t: Transition) => seen.push(t));
  store.setDisconnected();
  store.applySeed(mixedSession());

  // The reseed itself is silent: every agent is rebuilt from scratch at idle,
  // so there is no change to narrate. Asserting only over what the reseed emits
  // therefore asserts over nothing at all.
  assert.equal(seen.length, 0, 'a rebuild is not a transition');

  // The cleared statusSince is observable only on the NEXT real change. A
  // surviving entry would date this from before the outage and write that
  // fabricated duration into metrics.jsonl on every single reconnect.
  store.applyPaneStatus('w1:p1', 'blocked');

  assert.equal(seen.length, 1, 'a real change after the reseed still reports');
  assert.ok(
    seen[0]!.durationMs < OUTAGE / 2,
    `duration ${seen[0]!.durationMs}ms spans the ${OUTAGE}ms outage`,
  );
});

test('a reseed carrying a non-idle status is still not a transition', () => {
  const store = newStore();
  const seen: Transition[] = [];
  store.on('transition', (t: Transition) => seen.push(t));

  // The status arrives WITH the snapshot, which is the case the all-idle
  // fixture above cannot reach: applySeed builds the agent at idle and then
  // hands it this, so a naive commit reads the rebuild as a change and writes
  // one fabricated `idle -> working, 0ms` row per non-idle agent, every
  // reconnect, into the file that answers how often an agent blocks.
  const working = snapshot(
    [workspace('w1', 'herdr-micro')],
    [pane('w1:p1', 'w1', { agent: 'claude', status: 'working' })],
  );

  store.applySeed(working);
  assert.equal(seen.length, 0, 'the first seed narrates nothing');
  assert.equal(store.view()[0]?.status, 'working', 'but the status still reaches the key');

  store.setDisconnected();
  store.applySeed(working);
  assert.equal(seen.length, 0, 'and neither does a reconnect');

  // Silence at the seed must not cost the next real change its `from`.
  store.applyPaneStatus('w1:p1', 'blocked');
  assert.equal(seen.length, 1, 'a real change after the reseed still reports');
  assert.equal(seen[0]?.from, 'working', 'dated from the state the seed established');
});

test('an agent seeded idle is dated from the seed, not from its first change', async () => {
  const store = newStore();
  const seen: Transition[] = [];
  store.on('transition', (t: Transition) => seen.push(t));
  const IDLE_FOR = 40;

  // The case the non-idle fixture above cannot reach. applySeed builds every
  // agent at `idle` and then hands it its real status, so an agent herdr
  // reports as idle is committed a status it already holds -- and that commit
  // is the only chance it gets to be dated. Left unstamped, `since ?? now`
  // dated the first real change from the change itself and every idle->working
  // row in metrics.jsonl read 0ms, zeroing exactly the durations the file is
  // kept to measure.
  store.applySeed(mixedSession());
  await delay(IDLE_FOR);
  store.applyPaneStatus('w1:p1', 'working');

  assert.equal(seen.length, 1, 'the change after the seed still reports');
  assert.ok(
    seen[0]!.durationMs >= IDLE_FOR / 2,
    `idle duration ${seen[0]!.durationMs}ms does not span the ${IDLE_FOR}ms it was idle for`,
  );
});

// ---------------------------------------------------------------------------
// Authoritative reconciliation
// ---------------------------------------------------------------------------

test('an agent vanishing from agent.list clears its key', async () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'working');
  store.applyPaneStatus('w1:p2', 'working');

  // w1:p2 is gone from the list, with no pane_exited to announce it.
  store.applyAgents([agent('w1:p1', 'w1', 'working', 'claude')]);

  await delay(SETTLE * 3);
  assert.deepEqual(panes(store.view()).slice(0, 2), ['w1:p1', null]);
  assert.equal(statuses(store.view())[0], 'working', 'the surviving agent is untouched');
});

test('a vanished agent that was done keeps its unseen completion until it drops', async () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'done');

  // Still listed, but herdr can no longer classify it.
  store.applyPaneStatus('w1:p1', 'unknown');
  await delay(SETTLE * 3);
  assert.equal(store.view()[0]?.status, 'done', 'an unseen completion is still worth showing');
});

test('a closed pane drops its key immediately', () => {
  const store = newStore();
  store.applySeed(mixedSession());
  store.applyPaneStatus('w1:p1', 'blocked');

  store.removePane('w1:p1');
  assert.deepEqual(panes(store.view()).slice(0, 2), ['w1:p2', 'w2:p1']);
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test('workspace labels resolve and follow renames', () => {
  const store = newStore();
  store.applySeed(mixedSession());
  assert.equal(store.view()[0]?.label, 'herdr-micro/claude');

  store.renameWorkspace('w1', 'fix-auth');
  assert.equal(store.view()[0]?.label, 'fix-auth/claude');
  assert.equal(store.view()[1]?.label, 'fix-auth/omp', 'both agents follow the rename');
});

test('an agent moved to an unlabelled workspace stops naming the old one', () => {
  const store = newStore();
  store.applySeed(mixedSession());
  assert.equal(store.view()[0]?.label, 'herdr-micro/claude');

  // The agent is now in w3, which no workspace.list has described yet. Keeping
  // the label already held would name herdr-micro -- a workspace this agent has
  // left -- which reads as correct and is not. The id is the honest answer.
  store.applyAgents([agent('w1:p1', 'w3', 'working')]);
  assert.equal(store.view()[0]?.label, 'w3/claude');

  store.applyWorkspaces([workspace('w3', 'fix-auth', 3)]);
  assert.equal(store.view()[0]?.label, 'fix-auth/claude', 'and repairs when the label lands');
});

test('an agent in an unlabelled workspace falls back to the id', () => {
  const store = newStore();
  store.applyAgents([agent('w9:p1', 'w9', 'idle', 'claude')]);
  assert.equal(store.view()[0]?.label, 'w9/claude');

  store.applyWorkspaces([workspace('w9', 'late-label', 9)]);
  assert.equal(store.view()[0]?.label, 'late-label/claude');
});
