import type { Config, Direction } from '../config.js';
import { ArrowStick } from '../hardware/joystick.js';
import type { PadInput } from '../hardware/protocol.js';
import type { HerdrClient } from '../herdr/client.js';
import { type AgentStatus, Key, PageKey } from '../herdr/rpc.js';
import { type Logger, reason } from '../log.js';
import { harnessFor, isControlKey } from './registry.js';
import type { Control, SendableEffect } from './types.js';

/**
 * The colour the ring should hold, as `#rrggbb`, or `null` to give it back to
 * the dial mode. A colour rather than a named state because the harness picks
 * it -- see `Harness.ring`.
 */
export type RingState = string | null;

/** The slice of the client this layer needs. Narrow so the tests can stand in. */
export type LayerClient = Pick<
  HerdrClient,
  'agentList' | 'currentPaneId' | 'sendTextToPane' | 'sendKeysToPane'
>;

/**
 * The six fixed agent keys. They keep their navigation meaning inside the
 * layer -- see the fall-through in `route`.
 */
const AGENT_KEY = /^AG0[0-5]$/;

/** Just the fields the layer reads off `agent.list`. */
type FocusedAgent = { agent: string; agent_status: AgentStatus; pane_id: string };

type State =
  | { kind: 'inactive' }
  | { kind: 'active'; ring: string }
  | { kind: 'picker'; paneId: string; ring: string };

/**
 * The harness layer: a second meaning for the pad's keys, resolved from the
 * harness running in the focused pane.
 *
 * This sits *in front of* PadControls rather than inside it -- `intercept`
 * returns true when it has consumed an input, and main.ts falls through to the
 * navigation layer when it has not. That is why nothing in hardware/ or
 * state/ knows this exists.
 */
export class HarnessLayer {
  private state: State = { kind: 'inactive' };
  /**
   * Which visit to the layer this is: bumped by entering, by leaving the mode,
   * and by the pad going away. A control press is the user's intent for *one*
   * visit, so it outlives everything smaller -- a focus move, a reconnect
   * repaint, the picker opening underneath it -- and nothing larger.
   */
  private visit = 0;
  /**
   * Bumped whenever navigation re-aims the layer. An effect already sending
   * stays pinned to its original pane; a pending one is dropped rather than
   * going on to steer a picker the user has left.
   */
  private focusEpoch = 0;
  /**
   * True while the dial has `harness` selected as its mode, which is the one
   * and only way in. One door is what keeps the state above this small.
   */
  private latched = false;
  /**
   * Bumped on every state change. Harness resolution is a round trip, so an
   * answer can land after the state that asked for it has gone; this is how it
   * knows nobody is asking any more.
   */
  private ringGeneration = 0;
  /** The tail of the send chain; see `send`. */
  private sending: Promise<void> = Promise.resolve();
  /** Observes every report, including while navigation owns the stick. */
  private readonly stick = new ArrowStick();

  constructor(
    private readonly client: LayerClient,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly onRing: (state: RingState) => void,
  ) {}

  /**
   * Re-assert whatever ring the current state calls for.
   *
   * A latched layer survives the pad being unplugged -- the dial mode is still
   * `harness` when it comes back -- but `wirePad`'s reconnect paint does not
   * know that, and repaints the dial's own colour over it. main.ts calls this
   * afterwards so the ring ends up telling the truth.
   */
  repaintRing(): void {
    if (this.state.kind === 'inactive') return;

    this.onRing(this.state.ring);
    if (this.state.kind === 'active') this.resolveRing('ring reasserted');
  }

  /**
   * The dial moved into or out of `harness` mode. main.ts drives this from
   * PadControls' mode-change callback rather than the layer reading the mode,
   * so PadControls still knows nothing about this class.
   *
   * Not short-circuited on an unchanged value: PadControls reports its mode on
   * every click, and both branches below already decline to act when there is
   * nothing to do.
   */
  setLatched(latched: boolean): void {
    this.latched = latched;

    if (latched) {
      if (this.state.kind === 'inactive') this.enter();
    } else {
      // Clicking out of harness mode abandons a control press still in flight.
      // Letting it land afterwards opens a picker in a dial mode the user has
      // left, and captures the pad until it is ended.
      this.visit++;
      this.exit();
    }
  }

  /**
   * True when this layer consumed the input and PadControls must not act on it.
   *
   * The default is false. A bug that claimed too much here would swallow the
   * whole pad, so every branch that returns true is a state this layer is
   * demonstrably in, never a guess.
   */
  intercept(input: PadInput): boolean {
    if (!this.config.harness.enabled) return false;

    try {
      const direction =
        input.kind === 'joystick'
          ? this.stick.read(input.angle, input.distance, this.state.kind === 'inactive')
          : null;
      const consumed = this.route(input, direction);
      if (!consumed && this.movesFocus(input, direction)) this.retarget();
      return consumed;
    } catch (error) {
      // Never let the layer throw into the input path: fail open, so the worst
      // outcome is the navigation layer handling a key the harness layer meant.
      this.log.warn('harness layer failed', { reason: reason(error) });
      // reset, not exit: a throw part-way through a picker must not leave the
      // layer capturing the pad against a list nobody put on screen. It cannot
      // paint -- being in the layer implies `latched`, so its `exit` is reached
      // only when the state is already inactive -- and so cannot throw a second
      // time out of the one method that must never let the input path see one.
      this.reset();
      return false;
    }
  }

  private route(input: PadInput, arrow: Direction | null): boolean {
    // The picker owns the pad while it is open, the agent keys excepted.
    // Letting anything else through would send Esc to the pane from a binding
    // PadControls still holds, closing the list on screen while this layer
    // went on driving one that was no longer there.
    if (this.state.kind === 'picker') return this.routePicker(input, arrow, this.state.paneId);

    if (this.state.kind !== 'active') return false;

    // Clicking still leaves harness mode -- the dial is what opened it, and
    // PadControls owns the mode. Turning scrolls the focused pane: paging a
    // terminal is the same operation whatever runs in it, so it sits beside the
    // stick and Enter rather than in `Harness.controls`.
    if (input.kind === 'dial') {
      if (input.action === 'click') return false;
      // Raw bytes rather than a named key: herdr's send_keys vocabulary has no
      // page key, so this is the only way to page a pane. See PageKey.
      const page = input.action === 'clockwise' ? PageKey.up : PageKey.down;
      const text = page.repeat(this.config.harness.scrollSteps);
      // Queued like every other effect, so a page cannot overtake the arrow or
      // the command in front of it.
      this.enqueue({ via: 'text', text }, 'scroll', null);
      return true;
    }

    // The stick is the arrow keys inside the layer, and not only while a picker
    // is open: committing a list can put another screen up, and the pad has
    // left picker state by the time that appears.
    if (input.kind === 'joystick') {
      if (arrow) this.enqueue({ via: 'keys', keys: [Key[arrow]] }, `arrow ${arrow}`, null);
      return true;
    }

    // The six agent keys keep their navigation meaning: the layer acts on the
    // focused agent, so swallowing them would make it impossible to re-aim.
    // Releases fall through with presses, to keep a key's two halves together.
    if (input.kind === 'key' && AGENT_KEY.test(input.key)) return false;

    // Which harness is focused takes a round trip to learn, but "no harness
    // binds this key at all" does not -- so a key no harness binds never gets
    // one. Mashing ACT06 in here should not open a connection per press.
    if (input.kind === 'key' && input.pressed && isControlKey(input.key)) {
      this.background(this.press(input.key, this.visit), 'control press');
      return true;
    }

    // Enter goes to the agent, the same way the stick does, and for the same
    // reason cannot depend on `picker` state. On the layer's own chain rather
    // than PadControls', or it could overtake the arrow that chose the row.
    if (input.kind === 'key' && this.config.controls.buttons[input.key] === 'enter') {
      if (input.pressed) this.enqueue({ via: 'keys', keys: [Key.enter] }, 'enter', null);
      return true;
    }

    // Everything the layer has not claimed keeps its meaning: Esc still
    // cancels, the popup still opens, the tab keys still change tab. This is a
    // mode the user sits in, and killing the rest of the pad for as long as it
    // is selected is not a layer; it is a dead pad.
    return false;
  }

  /**
   * Whether PadControls will move herdr's focus with the input the layer just
   * declined. The bindings are the authority: a direction bound to anything but
   * `pane` focuses nothing, and neither does an unbound key.
   */
  private movesFocus(input: PadInput, direction: Direction | null): boolean {
    if (input.kind === 'joystick') {
      return direction !== null && this.config.controls.joystick[direction] === 'pane';
    }
    if (input.kind !== 'key' || !input.pressed) return false;

    const action = this.config.controls.buttons[input.key];
    return AGENT_KEY.test(input.key) || action === 'tab-prev' || action === 'tab-next';
  }

  /**
   * The user just asked to move the focus, on an input handed back to
   * PadControls. Pre-emptive rather than left to `focusMoved`: the request goes
   * out on another connection, so until herdr says it happened there is a
   * window in which a queued effect would resolve `pane.current` to the pane
   * being arrived at rather than the one it was aimed at.
   *
   * The ring is not repainted -- nothing has moved yet, and herdr will say
   * when it has.
   */
  private retarget(): void {
    this.focusEpoch++;
  }

  /**
   * herdr says the focused pane changed. Re-read the harness so the ring
   * follows onto whatever is there now.
   *
   * `pane.focused` fires when the move actually happened, whoever caused it --
   * the pad, the keyboard, another herdr client.
   *
   * herdr also emits one as a snapshot immediately after every
   * `events.subscribe` (verified on 0.8.2: one `pane_focused` a millisecond
   * behind the ack, naming the pane already focused), so this runs on every
   * reconnect as well as on every move. That is what we would want from a
   * reconnect regardless: effects queued across the gap are dropped, and a
   * picker held across it is abandoned rather than driven on the assumption
   * that nothing moved while the client was away.
   */
  focusMoved(): void {
    // A move this layer did not ask for still leaves queued effects aimed at a
    // pane the user has left.
    this.focusEpoch++;

    // As for the agent-key branch in `routePicker`. Without this the picker
    // keeps the pad -- every key swallowed, every effect dropped by the epoch
    // it no longer matches -- until the user happens to press one of the keys
    // that end a list. `closePicker` repaints and re-resolves.
    if (this.state.kind === 'picker') {
      this.log.info('picker abandoned, focus moved');
      this.closePicker();
      return;
    }

    if (this.state.kind !== 'active') return;

    this.resolveRing('focus moved');
  }

  private routePicker(input: PadInput, arrow: Direction | null, paneId: string): boolean {
    // The stick is the arrow keys while a list is up. A list can read two axes
    // -- Claude Code puts effort on the horizontal -- and the dial has one, so
    // without this the pad reaches some of the picker and not the rest.
    //
    // `[controls.joystick]` is deliberately not consulted: it says where a
    // *pane* push should go, and no pane is being focused here.
    if (input.kind === 'joystick') {
      if (arrow) this.enqueue({ via: 'keys', keys: [Key[arrow]] }, `picker ${arrow}`, paneId);
      return true;
    }

    if (input.kind === 'dial') {
      if (input.action === 'click') {
        this.enqueue({ via: 'keys', keys: [Key.enter] }, 'picker commit', paneId);
        this.closePicker();
      } else {
        // Clockwise steps backwards, matching how the dial reads lists in the
        // navigation layer.
        const key = input.action === 'clockwise' ? Key.up : Key.down;
        this.enqueue({ via: 'keys', keys: [key] }, 'picker move', paneId);
      }
      return true;
    }

    if (input.kind === 'key') {
      // Focusing another agent abandons this picker. Nothing is sent to close
      // the list: dismissing one the user is still reading is worse than the
      // pad and the screen briefly disagreeing.
      if (AGENT_KEY.test(input.key)) {
        // Only the press abandons it. A release can belong to a key pressed
        // before the picker opened, and that must not close it.
        if (!input.pressed) return false;
        this.log.info('picker abandoned, focus moved');
        this.closePicker();
        return false;
      }

      // Releases are swallowed with everything else: only a press ends a list.
      if (!input.pressed) return true;

      if (this.config.controls.buttons[input.key] === 'escape') {
        this.enqueue({ via: 'keys', keys: [Key.escape] }, 'picker cancel', paneId);
        this.closePicker();
      } else if (this.config.controls.buttons[input.key] === 'enter') {
        // The dial click is not the only gesture that means "select". A picker
        // is a list, and the one key on the pad legibly labelled Enter has to
        // commit it -- without this branch it fell through to the swallow below
        // and did nothing at all, which reads as a dead key rather than a
        // declined one.
        this.enqueue({ via: 'keys', keys: [Key.enter] }, 'picker commit', paneId);
        this.closePicker();
      }
    }

    return true;
  }

  /**
   * Become the active layer, and start resolving which harness that means.
   *
   * Both ways in land here -- the dial latching the mode, and a picker handing
   * the pad back -- and both want the identical sequence, so `what` is the only
   * thing that differs and it only reaches the log.
   */
  private enter(what = 'layer open', ring = this.config.harness.underglow.active): void {
    this.visit++;
    this.state = { kind: 'active', ring };
    // Paint before resolving: the layer opening is instant feedback, and the
    // ring settles to the harness's own colour a round trip later.
    this.onRing(ring);
    this.resolveRing(what);
  }

  /**
   * Drop whatever the pad going away invalidates: the stick's position becomes
   * unknown, and a control press mid-round-trip must not land on a pad that is
   * not there. The layer itself stays open if the dial still says `harness` --
   * the mode survives an unplug, and the ring is repainted on the way back.
   */
  reset(): void {
    this.stick.forget();
    this.visit++;
    if (!this.latched) this.exit();
  }

  /**
   * Leave the picker, back to the layer that opened it. Not `exit`: committing
   * or cancelling a list does not leave harness mode, and the dial is still
   * sitting on it. Both ways out of the mode call `exit` themselves, so there
   * is no unlatched case to answer here.
   */
  private closePicker(): void {
    if (this.state.kind !== 'picker') return;
    this.enter('picker closed', this.state.ring);
  }

  /** Back to inactive from wherever, with the ring handed back to the dial. */
  private exit(): void {
    if (this.state.kind === 'inactive') return;
    this.ringGeneration++;
    this.state = { kind: 'inactive' };
    this.onRing(null);
  }

  /**
   * Which harness is in the focused pane, and what it is doing.
   *
   * `focused` is optional on AgentInfo on purpose -- see the note there. When
   * it is absent nothing matches, which lands on the generic harness and an
   * inert layer rather than on a wrong one.
   */
  private async focusedAgent(): Promise<FocusedAgent | null> {
    try {
      const agents = await this.client.agentList();
      return agents.find((candidate) => candidate.focused === true) ?? null;
    } catch (error) {
      this.log.warn('harness resolution failed', { reason: reason(error) });
      return null;
    }
  }

  /**
   * Ask which harness is focused, and paint its ring when the answer lands.
   *
   * Every caller pairs a fresh token with the request, so an answer overtaken
   * by the next state change knows to say nothing.
   */
  private resolveRing(what: string): void {
    const generation = ++this.ringGeneration;
    this.background(this.paintHarnessRing(generation), what);
  }

  private async paintHarnessRing(generation: number): Promise<void> {
    const focused = await this.focusedAgent();

    // Released, or moved on, while the round trip was in flight.
    if (this.ringGeneration !== generation || this.state.kind !== 'active') return;

    const harness = harnessFor(focused?.agent);
    const ring = harness.ring ?? this.config.harness.underglow.active;
    this.state = { kind: 'active', ring };
    this.onRing(ring);
    this.log.info('harness layer open', {
      harness: harness.kind,
      status: focused?.agent_status ?? 'none',
      controls: harness.controls.length,
    });
  }

  /**
   * Fire whatever the current harness binds to this key.
   *
   * The harness and status are re-read rather than taken from the snapshot
   * `paintHarnessRing` left behind: a mode is sat in for as long as the user
   * likes, so sitting through an `idle -> working` transition would leave the
   * `when` gate waving through exactly the keystrokes it exists to stop. The
   * agent it resolves is also where every part of the effect is sent.
   *
   * `visit` is the visit the key was pressed in. Asking `state.kind` instead
   * would fire a press the user abandoned, whenever they have come back by the
   * time the answer lands.
   */
  private async press(key: string, visit: number): Promise<void> {
    const epoch = this.focusEpoch;
    const focused = await this.focusedAgent();
    if (this.visit !== visit || this.focusEpoch !== epoch) {
      this.log.info('harness control abandoned', { key });
      return;
    }

    // Two presses inside one round trip both pass `route`'s state check, since
    // the state only becomes `picker` when the first of them resolves. Firing
    // the second types its command into the list the first just opened.
    if (this.state.kind === 'picker') {
      this.log.info('harness control declined, picker already open', { key });
      return;
    }

    const harness = harnessFor(focused?.agent);
    // A null focus resolves to the generic harness, which binds nothing -- so
    // finding a control is already proof that `focused` is non-null.
    const control = harness.controls.find((candidate) => candidate.key === key);
    if (!control || !focused) {
      // Reached whenever some *other* harness binds this key: `isControlKey`
      // answers for all of them, which is what keeps a press off the wire.
      this.log.info('harness control declined, none bound', { key, harness: harness.kind });
      return;
    }

    if (!control.when.includes(focused.agent_status)) {
      this.log.info('harness control declined', {
        control: control.id,
        status: focused.agent_status,
      });
      return;
    }

    this.fire(control, focused.pane_id);
  }

  private fire(control: Control, paneId: string): void {
    this.log.info('harness control fired', { control: control.id });

    if (control.effect.via === 'picker') {
      // The picker latches *before* the send resolves: a key pressed while the
      // opener is still on the wire belongs to the list, not to the layer
      // behind it.
      this.enqueue(control.effect.open, control.label, paneId);
      this.openPicker(paneId);
      return;
    }

    this.enqueue(control.effect, control.label, paneId);
  }

  /**
   * Latch the pad onto the list the control opened.
   *
   * There is no timer. A picker is held until the user ends it, because every
   * way out is a single input already under a finger: the dial click and the
   * Enter binding commit, the Esc binding cancels, an agent key abandons it on
   * the way past, and the focus moving by any other route ends it too. Since
   * the dial click is one of them, clicking round to another mode ends the
   * picker on the first click and changes mode on the one after.
   */
  private openPicker(paneId: string): void {
    if (this.state.kind !== 'active') return;
    this.ringGeneration++;
    this.state = { kind: 'picker', paneId, ring: this.state.ring };
  }

  /**
   * Queue a send behind the ones before it. The picker latches synchronously
   * but its opener takes a round trip, so a chain is what keeps the arrows and
   * commits behind it, in finger order.
   */
  private enqueue(effect: SendableEffect, what: string, paneId: string | null): void {
    const epoch = this.focusEpoch;

    this.sending = this.sending
      .then(async () => {
        // Pending effects belong to the focus the user has not yet left.
        if (this.focusEpoch !== epoch) {
          this.log.info('harness effect dropped, focus moved', { what });
          return;
        }
        // Held arrows outside a picker have no bound agent. Resolve their pane
        // once, and reject an answer overtaken by navigation.
        const target = paneId ?? (await this.client.currentPaneId());
        if (!target || this.focusEpoch !== epoch) return;
        return this.send(effect, target);
      })
      .catch((error) => {
        this.log.warn('harness effect failed', { what, reason: reason(error) });
      });
  }

  private async send(effect: SendableEffect, paneId: string): Promise<void> {
    if (effect.via === 'keys') return this.client.sendKeysToPane(paneId, effect.keys);
    if (effect.via === 'text') return this.client.sendTextToPane(paneId, effect.text);

    await this.client.sendTextToPane(paneId, effect.command);
    await this.client.sendKeysToPane(paneId, [Key.enter]);
  }

  /**
   * Run a step the input path started but does not wait for. `intercept`'s
   * try/catch covers only the synchronous routing, so without this a throw in a
   * resolution, send or paint would surface as an unhandled rejection rather
   * than as the fail-open this class promises.
   */
  private background(work: Promise<void>, what: string): void {
    void work.catch((error) => {
      this.log.warn('harness step failed', { what, reason: reason(error) });
    });
  }
}
