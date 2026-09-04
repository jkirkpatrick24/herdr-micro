/**
 * Every herdr API method name, event name and payload shape lives in this file
 * and nowhere else in the codebase. If herdr's protocol changes, this is the
 * only file that should need editing.
 *
 * Verified against herdr 0.8.2, protocol 20, schema_version 1.
 * Regenerate the reference schema with:  herdr api schema --output schema.json
 */

export const PROTOCOL = 20;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const Method = {
  ping: 'ping',
  sessionSnapshot: 'session.snapshot',
  eventsSubscribe: 'events.subscribe',
  agentList: 'agent.list',
  agentFocus: 'agent.focus',
  agentSendKeys: 'agent.send_keys',
  workspaceList: 'workspace.list',
  workspaceFocus: 'workspace.focus',
  workspaceReportMetadata: 'workspace.report_metadata',
} as const;

export type MethodName = (typeof Method)[keyof typeof Method];

// ---------------------------------------------------------------------------
// Subscriptions
//
// NOTE: the herdr API socket accepts exactly ONE request per connection. A
// second request on the same socket is silently dropped -- no error, no ack,
// no close. So a subscription *is* a connection: each subscribe call needs its
// own socket, and subscriptions cannot be added to a live one.
// See Subscriber in ./client.ts.
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
  paneUpdated: 'pane.updated',
  paneExited: 'pane.exited',
  paneAgentDetected: 'pane.agent_detected',
  /** Per-pane, low latency. Requires a pane_id, hence its own connection. */
  paneAgentStatusChanged: 'pane.agent_status_changed',
} as const;

export type SubscriptionSpec =
  | { type: Exclude<(typeof Sub)[keyof typeof Sub], 'pane.agent_status_changed'> }
  | { type: 'pane.agent_status_changed'; pane_id: string };

/**
 * Topology only. This stream tells the daemon which workspaces and agent panes
 * exist; it does NOT carry status.
 *
 * `pane.updated` is included but must never be treated as a status source.
 * Measured: it fires ~10 Hz unconditionally for the FOCUSED pane only -- 38
 * events in 4s for the focused pane, zero for the other six panes in the
 * session. A background agent can go working -> done without producing a
 * single pane.updated. It is kept because it is free and refreshes labels for
 * the pane the user is looking at.
 *
 * `workspace.updated` is deliberately absent: it does not fire on agent-status
 * change at all (verified across a full working -> done cycle on a background
 * workspace), despite WorkspaceInfo carrying an agent_status field.
 *
 * Real status comes from one PANE_STATUS_SUBSCRIPTION per agent pane.
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
];

/**
 * The real status source: change-driven, reliable for background panes, and
 * silent when nothing happens. Requires a pane_id, and subscriptions cannot be
 * added to a live connection, so each agent pane needs its own socket.
 */
export function paneStatusSubscription(paneId: string): SubscriptionSpec[] {
  return [{ type: Sub.paneAgentStatusChanged, pane_id: paneId }];
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
  paneUpdated: 'pane_updated',
  paneExited: 'pane_exited',
  paneAgentDetected: 'pane_agent_detected',
  paneAgentStatusChanged: 'pane_agent_status_changed',
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
 */
export function eventName(frame: EventFrame): string {
  return frame.event ?? (frame.data?.type as string | undefined) ?? '';
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
  return typeof v === 'string' && (AGENT_STATUSES as readonly string[]).includes(v);
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
};

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

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export type Request = { id: string; method: MethodName; params: Record<string, unknown> };

export type SuccessResponse = { id: string; result: { type: string; [k: string]: unknown } };
export type ErrorResponse = { id: string; error: { code?: string; message?: string } };
export type EventFrame = { event: string; data: Record<string, unknown> };

export function isEventFrame(m: unknown): m is EventFrame {
  return typeof m === 'object' && m !== null && 'event' in m && 'data' in m;
}

export function isErrorResponse(m: unknown): m is ErrorResponse {
  return typeof m === 'object' && m !== null && 'error' in m;
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

export function reqAgentFocus(id: string, target: string): Request {
  return { id, method: Method.agentFocus, params: { target } };
}

/** herdr validates logical key names before writing any bytes. Prefer this to raw \x03. */
export function reqAgentSendKeys(id: string, target: string, keys: string[]): Request {
  return { id, method: Method.agentSendKeys, params: { target, keys } };
}

export function reqWorkspaceReportMetadata(
  id: string,
  workspaceId: string,
  source: string,
  tokens: Record<string, string | null>,
): Request {
  return {
    id,
    method: Method.workspaceReportMetadata,
    params: { workspace_id: workspaceId, source, tokens },
  };
}

/** Logical key name for interrupt, validated server-side. */
export const KEY_INTERRUPT = 'ctrl+c';
