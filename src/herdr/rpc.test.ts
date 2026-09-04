import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GLOBAL_SUBSCRIPTIONS,
  isAgentStatus,
  KEY_INTERRUPT,
  paneStatusSubscription,
  reqAgentSendKeys,
  reqSubscribe,
  reqWorkspaceReportMetadata,
} from './rpc.js';

test('there is no error status; all five real ones are accepted', () => {
  for (const s of ['idle', 'working', 'blocked', 'done', 'unknown']) {
    assert.ok(isAgentStatus(s), s);
  }
  // The MVP document assumed an `error` state that herdr does not have.
  assert.equal(isAgentStatus('error'), false);
});

test('the global subscription set excludes unusable status sources', () => {
  const types = GLOBAL_SUBSCRIPTIONS.map((s) => s.type);
  // workspace.updated never fires on agent-status change; pane.agent_status_changed
  // needs a pane_id and so cannot live in the global set.
  assert.ok(!types.includes('workspace.updated' as never));
  assert.ok(!types.includes('pane.agent_status_changed' as never));
  assert.ok(types.includes('pane.updated'));
});

test('per-pane status subscriptions carry the pane id', () => {
  assert.deepEqual(paneStatusSubscription('w1:p1'), [
    { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
  ]);
});

test('request builders emit the documented wire methods', () => {
  assert.equal(reqSubscribe('a', []).method, 'events.subscribe');
  assert.equal(reqAgentSendKeys('a', 'x', [KEY_INTERRUPT]).method, 'agent.send_keys');
  assert.equal(KEY_INTERRUPT, 'ctrl+c');
  const meta = reqWorkspaceReportMetadata('a', 'w1', 'herdr-micro', { slot: '3' });
  assert.equal(meta.method, 'workspace.report_metadata');
  assert.deepEqual(meta.params.tokens, { slot: '3' });
});
