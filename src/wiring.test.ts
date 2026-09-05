import assert from 'node:assert/strict';
import { test } from 'vitest';

import { Evt } from './herdr/rpc.js';
import { Store } from './state/store.js';
import {
  agent,
  clientBus,
  pane,
  silentLogger,
  snapshot,
  statusFrame,
  workspace,
} from './testing/fixtures.js';
import { wireClientToStore } from './wiring.js';

function seeded() {
  const store = new Store(silentLogger);
  const { client, emit } = clientBus();
  wireClientToStore(client, store);
  emit(
    'seed',
    snapshot([workspace('w1', 'herdr-micro')], [pane('w1:p1', 'w1', { agent: 'claude' })]),
  );
  return { store, emit };
}

test('a workspace rename reaches the store', () => {
  const { store, emit } = seeded();
  assert.equal(store.view()[0]?.label, 'herdr-micro/claude');

  emit('event', {
    event: Evt.workspaceRenamed,
    data: { workspace_id: 'w1', label: 'renamed' },
  });

  // The regression this module exists for: workspace.renamed is not a
  // MEMBERSHIP_EVENT, so nothing re-reads workspace.list to repair the label.
  // An entry point that skips route() shows the old name until it is closed.
  assert.equal(store.view()[0]?.label, 'renamed/claude');
});

test('a workspace.list reconcile reaches the store', () => {
  const { store, emit } = seeded();

  // Not the same path as workspace_renamed above: this is the authoritative
  // re-read the client emits after a MEMBERSHIP_EVENT, and it carries labels
  // for workspaces no rename event ever mentioned. Dropping this subscription
  // leaves every label frozen at whatever the seed said.
  emit('workspaces', [workspace('w1', 'reconciled')]);

  assert.equal(store.view()[0]?.label, 'reconciled/claude');
});

test('an agent.list refresh reaches the store', () => {
  const { store, emit } = seeded();

  // agent.list is the only authoritative source of membership, order and
  // status, and it is the sole self-healing path: a missed lifecycle event or
  // an agent that vanished without one is repaired here or not at all.
  // Dropping this subscription strands every key on its seed forever while
  // the daemon still looks healthy.
  emit('agents', [agent('w2:p9', 'w2', 'blocked', 'omp')]);

  assert.deepEqual(
    store.view().map((s) => s.paneId),
    ['w2:p9', null, null, null, null, null],
  );
  assert.equal(store.view()[0]?.status, 'blocked');
});

test('a pane moving workspace reaches the store', () => {
  const { store, emit } = seeded();

  emit('event', {
    event: Evt.workspaceRenamed,
    data: { workspace_id: 'w2', label: 'other' },
  });
  emit('event', {
    event: Evt.paneUpdated,
    data: { pane: pane('w1:p1', 'w2', { agent: 'claude' }) },
  });

  // Membership itself comes from agent.list; what applyPane carries is the
  // move, and the label has to follow the agent to its new workspace.
  assert.equal(store.view()[0]?.workspaceId, 'w2');
  assert.equal(store.view()[0]?.label, 'other/claude');
});

test('a closed pane is dropped from the store', () => {
  const { store, emit } = seeded();

  emit('event', { event: Evt.paneClosed, data: { pane_id: 'w1:p1' } });

  assert.deepEqual(
    store.view().map((s) => s.paneId),
    [null, null, null, null, null, null],
  );
});

test('pane status events reach the store', () => {
  const { store, emit } = seeded();

  emit('paneStatus', { paneId: 'w1:p1', status: 'blocked' });

  assert.equal(store.view()[0]?.status, 'blocked');
});

test('a disconnect blanks the row and is reported before it does', () => {
  const store = new Store(silentLogger);
  const { client, emit } = clientBus();
  const reasons: string[] = [];
  wireClientToStore(client, store, { onDisconnected: (r) => void reasons.push(r) });
  emit('seed', snapshot([workspace('w1')], [pane('w1:p1', 'w1', { agent: 'claude' })]));

  emit('disconnected', 'socket closed');

  assert.deepEqual(reasons, ['socket closed']);
  assert.deepEqual(
    store.view().map((s) => s.status),
    ['idle', null, null, null, null, null],
  );
});

test('every frame that reaches the store is counted once', () => {
  const store = new Store(silentLogger);
  const { client, emit } = clientBus();
  let frames = 0;
  wireClientToStore(client, store, { onFrame: () => void frames++ });
  emit('seed', snapshot([workspace('w1')], [pane('w1:p1', 'w1', { agent: 'claude' })]));

  emit('event', statusFrame('w1:p1', 'w1', 'working'));
  emit('paneStatus', { paneId: 'w1:p1', status: 'done' });
  // The seed is a snapshot, not a frame, so it must not be counted.
  assert.equal(frames, 2);
});
