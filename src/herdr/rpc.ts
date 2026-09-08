/**
 * Every herdr API method name, event name and payload shape lives in this file
 * and nowhere else in the codebase. If herdr's protocol changes, this is the
 * only file that should need editing.
 *
 * Verified against herdr 0.8.2, protocol 20, schema_version 1.
 * Regenerate the reference schema with:  herdr api schema --output schema.json
 */

import { asArray, isOneOf, isRecord, str } from '../json.js';

export const PROTOCOL = 20;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const Method = {
  sessionSnapshot: 'session.snapshot',
  eventsSubscribe: 'events.subscribe',
  agentList: 'agent.list',
  agentFocus: 'agent.focus',
  paneCurrent: 'pane.current',
  paneSendKeys: 'pane.send_keys',
  paneSendText: 'pane.send_text',
  paneFocusDirection: 'pane.focus_direction',
  workspaceList: 'workspace.list',
  workspaceFocus: 'workspace.focus',
  tabList: 'tab.list',
  tabFocus: 'tab.focus',
  notificationShow: 'notification.show',
  popupClose: 'popup.close',
  pluginPaneOpen: 'plugin.pane.open',
} as const;

export type MethodName = (typeof Method)[keyof typeof Method];

// ---------------------------------------------------------------------------
// Subscriptions
//
// NOTE: the herdr API socket accepts exactly ONE request per connection. The
// second request is never answered AND the server closes the connection,
// taking any live subscription with it. Measured against herdr 0.8.2: a
// subscription socket sent a second request at t=3000ms and was closed at
// t=3095ms, while an identical control socket that sent nothing further stayed
// open for the whole run. Re-run it with tools/herdr-probe.mjs.
//
// So a subscription *is* a connection: each subscribe needs its own socket,
// subscriptions cannot be added to a live one, and reusing a socket does not
// degrade gracefully -- it drops the stream. See Subscriber in ./client.ts.
// ---------------------------------------------------------------------------

export const Sub = {
  workspaceCreated: 'workspace.created',
  workspaceUpdated: 'workspace.updated',
  workspaceMetadataUpdated: 'workspace.metadata_updated',
  workspaceRenamed: 'workspace.renamed',
  workspaceMoved: 'workspace.moved',
  workspaceReordered: 'workspace.reordered',
  workspaceClosed: 'workspace.closed',
  workspaceFocused: 'workspace.focused',
  paneCreated: 'pane.created',
  paneClosed: 'pane.closed',
  paneFocused: 'pane.focused',
  paneUpdated: 'pane.updated',
  paneExited: 'pane.exited',
  paneAgentDetected: 'pane.agent_detected',
  /** Per-pane, low latency. Requires a pane_id, so it cannot join the global set. */
  paneAgentStatusChanged: 'pane.agent_status_changed',
} as const;

export type SubscriptionSpec =
  | { type: Exclude<(typeof Sub)[keyof typeof Sub], 'pane.agent_status_changed'> }
  | { type: 'pane.agent_status_changed'; pane_id: string };

/**
 * Topology only: which workspaces and agent panes exist. This stream does NOT
 * carry status -- that comes from paneStatusSubscription below.
 *
 * `pane.updated` is here but must never be read as a status source. It fires
 * on any pane metadata change, so an agent animating a spinner in its title
 * produces ~10/second (measured on 0.8.2: 75 events in 8s, all from one pane,
 * while the other eight produced none). Nor is it "the focused pane on a
 * timer" -- in that run the chatty pane was not the focused one. It covers
 * whichever pane is redrawing, which may be no agent at all, and a background
 * agent can go working -> done without emitting one. Kept only because it is
 * free and refreshes labels.
 *
 * `workspace.updated` is deliberately absent: despite WorkspaceInfo carrying
 * an agent_status, it does not fire on status change at all (verified across a
 * full working -> done cycle on a background workspace).
 */
export const GLOBAL_SUBSCRIPTIONS: SubscriptionSpec[] = [
  { type: Sub.workspaceCreated },
  { type: Sub.workspaceClosed },
  { type: Sub.workspaceRenamed },
  { type: Sub.workspaceMoved },
  { type: Sub.workspaceReordered },
  { type: Sub.paneCreated },
  { type: Sub.paneClosed },
  { type: Sub.paneExited },
  { type: Sub.paneAgentDetected },
  { type: Sub.paneUpdated },
  // Not topology: the harness layer acts on whatever is focused, and this is
  // how it learns the focus moved. Without it the only way to notice was to
  // watch the pad's own focus-moving inputs and guess, on a timer, when herdr
  // had got round to it -- which said nothing at all about a focus changed
  // from the keyboard or by another client.
  { type: Sub.paneFocused },
];

/**
 * The real status source: change-driven, reliable for background panes, and
 * silent when nothing happens. Requires a pane_id, so one entry per agent pane
 * -- but a single subscribe carries them all, and one connection serves the
 * whole set. What cannot be done is ADDING a pane to a live connection; see
 * HerdrClient.syncStatusSubscription.
 */
export function paneStatusSubscription(paneId: string): SubscriptionSpec {
  return { type: Sub.paneAgentStatusChanged, pane_id: paneId };
}

// ---------------------------------------------------------------------------
// Event names (as they appear in the `event` field of a streamed frame)
// ---------------------------------------------------------------------------

export const Evt = {
  workspaceCreated: 'workspace_created',
  workspaceUpdated: 'workspace_updated',
  workspaceMetadataUpdated: 'workspace_metadata_updated',
  workspaceRenamed: 'workspace_renamed',
  workspaceMoved: 'workspace_moved',
  workspaceReordered: 'workspace_reordered',
  workspaceClosed: 'workspace_closed',
  workspaceFocused: 'workspace_focused',
  paneCreated: 'pane_created',
  paneClosed: 'pane_closed',
  paneFocused: 'pane_focused',
  paneUpdated: 'pane_updated',
  paneExited: 'pane_exited',
  paneAgentDetected: 'pane_agent_detected',
  /**
   * The odd one out: every other event arrives underscored, but this one
   * arrives as the DOTTED subscription name -- measured on the wire, see
   * tools/herdr-probe.mjs. Nothing in the client matches on it -- the status
   * handler reads `data.pane_id` and `data.agent_status` from whatever arrives
   * on that socket, which is why the mismatch never showed. This value exists
   * for fixtures and readers.
   */
  paneAgentStatusChanged: 'pane.agent_status_changed',
} as const;

export const SUBSCRIPTION_STARTED = 'subscription_started';

/** Membership events. Triggers to re-read workspace.list, never applied directly. */
export const MEMBERSHIP_EVENTS: ReadonlySet<string> = new Set([
  Evt.workspaceCreated,
  Evt.workspaceClosed,
  Evt.workspaceMoved,
  Evt.workspaceReordered,
]);

/**
 * The canonical event name for a frame.
 *
 * `event` is the documented location; `data.type` is only a fallback, since
 * that field's vocabulary is not guaranteed to be the event vocabulary.
 *
 * The parameter is looser than EventFrame on purpose. Every branch here exists
 * for a frame that is missing something -- that is the whole function -- so
 * demanding a well-formed one and then handling malformed ones anyway just
 * moved the dishonesty to the callers, who had to assert their way in.
 */
export function eventName(frame: { event?: unknown; data?: { type?: unknown } }): string {
  if (typeof frame.event === 'string' && frame.event) return frame.event;

  const type = frame.data?.type;
  return typeof type === 'string' ? type : '';
}

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/**
 * herdr's agent lifecycle states. Note there is NO `error` state -- the
 * original MVP document assumed one. `unknown` means an agent is present but
 * herdr cannot classify it confidently; it does not imply failure and must
 * never be painted as an error colour.
 *
 * `done` is `idle` reached after *unseen* background work. Focusing the tab
 * marks it seen and collapses it to `idle`.
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export const AGENT_STATUSES: readonly AgentStatus[] = [
  'idle',
  'working',
  'blocked',
  'done',
  'unknown',
];

export function isAgentStatus(v: unknown): v is AgentStatus {
  return isOneOf(AGENT_STATUSES, v);
}

export type PaneInfo = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: AgentStatus;
  /**
   * Monotonic within a single subscription connection, restarting at 1 on each
   * new subscribe. NOT a pane-global version: `agent.list` reports a different,
   * much higher counter. Usable for intra-connection ordering only, which is
   * sufficient because every reconnect reseeds from a snapshot.
   */
  revision: number;
  agent?: string | null;
  display_agent?: string | null;
  cwd?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  tokens?: Record<string, string>;
};

/**
 * Every guard below checks the fields the daemon actually READS, and no more.
 *
 * Validating the full declared shape would be stricter than herdr's own
 * promise: an unread field going missing on some future version would drop a
 * pane that is perfectly usable, and the pad would go dark for a reason nobody
 * could see. Checking what is read makes the guard's job exactly "is this safe
 * to consume", which is the only question the caller has.
 *
 * `agent_status` earns its check twice over -- it indexes the colour table in
 * hardware/protocol.ts, so a value herdr never promised is not a wrong colour,
 * it is a throw on the render path.
 */
export function isPaneInfo(v: unknown): v is PaneInfo {
  return (
    isRecord(v) &&
    typeof v.pane_id === 'string' &&
    typeof v.workspace_id === 'string' &&
    isAgentStatus(v.agent_status)
  );
}

export type WorkspaceWorktreeInfo = {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  checkout_path: string;
  is_linked_worktree: boolean;
};

export type WorkspaceInfo = {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  /**
   * Present on snapshots, but herdr does NOT emit workspace.updated when it
   * changes. Do not derive pad colour from this -- it looks correct in a
   * snapshot test and then never updates. Aggregate from pane events instead.
   */
  agent_status: AgentStatus;
  tokens?: Record<string, string>;
  worktree?: WorkspaceWorktreeInfo | null;
};

export function isWorkspaceInfo(v: unknown): v is WorkspaceInfo {
  return isRecord(v) && typeof v.workspace_id === 'string' && typeof v.label === 'string';
}

/**
 * Shape returned by `agent.list`. Note this carries `state_change_seq`, a
 * pane-global monotonic counter -- unlike the event PaneInfo, which only has
 * `revision` (per-subscription, restarts at 1). Used to close the window
 * between an agent being detected and its status subscription opening.
 */
export type AgentInfo = {
  agent: string;
  agent_status: AgentStatus;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  state_change_seq?: number;
  terminal_title_stripped?: string | null;
  /**
   * Required in herdr's schema (0.8.2, protocol 20), optional here on purpose.
   *
   * `isAgentInfo` gates every agent that reaches the pad, so adding a required
   * field to it means a herdr build that stopped sending this one would drop
   * all six keys to dark rather than lose the one feature that reads it. Only
   * the harness layer reads it, and it degrades to "no focused agent" when the
   * field is absent -- see the guard comment above isPaneInfo.
   */
  focused?: boolean;
};

export function isAgentInfo(v: unknown): v is AgentInfo {
  return (
    isRecord(v) &&
    typeof v.pane_id === 'string' &&
    typeof v.workspace_id === 'string' &&
    typeof v.agent === 'string' &&
    isAgentStatus(v.agent_status)
  );
}

export type TabInfo = {
  tab_id: string;
  label: string;
  focused: boolean;
};

export function isTabInfo(v: unknown): v is TabInfo {
  return isRecord(v) && typeof v.tab_id === 'string' && typeof v.label === 'string';
}

export type SessionSnapshot = {
  version: string;
  protocol: number;
  focused_workspace_id?: string;
  focused_tab_id?: string;
  focused_pane_id?: string;
  /** Array order is sidebar order. There is no createdAt anywhere in the API. */
  workspaces: WorkspaceInfo[];
  panes: PaneInfo[];
};

/**
 * Builds a snapshot from whatever `session.snapshot` returned, or null if it
 * is not one.
 *
 * This constructs rather than asserts, which is the difference that matters: a
 * malformed pane is dropped and the rest of the session still seeds the pad,
 * where a guard over the whole envelope would have to reject all six keys over
 * one bad entry, and a cast would have admitted the bad entry to the colour
 * table.
 */
export function parseSnapshot(v: unknown): SessionSnapshot | null {
  if (!isRecord(v)) return null;
  if (typeof v.version !== 'string' || typeof v.protocol !== 'number') return null;

  return {
    version: v.version,
    protocol: v.protocol,
    // Absent stays absent: '' would read as a real id to anyone who looked.
    focused_workspace_id: str(v.focused_workspace_id),
    focused_tab_id: str(v.focused_tab_id),
    focused_pane_id: str(v.focused_pane_id),
    workspaces: asArray(v.workspaces).filter(isWorkspaceInfo),
    panes: asArray(v.panes).filter(isPaneInfo),
  };
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export type Request = { id: string; method: MethodName; params: Record<string, unknown> };

/**
 * The key each result arrives under.
 *
 * A method and its result key have to agree, and until these were named the
 * only thing holding them together was two string literals written at opposite
 * ends of the client -- `reqAgentList(...)` in one place and `'agents'` passed
 * as a bare argument in another. Getting that pair wrong yields an empty list
 * rather than an error, which reaches the pad as six dark keys.
 */
export const ResultKey = {
  snapshot: 'snapshot',
  agents: 'agents',
  workspaces: 'workspaces',
  tabs: 'tabs',
} as const;

/**
 * herdr's logical key names for `pane.send_keys`.
 *
 * herdr validates these server-side before writing any bytes, so a typo is a
 * rejected request at runtime rather than a build error. Naming them also
 * separates the wire key `enter` from the ControlAction of the same name in
 * config.ts, which are unrelated vocabularies that happen to collide.
 */
export const Key = {
  escape: 'esc',
  enter: 'enter',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
} as const;

/**
 * The key names herdr accepts, mirrored from the server's own validation.
 *
 * This exists to be enforced in the fake server, not to gate the daemon: the
 * point is that a name this file invents can fail a test instead of failing
 * silently on a user's pad. `pageup` and `pagedown` shipped here for exactly
 * that reason -- the fake echoed back whatever it was handed, so scroll mode
 * passed its tests while herdr rejected every request it sent.
 *
 * Probed against herdr 0.8.2. Rejected, and so deliberately absent: every
 * spelling of the page keys (`pageup`, `page_up`, `pgup`, `prior`, `next`),
 * plus `home`, `end`, `delete` and `insert`. Modifiers join with `+`; `ctrl-c`
 * is not a key.
 */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  'esc',
  'escape',
  'enter',
  'return',
  'tab',
  'space',
  'backspace',
  'bs',
  'up',
  'down',
  'left',
  'right',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS: ReadonlySet<string> = new Set(['ctrl', 'alt', 'shift']);

/** A bare key: a name herdr knows, or any single character typed literally. */
function isBaseKey(key: string): boolean {
  return NAMED_KEYS.has(key) || [...key].length === 1;
}

export function isHerdrKey(key: string): boolean {
  if (isBaseKey(key)) return true;

  const parts = key.split('+');
  const base = parts.pop();

  return (
    base !== undefined &&
    parts.length > 0 &&
    parts.every((modifier) => MODIFIERS.has(modifier)) &&
    isBaseKey(base)
  );
}

/**
 * Page Up and Page Down, as the bytes a terminal actually sends.
 *
 * These are NOT in `Key` because herdr's send_keys vocabulary has no page key
 * at all -- see NAMED_KEYS above -- and there is no scroll method anywhere in
 * the API either. Paging therefore has to go through `pane.send_text`, which
 * writes bytes straight to the pty.
 *
 * Verified that it writes them *unwrapped* even when the pane has bracketed
 * paste enabled (DECSET 2004), which is the property that makes this work:
 * wrapped, the application would read an escape sequence as pasted text rather
 * than as a key press, and every agent TUI worth scrolling has paste mode on.
 */
export const PageKey = {
  up: '\x1b[5~',
  down: '\x1b[6~',
} as const;

export type ErrorResponse = { id: string; error: { code?: string; message?: string } };
export type EventFrame = { event: string; data: Record<string, unknown> };

/**
 * Checks the field types, not just that the keys are present. The old version
 * asked only `'event' in m && 'data' in m`, so `{ event: 42, data: 'x' }`
 * satisfied it and became an EventFrame -- a shape the type promised and
 * nothing had verified.
 */
export function isEventFrame(m: unknown): m is EventFrame {
  return isRecord(m) && typeof m.event === 'string' && isRecord(m.data);
}

export function isErrorResponse(m: unknown): m is ErrorResponse {
  return typeof m === 'object' && m !== null && 'error' in m;
}

/** A reply carrying a result payload. The payload's own shape is still unchecked. */
export type ResultResponse = { result: Record<string, unknown> };

export function isResultResponse(m: unknown): m is ResultResponse {
  return isRecord(m) && isRecord(m.result);
}

// ---------------------------------------------------------------------------
// Request builders -- the only places these method strings are used
// ---------------------------------------------------------------------------

export function reqSnapshot(id: string): Request {
  return { id, method: Method.sessionSnapshot, params: {} };
}

export function reqSubscribe(id: string, subscriptions: SubscriptionSpec[]): Request {
  return { id, method: Method.eventsSubscribe, params: { subscriptions } };
}

export function reqAgentList(id: string): Request {
  return { id, method: Method.agentList, params: {} };
}

export function reqWorkspaceList(id: string): Request {
  return { id, method: Method.workspaceList, params: {} };
}
export function reqWorkspaceFocus(id: string, workspaceId: string): Request {
  return { id, method: Method.workspaceFocus, params: { workspace_id: workspaceId } };
}

export function reqTabList(id: string, workspaceId: string): Request {
  return { id, method: Method.tabList, params: { workspace_id: workspaceId } };
}

export function reqTabFocus(id: string, tabId: string): Request {
  return { id, method: Method.tabFocus, params: { tab_id: tabId } };
}

export function reqPaneFocusDirection(id: string, direction: string): Request {
  return { id, method: Method.paneFocusDirection, params: { direction } };
}

export function reqNotificationShow(id: string, title: string): Request {
  return { id, method: Method.notificationShow, params: { title } };
}

export function reqPopupClose(id: string): Request {
  return { id, method: Method.popupClose, params: {} };
}

export function reqPluginPaneOpen(id: string): Request {
  return {
    id,
    method: Method.pluginPaneOpen,
    params: { plugin_id: 'jkirkpatrick24.herdr-micro', entrypoint: 'keys', placement: 'popup' },
  };
}

export function reqAgentFocus(id: string, target: string): Request {
  return { id, method: Method.agentFocus, params: { target } };
}

export function reqPaneCurrent(id: string): Request {
  return { id, method: Method.paneCurrent, params: {} };
}

/** herdr validates logical key names before writing any bytes. Prefer this to raw \x03. */
export function reqPaneSendKeys(id: string, paneId: string, keys: string[]): Request {
  return { id, method: Method.paneSendKeys, params: { pane_id: paneId, keys } };
}

/**
 * Raw bytes to the pty, with no validation and no vocabulary. Only for input
 * that `pane.send_keys` cannot express -- see PageKey.
 */
export function reqPaneSendText(id: string, paneId: string, text: string): Request {
  return { id, method: Method.paneSendText, params: { pane_id: paneId, text } };
}
