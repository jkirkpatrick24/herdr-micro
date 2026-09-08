/**
 * The interface a harness implements, and the vocabulary the layer speaks.
 *
 * Harnesses differ in *mechanism*, not just vocabulary, which is why this is an
 * effect algebra rather than a map of key to string. A thinking level is text
 * the pad prepends to a prompt; `/clear` is a command that applies on Enter;
 * `/model` opens an interactive list the pad must then drive. A flat table can
 * express the second of those and neither of the others.
 */

import type { AgentStatus } from '../herdr/rpc.js';

/**
 * How a control actuates.
 *
 * `text`, `command`, and `picker` are what a control declares; `keys` is mostly
 * how the layer types its own picker traffic -- the arrows and Enter it sends
 * once a list is open.
 */
export type SendableEffect =
  | { via: 'text'; text: string }
  | { via: 'keys'; keys: string[] }
  | { via: 'command'; command: string };

/**
 * A control's effect. `open` is deliberately a SendableEffect and not an
 * Effect: a picker inside a picker has no meaning, and saying so in the type
 * is better than a runtime branch defending against a shape nothing builds.
 */
export type Effect = SendableEffect | { via: 'picker'; open: SendableEffect };

export type Control = {
  id: string;
  /** For the log now; the popup legend when the layer grows one. */
  label: string;
  /** Which pad key fires this control inside the layer. */
  key: string;
  effect: Effect;
  /**
   * The statuses in which firing is allowed.
   *
   * Typing at a working agent does not do nothing -- it queues characters into
   * whatever the agent shows next, which is worse than a key that declines.
   */
  when: readonly AgentStatus[];
};

export type Harness = {
  /** Matches `AgentInfo.agent`, which shares its vocabulary with `agent.start --kind`. */
  kind: string;
  /**
   * The underglow while this harness holds the layer, as `#rrggbb`.
   *
   * Per harness rather than per layer, so the ring says *which* harness the
   * keys are about to drive, not merely that the layer is open. Omitted falls
   * back to `[harness.underglow] active`, which is what an unrecognised
   * harness gets -- it has no identity to advertise.
   */
  ring?: string;
  controls: Control[];
};
