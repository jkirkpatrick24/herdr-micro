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

export type StoreEvents = {
  /** The rendered slot view. Fires only when it actually differs. */
  changed: (view: SlotView[]) => void;
  /** One status change, already settled. */
  transition: (t: Transition) => void;
};

export declare interface Store {
  on<K extends keyof StoreEvents>(e: K, l: StoreEvents[K]): this;
  emit<K extends keyof StoreEvents>(e: K, ...a: Parameters<StoreEvents[K]>): boolean;
}

/**
 * Holds agent state and turns it into six slots. It exists to absorb two
 * things that would otherwise reach the pad:
 *
 *  1. Volume. herdr can emit ~10 events/sec for a single redrawing pane
 *     (measured: 75 in 8s). `changed` fires only when the rendered view
 *     actually differs, which is where all the deduplication happens.
 *
 *  2. Flicker. herdr reports `unknown` freely during process churn, and
 *     painting it immediately makes keys blink. See applyStatus.
 *
 * Slot position is `order[i]` and nothing else. Keeping no second slot array
 * makes "a key never moves on a status change" structural rather than a rule
 * someone has to remember.
 */
export class Store extends EventEmitter {
  private agents = new Map<string, Agent>();
  /**
   * Pane ids in agent.list order, de-duplicated -- a repeated id would occupy
   * two keys and displace a real agent. Slot N renders order[N].
   */
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
    // Cleared too: seeded agents start at `idle` and are then given their real
    // status, so a surviving timestamp would date that transition from before
    // the outage and write a fabricated duration to metrics on every reconnect.
    this.statusSince.clear();
    this.connected = true;

    for (const w of snapshot.workspaces ?? []) this.labels.set(w.workspace_id, w.label);

    // Only panes running an agent get a key.
    const agentPanes = (snapshot.panes ?? []).filter((p) => p.agent);
    this.order = [...new Set(agentPanes.map((p) => p.pane_id))];

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

  /**
   * Authoritative membership, order and status, from a periodic `agent.list`.
   *
   * This is the only thing that adds or removes keys. Status events are
   * edge-driven, so an agent that disappears without the lifecycle event we
   * expected would otherwise leave its key showing the last thing it said,
   * indefinitely.
   */
  applyAgents(list: AgentInfo[]): void {
    const incoming = new Set(list.map((a) => a.pane_id));

    // Anything herdr no longer lists has gone, whatever events did or did not arrive.
    for (const paneId of [...this.agents.keys()]) {
      if (!incoming.has(paneId)) this.dropAgent(paneId);
    }

    for (const info of list) {
      let a = this.agents.get(info.pane_id);

      if (a) {
        a.workspaceId = info.workspace_id;
        // Falls back to the id, never to the label already held: that one
        // belongs to the workspace the agent just left, so an agent moved into
        // a workspace no label is known for yet would keep naming the old one.
        // The id is ugly and correct, and the next workspace.list repairs it.
        a.workspaceLabel = this.labels.get(info.workspace_id) ?? info.workspace_id;
        a.kind = info.agent;
      } else {
        a = this.newAgent(info.pane_id, info.workspace_id, info.agent);
        this.agents.set(info.pane_id, a);
      }

      this.applyStatus(a, info.agent_status, false);
    }

    // Set iteration is insertion order, so slots follow herdr's own ordering.
    this.order = [...incoming];

    this.warnOverflow();
    this.notify();
  }

  /** Workspace labels only. Membership comes from agent.list. */
  applyWorkspaces(list: WorkspaceInfo[]): void {
    this.setLabels(list.map((w) => [w.workspace_id, w.label]));
  }

  renameWorkspace(workspaceId: string, label: string): void {
    this.setLabels([[workspaceId, label]]);
  }

  /** Relabel, then re-derive every agent's label from the map. */
  private setLabels(entries: Array<[string, string]>): void {
    let changed = false;

    for (const [id, label] of entries) {
      if (this.labels.get(id) === label) continue;
      this.labels.set(id, label);
      changed = true;
    }

    if (!changed) return;

    for (const a of this.agents.values()) {
      a.workspaceLabel = this.labels.get(a.workspaceId) ?? a.workspaceLabel;
    }

    this.notify();
  }

  /** Forget an agent entirely, including its pending timer. */
  private dropAgent(paneId: string): void {
    const a = this.agents.get(paneId);
    if (a) this.clearSettle(a);

    this.agents.delete(paneId);
    this.statusSince.delete(paneId);
  }

  /** Warns once per overflow, and re-arms when it clears. */
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
    // Closing panes is how an overflow ordinarily clears, so this path has to
    // re-arm the warning too. Without it `warnedOverflow` stayed latched and
    // the next overflow was swallowed by the first one having already fired.
    this.warnOverflow();
    this.notify();
  }

  /**
   * Topology only. `pane.updated` must never set status. It fires for whichever
   * pane is redrawing -- not necessarily the focused one, and not necessarily
   * an agent at all -- at ~10 Hz driven by title churn rather than by change,
   * so a lagging sample could regress a key with no real transition behind it.
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
    // A real status arrives: take it, and abandon any pending settle.
    if (next !== 'unknown') {
      this.clearSettle(a);
      this.commitStatus(a, next, seeding);
      return;
    }

    // Nothing to hold on to at seed time, so there is nothing to protect.
    if (seeding) {
      this.commitStatus(a, 'idle', true);
      return;
    }

    if (a.unknownTimer) return; // already settling; keep the existing timer

    // Where to settle, captured now rather than when the timer fires. `done`
    // means work finished that the user has not seen, and only herdr clears it
    // once they look; settling to idle would silently eat the completion, and
    // nothing re-asserts it afterwards because status events are edge-driven.
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
    const now = Date.now();

    // A seed that re-asserts the status an agent already holds is not a
    // change, but it still has to DATE that state. Every agent is built at
    // `idle` and then handed its real status, so an agent herdr reports as
    // idle -- the common case, and the one every reconnect rebuilds -- takes
    // this branch. Returning without the stamp left it with no entry at all,
    // and `since ?? now` then dated its first real change from the change
    // itself: every idle->working row in metrics.jsonl read `duration_ms: 0`,
    // silently zeroing the idle durations the file exists to measure.
    if (a.status === next) {
      if (seeding) this.statusSince.set(a.paneId, now);
      return;
    }

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

  /** Six slots, always. Agents past the sixth are held but not shown. */
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
              // Disconnected shows idle everywhere: better blank than stale.
              status: this.connected ? a.status : 'idle',
            }
          : { slot, paneId: null, workspaceId: null, label: null, status: null },
      );
    }

    return out;
  }

  /** Slot -> agent: what pressing that agent key focuses. See PadControls.handleKey. */
  agentForSlot(slot: number): Agent | null {
    const id = this.order[slot];
    return id ? (this.agents.get(id) ?? null) : null;
  }

  /**
   * The dedupe gate: fires only when the rendered view actually differs.
   * Every mutation above calls this, so most of them cost nothing.
   */
  private notify(): void {
    const view = this.view();
    const key = JSON.stringify(view);

    if (key === this.lastView) return;

    this.lastView = key;
    this.emit('changed', view);
  }
}
