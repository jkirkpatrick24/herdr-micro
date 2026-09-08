import { EventEmitter } from 'node:events';

import type { HerdrClientEventSource, HerdrClientEvents } from '../herdr/client.js';
import {
  type AgentInfo,
  type AgentStatus,
  type EventFrame,
  Evt,
  type PaneInfo,
  type SessionSnapshot,
  type TabInfo,
  type WorkspaceInfo,
} from '../herdr/rpc.js';
import type { Logger } from '../log.js';

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

/**
 * Typed builders. Because these are annotated with the real rpc.ts types, tsc
 * checks every fixture shape at build time -- which is where most of the value
 * of authoring the tests in TypeScript comes from.
 */

export function workspace(
  id: string,
  label = id,
  n = 1,
  opts: { focused?: boolean } = {},
): WorkspaceInfo {
  return {
    workspace_id: id,
    number: n,
    label,
    focused: opts.focused ?? false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: `${id}:t1`,
    agent_status: 'idle',
  };
}

export function tab(id: string, label = id, opts: { focused?: boolean } = {}): TabInfo {
  return { tab_id: id, label, focused: opts.focused ?? false };
}

export function pane(
  id: string,
  workspaceId: string,
  opts: { agent?: string | null; status?: AgentStatus; revision?: number } = {},
): PaneInfo {
  return {
    pane_id: id,
    terminal_id: `term_${id}`,
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    focused: false,
    agent_status: opts.status ?? 'idle',
    revision: opts.revision ?? 1,
    agent: opts.agent === undefined ? 'claude' : opts.agent,
  };
}

export function snapshot(workspaces: WorkspaceInfo[], panes: PaneInfo[]): SessionSnapshot {
  return {
    version: '0.8.2-fixture',
    protocol: 20,
    workspaces,
    panes,
  };
}

/** N workspaces each with one agent pane, all idle. */
export function simpleSession(count: number): SessionSnapshot {
  const ws: WorkspaceInfo[] = [];
  const panes: PaneInfo[] = [];
  for (let i = 1; i <= count; i++) {
    ws.push(workspace(`w${i}`, `ws-${i}`, i));
    panes.push(pane(`w${i}:p1`, `w${i}`));
  }
  return snapshot(ws, panes);
}

export function agent(
  paneId: string,
  workspaceId: string,
  status: AgentStatus,
  kind = 'claude',
  opts: { stateChangeSeq?: number; focused?: boolean } = {},
): AgentInfo {
  return {
    agent: kind,
    agent_status: status,
    pane_id: paneId,
    tab_id: `${workspaceId}:t1`,
    workspace_id: workspaceId,
    ...(opts.stateChangeSeq === undefined ? {} : { state_change_seq: opts.stateChangeSeq }),
    // Absent unless asked for, matching the optional field on AgentInfo: the
    // harness layer is the only reader, and it must cope with it missing.
    ...(opts.focused === undefined ? {} : { focused: opts.focused }),
  };
}

export function frame(event: string, data: Record<string, unknown>): EventFrame {
  return { event, data: { type: event, ...data } };
}

export function statusFrame(paneId: string, workspaceId: string, status: AgentStatus): EventFrame {
  return frame(Evt.paneAgentStatusChanged, {
    pane_id: paneId,
    workspace_id: workspaceId,
    agent_status: status,
  });
}

/**
 * A stand-in for the event half of a HerdrClient.
 *
 * `emit` is typed against HerdrClientEvents, so a test that emits the wrong
 * payload for an event fails to compile rather than at an assertion three
 * lines later. That is the whole reason this exists: the previous stub was an
 * EventEmitter cast through `unknown`, which typed every emit as `any[]`.
 */
export function clientBus(): {
  client: HerdrClientEventSource;
  emit<K extends keyof HerdrClientEvents>(e: K, ...a: Parameters<HerdrClientEvents[K]>): void;
} {
  const bus = new EventEmitter();

  return {
    client: {
      on(event, listener) {
        bus.on(event, listener);
      },
    },
    emit(event, ...args) {
      bus.emit(event, ...args);
    },
  };
}
