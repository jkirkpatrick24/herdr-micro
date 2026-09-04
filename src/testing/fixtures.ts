import {
  type AgentInfo,
  type AgentStatus,
  type EventFrame,
  Evt,
  type PaneInfo,
  type SessionSnapshot,
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

export function workspace(id: string, label = id, n = 1): WorkspaceInfo {
  return {
    workspace_id: id,
    number: n,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: `${id}:t1`,
    agent_status: 'idle',
  };
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
): AgentInfo {
  return {
    agent: kind,
    agent_status: status,
    pane_id: paneId,
    tab_id: `${workspaceId}:t1`,
    workspace_id: workspaceId,
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
