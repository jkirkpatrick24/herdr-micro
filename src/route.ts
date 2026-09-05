import { type AgentStatus, Evt, isPaneInfo } from './herdr/rpc.js';
import type { SlotView, Store } from './state/store.js';

const GLYPH: Record<AgentStatus, string> = {
  idle: '·',
  working: '▶',
  blocked: '!',
  done: '✓',
  unknown: '?',
};

/**
 * The status row on stdout, mirroring what the pad's six keys show. Fixed
 * width per slot, so successive rows line up when read as a log.
 */
export function renderRow(view: SlotView[]): string {
  return view
    .map((s) => {
      if (!s.paneId) return '[ -                    ]';

      const glyph = GLYPH[s.status ?? 'idle'] ?? '?';
      return `[${glyph} ${(s.label ?? '').slice(0, 20).padEnd(20)}]`;
    })
    .join(' ');
}

/**
 * Maps a herdr event frame onto a Store mutation. Most events are deliberately
 * no-ops -- the cases below say why for each -- so an unrecognised event
 * falling through to `default` is the normal outcome, not a gap.
 */
export function route(store: Store, type: string, data: Record<string, unknown>): void {
  switch (type) {
    case Evt.paneCreated:
    case Evt.paneUpdated: {
      const pane = data.pane;
      if (isPaneInfo(pane)) store.applyPane(pane);
      return;
    }

    case Evt.paneClosed:
    case Evt.paneExited: {
      const paneId = data.pane_id;
      if (typeof paneId === 'string' && paneId) store.removePane(paneId);
      return;
    }

    // Carries only ids, no pane record. The client backfills status via
    // agent.list, so there is nothing to apply here.
    case Evt.paneAgentDetected:
      return;

    // Membership and order are NOT applied from events: workspace.list is
    // authoritative, events are only triggers to re-read it. The client does
    // that and emits `workspaces`. (The out-of-order replay this originally
    // guarded against is unreproduced on 0.8.2 -- see reconcileWorkspaces.)
    case Evt.workspaceCreated:
    case Evt.workspaceClosed:
    case Evt.workspaceReordered:
    case Evt.workspaceMoved:
      return;

    case Evt.workspaceRenamed: {
      const id = data.workspace_id;
      const label = data.label;
      if (typeof id === 'string' && id && typeof label === 'string') {
        store.renameWorkspace(id, label);
      }
      return;
    }

    default:
      return;
  }
}
