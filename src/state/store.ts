import { EventEmitter } from 'node:events';
import type {
  AgentInfo,
  AgentStatus,
  PaneInfo,
  SessionSnapshot,
  WorkspaceInfo,
} from '../herdr/rpc.js';
import type { Logger } from '../log.js';

export const SLOT_COUNT = 6;

/** How long an agent must stay `unknown` before the key gives up and settles. */
export const UNKNOWN_SETTLE_MS = 2000;

/**
 * One agent pane: the unit the pad displays.
 *
 * Keys are agents, not workspaces. A workspace routinely holds more than one
 * agent -- herdr's own sidebar renders them as a flat list grouped by
 * workspace -- and collapsing them onto a single key meant one agent's status
 * masking another's.
 */
export type Agent = {
  paneId: string;
  workspaceId: string;
  /** Resolved from workspace.list; AgentInfo carries only the id. */
  workspaceLabel: string;
  /** herdr's agent kind: claude, omp, pi, ... */
  kind: string;
  status: AgentStatus;
  /**
   * Non-null exactly while an `unknown` is being held. This one field is the
   * entire settling state -- the "already settling" guard, the pending timer,
   * and the thing every teardown path must clear.
   */
  unknownTimer: NodeJS.Timeout | null;
};

export type SlotView = {
  slot: number;
  paneId: string | null;
  workspaceId: string | null;
  label: string | null;
  status: AgentStatus | null;
};

export type Transition = {
  paneId: string;
  label: string;
  from: AgentStatus;
  to: AgentStatus;
  /** ms spent in the previous state */
  durationMs: number;
};

/** Matches herdr's sidebar rows: workspace, then agent kind. */
export function labelFor(a: Agent): string {
  return `${a.workspaceLabel}/${a.kind}`;
}

/** A repeated id would occupy two keys and displace a real agent. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Holds agent state and turns it into six slots.
 *
 * Two things this class exists to absorb:
 *
 *  1. Volume. `pane.updated` arrives at ~10 Hz for the focused pane
 *     unconditionally. `changed` fires only when the rendered view actually
 *     differs, which is the dedupe point the whole send-on-change policy rests
 *     on.
 *
 *  2. Flicker. herdr reports `unknown` freely during process churn. Painting
 *     that immediately makes keys blink constantly, so brief unknown holds the
 *     last colour and only settles after UNKNOWN_SETTLE_MS.
 *
 * Slot position is `order[i]` and nothing else, and `order` comes from
 * agent.list -- which herdr returns grouped by workspace and stable across
 * status changes. Holding no second slot array makes "a key never moves on a
 * status change" structural rather than a rule to remember.
 */
export class Store extends EventEmitter {
  private agents = new Map<string, Agent>();
  /** Pane ids in agent.list order. Slot N renders order[N]. */
  private order: string[] = [];
  /** workspace id -> label. AgentInfo carries only the id. */
  private labels = new Map<string, string>();
  private lastView = '';
  private statusSince = new Map<string, number>();
  private warnedOverflow = false;
  private connected = true;
  private readonly settleMs: number;

  /**
   * `settleMs` is injectable purely so tests need not wait 2s. Node 20's
   * `mock.timers` cannot be used here: it returns a number rather than a
   * Timeout, so `timer.unref()` throws, and it does not support mocking Date.
   */
  constructor(
    private readonly log: Logger,
    opts: { settleMs?: number } = {},
  ) {
    super();
    this.settleMs = opts.settleMs ?? UNKNOWN_SETTLE_MS;
  }

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  /** Full rebuild. Called on every connect and reconnect; never merge into old state. */
  applySeed(snapshot: SessionSnapshot): void {
    this.clearAllSettles();
    this.agents.clear();
    this.labels.clear();
    // Must be cleared too: seeded agents start at `idle` and are then given
    // their real status, so a surviving statusSince would date the resulting
    // transition from before the outage and write a fabricated duration into
    // metrics.jsonl on every reconnect.
    this.statusSince.clear();
    this.connected = true;

    for (const w of snapshot.workspaces ?? []) this.labels.set(w.workspace_id, w.label);

    const agentPanes = (snapshot.panes ?? []).filter((p) => p.agent);
    this.order = dedupe(agentPanes.map((p) => p.pane_id));
    for (const p of agentPanes) {
      if (!this.agents.has(p.pane_id)) {
        this.agents.set(p.pane_id, this.newAgent(p.pane_id, p.workspace_id, p.agent ?? '?'));
      }
    }
    // Status second, so settling sees a fully-built record.
    for (const p of agentPanes) {
      const a = this.agents.get(p.pane_id);
      if (a) this.applyStatus(a, p.agent_status, true);
    }

    this.warnOverflow();
    this.notify();
  }

  /** Paint everything idle while the stream is down. Never carry colours across a gap. */
  setDisconnected(): void {
    this.connected = false;
    this.clearAllSettles();
    this.notify();
  }

  private newAgent(paneId: string, workspaceId: string, kind: string): Agent {
    return {
      paneId,
      workspaceId,
      workspaceLabel: this.labels.get(workspaceId) ?? workspaceId,
      kind,
      status: 'idle',
      unknownTimer: null,
    };
  }

  // -------------------------------------------------------------------------
  // Authoritative reconciliation
  // -------------------------------------------------------------------------

  /**
   * Authoritative membership, order and status, from a periodic `agent.list`.
   *
   * This is the only thing that adds or removes keys. Status events are
   * edge-driven, so an agent that disappears without the lifecycle event we
   * expected would otherwise leave its key showing the last thing it said,
   * indefinitely.
   */
  applyAgents(list: AgentInfo[]): void {
    const incoming = dedupe(list.map((a) => a.pane_id));

    for (const paneId of [...this.agents.keys()]) {
      if (!incoming.includes(paneId)) this.dropAgent(paneId);
    }

    for (const info of list) {
      let a = this.agents.get(info.pane_id);
      if (a) {
        a.workspaceId = info.workspace_id;
        a.workspaceLabel = this.labels.get(info.workspace_id) ?? a.workspaceLabel;
        a.kind = info.agent;
      } else {
        a = this.newAgent(info.pane_id, info.workspace_id, info.agent);
        this.agents.set(info.pane_id, a);
      }
      this.applyStatus(a, info.agent_status, false);
    }

    this.order = incoming;
    this.warnOverflow();
    this.notify();
  }

  /** Workspace labels only. Membership comes from agent.list. */
  applyWorkspaces(list: WorkspaceInfo[]): void {
    let changed = false;
    for (const w of list) {
      if (this.labels.get(w.workspace_id) !== w.label) {
        this.labels.set(w.workspace_id, w.label);
        changed = true;
      }
    }
    if (!changed) return;
    for (const a of this.agents.values()) {
      a.workspaceLabel = this.labels.get(a.workspaceId) ?? a.workspaceLabel;
    }
    this.notify();
  }

  renameWorkspace(workspaceId: string, label: string): void {
    if (this.labels.get(workspaceId) === label) return;
    this.labels.set(workspaceId, label);
    for (const a of this.agents.values()) {
      if (a.workspaceId === workspaceId) a.workspaceLabel = label;
    }
    this.notify();
  }

  private dropAgent(paneId: string): void {
    const a = this.agents.get(paneId);
    if (a) this.clearSettle(a);
    this.agents.delete(paneId);
    this.statusSince.delete(paneId);
  }

  private warnOverflow(): void {
    const overflow = this.order.length - SLOT_COUNT;
    if (overflow > 0 && !this.warnedOverflow) {
      this.warnedOverflow = true;
      this.log.warn('more agents than slots; extras are not displayed', {
        agents: this.order.length,
        slots: SLOT_COUNT,
        hidden: overflow,
      });
    } else if (overflow <= 0) {
      this.warnedOverflow = false;
    }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * The low-latency status path: `pane.agent_status_changed` from that pane's
   * own subscription. Unlike pane.updated it fires for background panes, which
   * is the only reason the pad works at all.
   *
   * Keyed purely on pane id, so two agents in one workspace never contend for
   * a key.
   */
  applyPaneStatus(paneId: string, status: AgentStatus): void {
    const a = this.agents.get(paneId);
    if (!a) return; // agent.list decides membership, not status events
    this.applyStatus(a, status, false);
    this.notify();
  }

  /** A closed or exited pane is gone regardless of what agent.list last said. */
  removePane(paneId: string): void {
    if (!this.agents.has(paneId)) return;
    this.dropAgent(paneId);
    this.order = this.order.filter((id) => id !== paneId);
    this.notify();
  }

  /**
   * Topology only. `pane.updated` must never set status: it fires only for the
   * focused pane, on a ~10 Hz timer rather than on change, so a lagging sample
   * could regress a key with no real transition behind it.
   */
  applyPane(pane: PaneInfo): void {
    const a = this.agents.get(pane.pane_id);
    if (!a || a.workspaceId === pane.workspace_id) return;
    a.workspaceId = pane.workspace_id;
    a.workspaceLabel = this.labels.get(pane.workspace_id) ?? pane.workspace_id;
    this.notify();
  }

  /**
   * Brief `unknown` is noise -- it fires whenever herdr momentarily cannot
   * classify the pane. Holding the previous colour for settleMs is the single
   * biggest anti-flicker measure in the daemon.
   */
  private applyStatus(a: Agent, next: AgentStatus, seeding: boolean): void {
    if (next !== 'unknown') {
      this.clearSettle(a);
      this.commitStatus(a, next, seeding);
      return;
    }

    if (seeding) {
      this.commitStatus(a, 'idle', true);
      return;
    }
    if (a.unknownTimer) return; // already settling; keep the existing timer

    // Where to settle, captured now. `done` means work finished that the user
    // has not seen, and only herdr collapses it to idle once they look.
    // Settling it to idle on a timer would silently eat the completion, and
    // because status events are edge-driven nothing re-asserts it afterwards.
    const settleTo: AgentStatus = a.status === 'done' ? 'done' : 'idle';
    a.unknownTimer = setTimeout(() => {
      // Re-look-up by id: the agent may have been dropped meanwhile.
      const live = this.agents.get(a.paneId);
      if (!live?.unknownTimer) return;
      live.unknownTimer = null;
      this.commitStatus(live, settleTo);
      this.notify();
    }, this.settleMs);
    a.unknownTimer.unref?.();
  }

  private clearSettle(a: Agent): void {
    if (!a.unknownTimer) return;
    clearTimeout(a.unknownTimer);
    a.unknownTimer = null;
  }

  private clearAllSettles(): void {
    for (const a of this.agents.values()) this.clearSettle(a);
  }

  /**
   * Records the change and how long the previous state lasted.
   *
   * A seed is a rebuild, not a change, and must stay silent: applySeed builds
   * every agent at `idle` and then hands it the status it already had, so the
   * difference is an artefact of the rebuild rather than anything the agent
   * did. Emitting it would write one fabricated `idle -> X, 0ms` row per
   * non-idle agent on every single reconnect, inflating exactly the block count
   * metrics.jsonl exists to answer. The timestamp is still recorded, so the
   * next real change is dated from the seed.
   */
  private commitStatus(a: Agent, next: AgentStatus, seeding = false): void {
    if (a.status === next) return;
    const now = Date.now();
    const since = this.statusSince.get(a.paneId) ?? now;
    const from = a.status;
    a.status = next;
    this.statusSince.set(a.paneId, now);
    if (seeding) return;
    const transition: Transition = {
      paneId: a.paneId,
      label: labelFor(a),
      from,
      to: next,
      durationMs: now - since,
    };
    this.emit('transition', transition);
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  view(): SlotView[] {
    const out: SlotView[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const id = this.order[slot];
      const a = id ? this.agents.get(id) : undefined;
      out.push(
        a
          ? {
              slot,
              paneId: a.paneId,
              workspaceId: a.workspaceId,
              label: labelFor(a),
              status: this.connected ? a.status : 'idle',
            }
          : { slot, paneId: null, workspaceId: null, label: null, status: null },
      );
    }
    return out;
  }

  /** Slot -> agent, for the gesture bindings in M5/M6. */
  agentForSlot(slot: number): Agent | null {
    const id = this.order[slot];
    return id ? (this.agents.get(id) ?? null) : null;
  }

  /** The dedupe gate: fires only when the rendered view actually differs. */
  private notify(): void {
    const view = this.view();
    const key = JSON.stringify(view);
    if (key === this.lastView) return;
    this.lastView = key;
    this.emit('changed', view);
  }
}
