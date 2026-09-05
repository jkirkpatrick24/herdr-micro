import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  eventName,
  GLOBAL_SUBSCRIPTIONS,
  isAgentInfo,
  isAgentStatus,
  isErrorResponse,
  isEventFrame,
  isHerdrKey,
  isPaneInfo,
  isResultResponse,
  isTabInfo,
  isWorkspaceInfo,
  PageKey,
  paneStatusSubscription,
  parseSnapshot,
  reqPaneSendKeys,
  reqPaneSendText,
  reqSubscribe,
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
  assert.ok(!types.includes('workspace.updated'));
  assert.ok(!types.includes('pane.agent_status_changed'));
  assert.ok(types.includes('pane.updated'));
});

test('per-pane status subscriptions carry the pane id', () => {
  assert.deepEqual(paneStatusSubscription('w1:p1'), {
    type: 'pane.agent_status_changed',
    pane_id: 'w1:p1',
  });
});

test('eventName prefers the frame event over data.type', () => {
  // route() switches entirely on this. `data.type` is a fallback only: its
  // vocabulary is not guaranteed to be the event vocabulary, so letting it win
  // would pick the wrong store mutation whenever the two disagree.
  assert.equal(
    eventName({ event: 'workspace_renamed', data: { type: 'something_else' } }),
    'workspace_renamed',
  );
  // A frame with no `event` at all is the case the fallback exists for.
  assert.equal(eventName({ data: { type: 'pane_exited' } }), 'pane_exited');
  // No name anywhere is not an error: route() ignores it, like any other
  // unrecognised event.
  assert.equal(eventName({ data: {} }), '');
  assert.equal(eventName({}), '');
});

test('event frames and error envelopes are told apart by shape', () => {
  // Both readLines consumers dispatch on these before touching any payload, so
  // a result envelope misread as either would be acted on as an event.
  assert.ok(isEventFrame({ event: 'pane_updated', data: {} }));
  assert.ok(!isEventFrame({ id: 'a', result: { type: 'ok' } }));
  assert.ok(!isEventFrame({ event: 'pane_updated' }), 'an event frame carries data');
  assert.ok(!isEventFrame(null));
  assert.ok(!isEventFrame('pane_updated'));

  assert.ok(isErrorResponse({ id: 'a', error: { message: 'nope' } }));
  assert.ok(!isErrorResponse({ id: 'a', result: { type: 'ok' } }));
  assert.ok(!isErrorResponse(null));
});

test('a payload guard checks the fields the daemon reads', () => {
  assert.ok(isPaneInfo({ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' }));
  // agent_status indexes the colour table in hardware/protocol.ts, so a value
  // herdr never promised is a throw on the render path, not a wrong colour.
  assert.ok(!isPaneInfo({ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'error' }));
  assert.ok(!isPaneInfo({ workspace_id: 'w1', agent_status: 'idle' }));

  // Fields nothing reads are deliberately not required: demanding the whole
  // declared shape would drop a usable pane over a field the pad never touches.
  assert.ok(isWorkspaceInfo({ workspace_id: 'w1', label: 'fix-auth' }));
  assert.ok(!isWorkspaceInfo({ workspace_id: 'w1' }));

  assert.ok(
    isAgentInfo({ pane_id: 'p', workspace_id: 'w', agent: 'claude', agent_status: 'idle' }),
  );
  assert.ok(!isAgentInfo({ pane_id: 'p', workspace_id: 'w', agent_status: 'idle' }));

  assert.ok(isTabInfo({ tab_id: 't1', label: 'main' }));
  assert.ok(!isTabInfo({ tab_id: 't1' }));
});

test('a snapshot keeps its usable panes rather than failing over one bad entry', () => {
  const parsed = parseSnapshot({
    version: '0.8.2',
    protocol: 20,
    workspaces: [{ workspace_id: 'w1', label: 'fix-auth' }, { label: 'no id' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' },
      { pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'exploded' },
    ],
  });

  // One malformed pane must cost that pane, not all six keys.
  assert.deepEqual(
    parsed?.panes.map((p) => p.pane_id),
    ['w1:p1'],
  );
  assert.deepEqual(
    parsed?.workspaces.map((w) => w.workspace_id),
    ['w1'],
  );
  // Nothing reads the focused ids, but '' would read as a real id if anything did.
  assert.equal(parsed?.focused_pane_id, undefined);
});

test('a reply that is not a snapshot is refused rather than half-read', () => {
  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot({ protocol: 20 }), null, 'no version');
  assert.equal(parseSnapshot({ version: '0.8.2' }), null, 'no protocol');
  // The version check is what stops an error envelope seeding the pad.
  assert.equal(parseSnapshot({ version: 20, protocol: '0.8.2' }), null, 'swapped types');
});

test('a result envelope is told apart from an event frame', () => {
  assert.ok(isResultResponse({ id: 'a', result: { type: 'subscription_started' } }));
  assert.ok(!isResultResponse({ event: 'pane_updated', data: {} }));
  assert.ok(!isResultResponse({ id: 'a', result: 'ok' }), 'a result is a payload, not a scalar');
  assert.ok(!isResultResponse(null));
});

test('request builders emit the documented wire methods', () => {
  assert.equal(reqSubscribe('a', []).method, 'events.subscribe');
  // Logical key names, not raw control bytes: herdr validates them server-side.
  const keys = reqPaneSendKeys('a', 'w1:p1', ['ctrl+c']);
  assert.equal(keys.method, 'pane.send_keys');
  assert.deepEqual(keys.params, { pane_id: 'w1:p1', keys: ['ctrl+c'] });

  const text = reqPaneSendText('a', 'w1:p1', PageKey.up);
  assert.equal(text.method, 'pane.send_text');
  assert.deepEqual(text.params, { pane_id: 'w1:p1', text: '\x1b[5~' });
});

test('herdr has no page key, so paging goes out as raw bytes', () => {
  // The regression this file exists to prevent. `pageup` and `pagedown` were
  // sent as key names for the life of scroll mode; herdr answered `invalid_key`
  // every time and PadControls logged the rejection and moved on, so the dial
  // simply did nothing. Every spelling below is rejected by herdr 0.8.2.
  for (const name of ['pageup', 'pagedown', 'page_up', 'pgup', 'prior', 'next']) {
    assert.ok(!isHerdrKey(name), `${name} is not a herdr key`);
  }

  assert.equal(PageKey.up, '\x1b[5~');
  assert.equal(PageKey.down, '\x1b[6~');
});

test('the mirrored key vocabulary matches what herdr accepts', () => {
  // Probed against a scratch pane on herdr 0.8.2. The point of mirroring it is
  // that the fake server can reject what the real one rejects.
  for (const name of ['esc', 'escape', 'enter', 'return', 'tab', 'space', 'bs', 'up', 'f12']) {
    assert.ok(isHerdrKey(name), `${name} is accepted`);
  }

  assert.ok(isHerdrKey('a'), 'a single character is a key');
  assert.ok(isHerdrKey('ctrl+c'));
  assert.ok(isHerdrKey('ctrl+shift+a'), 'modifiers stack');

  assert.ok(!isHerdrKey('ctrl-c'), 'modifiers join with +, not -');
  assert.ok(!isHerdrKey('home'), 'no home or end either');
  assert.ok(!isHerdrKey('delete'));
  assert.ok(!isHerdrKey('ctrl+'), 'a modifier with no key is not a key');
  assert.ok(!isHerdrKey('meta+a'), 'meta is not a herdr modifier');
});
