import type { ControlConfig, DialMode, Direction } from '../config.js';
import type { HerdrClient } from '../herdr/client.js';
import { Key, PageKey } from '../herdr/rpc.js';
import { type Logger, reason } from '../log.js';
import type { Store } from '../state/store.js';
import type { PadInput } from './protocol.js';

// Creator Micro 2 reports a full deflection around 0.43; House's Codex
// firmware uses a different scale and its 0.75 threshold is too high here.
// Engaging further out than it releases stops a resting stick from chattering.
const ENGAGE_DISTANCE = 0.25;
const RELEASE_DISTANCE = 0.1;

/**
 * Joystick sectors, clockwise from angle 0. The angle is a fraction of a full
 * turn, so 0 is right, 0.25 down, and so on; array position IS the mapping.
 */
const SECTORS: Direction[] = ['right', 'down', 'left', 'up'];

/** Agent navigation order: the agent most in need of a human comes first. */
const ATTENTION: Record<string, number> = { blocked: 4, done: 3, working: 2, idle: 1 };

/** Turns pad input into herdr commands. Every action is best-effort. */
export class PadControls {
  private mode: DialMode;
  /** The sector the stick is currently in, or null while it rests near centre. */
  private lastSector: number | null = null;

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

  handle(input: PadInput): void {
    try {
      if (input.kind === 'key') this.handleKey(input.key, input.pressed);
      else if (input.kind === 'dial') this.handleDial(input.action);
      else this.handleJoystick(input.angle, input.distance);
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
      // The stick's sector is mode-relative; forget it so the next nudge acts.
      this.lastSector = null;

      this.onModeChange(this.mode);
      this.log.info('dial mode changed', { mode: this.mode });
      return;
    }

    // Clockwise steps backwards through the lists, matching the pad's legend.
    const step = action === 'clockwise' ? -1 : 1;

    if (this.mode === 'workspaces') void this.run('workspace navigation', this.stepWorkspace(step));
    else if (this.mode === 'agents') void this.run('agent navigation', this.stepAgent(step));
    else {
      // Raw bytes rather than a named key: herdr's send_keys vocabulary has no
      // page key, so this is the only way to page a pane. See PageKey.
      const page = step > 0 ? PageKey.down : PageKey.up;
      void this.run(
        'scroll',
        this.client.sendTextToFocusedPane(page.repeat(this.settings.scrollSteps)),
      );
    }
  }

  /**
   * The stick streams a continuous position, so this fires once per sector
   * entered: holding it in one direction moves one pane, not hundreds.
   */
  private handleJoystick(angle: number, distance: number): void {
    if (distance <= RELEASE_DISTANCE) {
      this.lastSector = null;
      return;
    }

    // Engaging needs a deliberate push; staying engaged needs much less.
    if (this.lastSector === null && distance < ENGAGE_DISTANCE) return;

    const sector = sectorFor(angle);
    if (sector === this.lastSector) return;
    this.lastSector = sector;

    // Checked rather than asserted. sectorFor is total, so this cannot fire --
    // but the alternative is a `!` standing in for an invariant one arithmetic
    // edit could break, and the failure it hid was a silently dropped push.
    const direction = SECTORS[sector];
    if (!direction || this.settings.joystick[direction] !== 'pane') return;

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

/**
 * The sector an angle falls in, rounding to the nearest and wrapping at both
 * ends.
 *
 * The angle arrives unnormalised -- protocol.ts forwards whatever finite number
 * the pad reports -- so it is normalised into [0, 1) first. Taking the modulo
 * of the sector alone is not enough: JavaScript's `%` keeps the sign, so a
 * signed angle produced a negative index and the push was dropped rather than
 * acted on. Up, left and down were all unreachable that way, and the drop was
 * silent.
 */
function sectorFor(angle: number): number {
  const turns = ((angle % 1) + 1) % 1;
  return Math.round(turns * SECTORS.length) % SECTORS.length;
}

/** Step through `items`, wrapping at both ends. */
function cycle<T>(items: T[], current: number, step: -1 | 1): T | undefined {
  if (items.length === 0) return undefined;
  return items[(current + step + items.length) % items.length];
}
