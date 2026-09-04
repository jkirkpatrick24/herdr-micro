import { type AgentStatus, Evt, type PaneInfo } from './herdr/rpc.js';
import type { SlotView, Store } from './state/store.js';

const GLYPH: Record<AgentStatus, string> = {
  idle: '·',
  working: '▶',
  blocked: '!',
  done: '✓',
  unknown: '?',
};

/** Debug renderer standing in for the pad until M4. */
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
 * Maps a herdr event frame onto a Store mutation.
 *
 * The event name is taken from `frame.event`, which rpc.ts documents as the
 * canonical location; `data.type` is only a fallback, since that field's
 * vocabulary is not guaranteed to be the event vocabulary.
 */
export function route(store: Store, type: string, data: Record<string, unknown>): void {
  switch (type) {
    case Evt.paneCreated:
    case Evt.paneUpdated: {
      const pane = data.pane as PaneInfo | undefined;
      if (pane) store.applyPane(pane);
      return;
    }

    case Evt.paneClosed:
    case Evt.paneExited: {
      const paneId = data.pane_id as string | undefined;
      if (paneId) store.removePane(paneId);
      return;
    }

    // Carries only ids, no pane record. The client backfills status via
    // agent.list, so there is nothing to apply here.
    case Evt.paneAgentDetected:
      return;

    // Membership and order are NOT applied from events. herdr replays a
    // historical backlog on subscribe, out of order, so a create can arrive
    // after its own close and resurrect a dead workspace. The client re-reads
    // workspace.list on these and emits `workspaces` instead.
    case Evt.workspaceCreated:
    case Evt.workspaceClosed:
    case Evt.workspaceReordered:
    case Evt.workspaceMoved:
      return;

    case Evt.workspaceRenamed: {
      const id = data.workspace_id as string | undefined;
      const label = data.label as string | undefined;
      if (id && typeof label === 'string') store.renameWorkspace(id, label);
      return;
    }

    default:
      return;
  }
}
