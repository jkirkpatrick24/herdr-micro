import type { ControlConfig, DialMode } from '../config.js';
import type { HerdrClient } from '../herdr/client.js';
import { Key } from '../herdr/rpc.js';
import { type Logger, reason } from '../log.js';
import type { Store } from '../state/store.js';
import { ArrowStick } from './joystick.js';
import type { PadInput } from './protocol.js';

/** Agent navigation order: the agent most in need of a human comes first. */
const ATTENTION: Record<string, number> = { blocked: 4, done: 3, working: 2, idle: 1 };

/** Turns pad input into herdr commands. Every action is best-effort. */
export class PadControls {
  private mode: DialMode;
  /** Navigation owns the stick by default; the harness layer borrows it. */
  private readonly stick = new ArrowStick();

  constructor(
    private readonly client: HerdrClient,
    private readonly store: Store,
    private readonly settings: ControlConfig,
    private readonly log: Logger,
    private readonly onModeChange: (mode: DialMode) => void,
  ) {
    this.mode = settings.dialModeOrder[0] ?? 'workspaces';
  }

  get dialMode(): DialMode {
    return this.mode;
  }

  /** Consumed joystick reports still update position, but never move a pane. */
  handle(input: PadInput, consumed = false): void {
    try {
      if (input.kind === 'joystick') {
        this.handleJoystick(input.angle, input.distance, consumed);
      } else if (!consumed) {
        if (input.kind === 'key') this.handleKey(input.key, input.pressed);
        else this.handleDial(input.action);
      }
    } catch (error) {
      this.log.warn('pad control failed', { reason: reason(error) });
    }
  }

  /** The six agent keys are fixed; the rest are whatever the config binds. */
  private handleKey(key: string, pressed: boolean): void {
    if (!pressed) return;

    const agentKey = /^AG0([0-5])$/.exec(key);
    if (agentKey) {
      const slot = Number(agentKey[1]);
      const agent = this.store.agentForSlot(slot);
      if (agent) void this.run('agent.focus', this.client.focusAgent(agent.paneId));
      return;
    }

    switch (this.settings.buttons[key] ?? 'none') {
      case 'popup':
        void this.run('popup toggle', this.client.toggleAgentPopup());
        break;
      case 'escape':
        void this.run('send escape', this.client.sendKeysToFocusedPane([Key.escape]));
        break;
      case 'tab-prev':
        void this.run('previous tab', this.stepTab(-1));
        break;
      case 'tab-next':
        void this.run('next tab', this.stepTab(1));
        break;
      case 'enter':
        void this.run('send enter', this.client.sendKeysToFocusedPane([Key.enter]));
        break;
      case 'none':
        break;
    }
  }

  /** Clicking cycles the mode; turning navigates within whichever is active. */
  private handleDial(action: 'clockwise' | 'counterclockwise' | 'click'): void {
    if (action === 'click') {
      const order = this.settings.dialModeOrder;
      const index = order.indexOf(this.mode);

      this.mode = order[(index + 1) % order.length] ?? 'workspaces';

      this.onModeChange(this.mode);
      this.log.info('dial mode changed', { mode: this.mode });
      return;
    }

    // Clockwise steps backwards through the lists, matching the pad's legend.
    const step = action === 'clockwise' ? -1 : 1;

    switch (this.mode) {
      case 'workspaces':
        void this.run('workspace navigation', this.stepWorkspace(step));
        break;
      case 'agents':
        void this.run('agent navigation', this.stepAgent(step));
        break;
      // The harness layer scrolls the focused pane with its own dial turns and
      // consumes them, so one never reaches here through `harnessSurface`.
      // Named anyway, so the exhaustive check below stays a compile error for a
      // mode nobody handled rather than for this one.
      case 'harness':
        break;
      default: {
        // A new DialMode is a compile error here rather than a dial that turns
        // and quietly does the last branch's job.
        const unhandled: never = this.mode;
        this.log.warn('dial mode has no turn behaviour', { mode: unhandled });
      }
    }
  }

  /**
   * The stick streams a continuous position, so this fires once per sector
   * entered: holding it in one direction moves one pane, not hundreds.
   */
  private handleJoystick(angle: number, distance: number, consumed: boolean): void {
    // Read first and act second: a consumed report still has to move the
    // stick's position, or handing it back would replay a direction already
    // held. `true` because this is the reader the stick belongs to by default.
    const direction = this.stick.read(angle, distance, true);
    if (consumed || !direction) return;
    if (this.settings.joystick[direction] !== 'pane') return;

    this.log.info('joystick pane focus requested', { angle, distance, direction });
    void this.run('pane navigation', this.client.focusPaneDirection(direction));
  }

  // Each step below re-reads the list rather than caching it: herdr is
  // authoritative about what is focused, and a dial turn is rare enough that
  // one round trip costs nothing.

  private async stepWorkspace(step: -1 | 1): Promise<void> {
    const workspaces = await this.client.workspaceList();

    const current = workspaces.findIndex((workspace) => workspace.focused);
    if (current < 0 || workspaces.length < 2) return;

    const next = cycle(workspaces, current, step);
    if (next) await this.client.focusWorkspace(next.workspace_id);
  }

  /** Tabs belong to a workspace, so the focused one has to be found first. */
  private async stepTab(step: -1 | 1): Promise<void> {
    const workspaces = await this.client.workspaceList();
    const workspace = workspaces.find((candidate) => candidate.focused);
    if (!workspace) return;

    const tabs = await this.client.tabList(workspace.workspace_id);

    const current = tabs.findIndex((tab) => tab.focused);
    if (current < 0 || tabs.length < 2) return;

    const next = cycle(tabs, current, step);
    if (next) await this.client.focusTab(next.tab_id);
  }

  /**
   * Ordered by how much attention the agent needs, so one turn from anywhere
   * reaches whatever is blocked. Ties break on most-recently-changed.
   */
  private async stepAgent(step: -1 | 1): Promise<void> {
    const agents = await this.client.agentList();
    if (agents.length === 0) return;

    const ordered = [...agents].sort(
      (a, b) =>
        (ATTENTION[b.agent_status] ?? 0) - (ATTENTION[a.agent_status] ?? 0) ||
        (b.state_change_seq ?? 0) - (a.state_change_seq ?? 0),
    );

    // Focused pane not in the list means the user is somewhere else entirely,
    // so the first turn lands on the neediest agent rather than stepping.
    const currentPaneId = await this.client.currentPaneId();
    const current = ordered.findIndex((agent) => agent.pane_id === currentPaneId);

    const next = current < 0 ? ordered[0] : cycle(ordered, current, step);
    if (next) await this.client.focusAgent(next.pane_id);
  }

  /** A failed command is logged and dropped: the pad must never throw at herdr. */
  private async run(label: string, operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } catch (error) {
      this.log.warn(`${label} failed`, { reason: reason(error) });
    }
  }
}

/** Step through `items`, wrapping at both ends. */
function cycle<T>(items: T[], current: number, step: -1 | 1): T | undefined {
  if (items.length === 0) return undefined;
  return items[(current + step + items.length) % items.length];
}
