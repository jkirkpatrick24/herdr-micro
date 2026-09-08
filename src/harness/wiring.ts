/**
 * Joining the harness layer to the pad.
 *
 * This lives here rather than inline in main.ts because main.ts is imported by
 * nothing, so nothing in it can be tested. The pieces below carry real ordering
 * requirements -- the layer sits in front of PadControls, and its ring has to
 * be painted *after* the reconnect paint that would otherwise bury it -- and a
 * requirement no test can see is a requirement that will be undone.
 */

import type { PadControlSurface } from '../daemon.js';
import type { CreatorMicro } from '../hardware/device.js';
import type { HerdrClientEventSource } from '../herdr/client.js';
import type { HarnessLayer } from './layer.js';

/**
 * PadControls with the harness layer in front of it.
 *
 * Every input reaches PadControls, which decides for itself what a consumed one
 * still means: nothing, except for the joystick, whose position it tracks
 * either way so that handing the stick back cannot replay an old push.
 */
export function harnessSurface(
  controls: PadControlSurface,
  layer: HarnessLayer,
): PadControlSurface {
  return {
    // A getter, not a snapshot: the dial mode changes under this object.
    get dialMode() {
      return controls.dialMode;
    },
    handle: (input) => controls.handle(input, layer.intercept(input)),
  };
}

/**
 * The layer's stake in the pad coming and going.
 *
 * Call this *after* `wirePad`. Listeners fire in registration order, and
 * `wirePad`'s `connected` handler paints the dial's own colour unconditionally
 * -- which is right, except when the layer is latched as a dial mode and
 * survived the disconnect. Registering later is what puts the layer's ring back
 * on top rather than under.
 */
export function attachHarnessLayer(pad: CreatorMicro, layer: HarnessLayer): void {
  pad.on('connected', () => layer.repaintRing());
  // An unplugged pad sends nothing more, so this is the one event that means a
  // control press in flight will never be wanted. wirePad registers its own
  // listener for this event; both run.
  pad.on('disconnected', () => layer.reset());
}

/**
 * The layer's stake in the focus moving.
 *
 * Takes the narrow event source rather than the whole client, so what this
 * needs is one subscription and nothing else. The layer acts on whatever herdr
 * has focused, and it is not the only thing that can move that -- the keyboard
 * and any other herdr client can too -- so being told beats watching the pad's
 * own inputs and inferring.
 */
export function attachFocusEvents(client: HerdrClientEventSource, layer: HarnessLayer): void {
  client.on('focus', () => layer.focusMoved());
}
