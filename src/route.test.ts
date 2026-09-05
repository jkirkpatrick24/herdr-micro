import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderRow, route } from './route.js';
import { Store } from './state/store.js';
import { silentLogger, simpleSession, workspace } from './testing/fixtures.js';

const newStore = () => {
  const s = new Store(silentLogger, { settleMs: 20 });
  s.applySeed(simpleSession(2));
  return s;
};
const panes = (s: Store) => s.view().map((v) => v.paneId);

test('membership events are ignored; agent.list is authoritative', () => {
  const store = newStore();
  const before = panes(store).slice(0, 3);

  // herdr replays historical creates and closes out of order on subscribe, so
  // applying them directly can resurrect something long dead onto a key.
  route(store, 'workspace_created', { workspace: workspace('zombie', 'zombie', 9) });
  route(store, 'workspace_closed', { workspace_id: 'w1' });
  route(store, 'workspace_reordered', { workspace_ids: ['w2', 'w1'] });

  assert.deepEqual(panes(store).slice(0, 3), before, 'events must not mutate membership');
});

test('workspace_renamed relabels every agent in that workspace', () => {
  const store = newStore();
  route(store, 'workspace_renamed', { workspace_id: 'w1', label: 'fix-auth' });
  assert.equal(store.view()[0]?.label, 'fix-auth/claude');
});

test('pane_exited drops that agent key', () => {
  const store = newStore();
  store.applyPaneStatus('w1:p1', 'blocked');
  route(store, 'pane_exited', { pane_id: 'w1:p1' });
  assert.deepEqual(panes(store).slice(0, 2), ['w2:p1', null]);
});

test('unknown and malformed events are ignored safely', () => {
  const store = newStore();
  const before = JSON.stringify(store.view());
  route(store, 'something_else', {});
  route(store, 'workspace_created', {});
  route(store, 'pane_updated', {});
  assert.equal(JSON.stringify(store.view()), before);
});

test('renderRow shows agent labels and marks empty slots', () => {
  const store = newStore();
  const row = renderRow(store.view());
  assert.match(row, /ws-1\/claude/);
  assert.ok(row.includes('[ -'), 'empty slots must be visibly empty');
});
