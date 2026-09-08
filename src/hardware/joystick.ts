import type { Direction } from '../config.js';

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

/**
 * The stick, read as one direction per push.
 *
 * The pad streams a continuous position, so this reports once per sector
 * *entered*: pushing and holding is one move rather than one per report, which
 * is what a pane focus and a list both expect, and what a held stick would
 * otherwise flood.
 *
 * There is one of these per reader, but only one opinion about where `left`
 * begins -- the dead zone and the sector maths live here rather than in each
 * caller, because two copies would show up as the pad disagreeing with itself
 * about the same push.
 *
 * Every reader observes every report, including those it will not act on:
 * ownership of the stick changes when the harness layer opens and closes, and
 * an already-held direction must not become a new push when it does.
 */
export class ArrowStick {
  /** Undefined until a report establishes position; null means known neutral. */
  private sector: number | null | undefined;

  /**
   * The direction this position entered, or null if it entered no new sector.
   *
   * `navigation` says the caller owns the stick by default rather than taking
   * it over: on startup or reconnect the first deflected report may be a hold
   * that predates it, which a taker must ignore and the default owner has
   * nothing better to do with.
   */
  read(angle: number, distance: number, navigation = false): Direction | null {
    const known = this.sector !== undefined;
    if (distance <= RELEASE_DISTANCE) {
      this.sector = null;
      return null;
    }

    // Engaging needs a deliberate push; staying engaged needs much less.
    if (this.sector == null && distance < ENGAGE_DISTANCE) return null;

    const sector = sectorFor(angle);
    if (sector === this.sector) return null;
    this.sector = sector;
    if (!known && !navigation) return null;

    // Checked rather than asserted: sectorFor is total, so this cannot fire,
    // but a `!` here would stand in for an invariant one arithmetic edit could
    // break, and the failure it hid was a silently dropped push.
    return SECTORS[sector] ?? null;
  }

  /** Disconnect makes the physical position unknown, unlike an ownership change. */
  forget(): void {
    this.sector = undefined;
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
