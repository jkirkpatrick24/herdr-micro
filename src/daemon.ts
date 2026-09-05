import type { Config } from './config.js';
import type { PadControls } from './hardware/controls.js';
import type { CreatorMicro } from './hardware/device.js';
import { ambientLighting, renderSlotLighting } from './hardware/lighting.js';
import type { Logger } from './log.js';
import { renderRow } from './route.js';
import type { SlotView, Store } from './state/store.js';

/**
 * The daemon's presentation and pad wiring, kept out of main.ts so it can be
 * imported without starting anything. main.ts stays the composition root: it
 * owns the sockets, the hardware handle and the process signals, none of which
 * mean anything without a real herdr to talk to.
 */

/** Inbound frames and repaints, reported periodically and at shutdown. */
export type Counters = { eventsIn: number; repaints: number };

/** `<iso timestamp> <LEVEL> <message> key=value key=value` */
export function formatLine(level: string, msg: string, fields?: Record<string, unknown>): string {
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), msg];

  if (fields && Object.keys(fields).length) {
    parts.push(
      Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' '),
    );
  }

  return parts.join(' ');
}

export function makeLogger(
  // stderr, so the status row on stdout stays parseable.
  write: (line: string) => void = (line) => void process.stderr.write(line),
): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>) =>
    write(`${formatLine(level, msg, fields)}\n`);
  return {
    info: (m, f) => line('info', m, f),
    warn: (m, f) => line('warn', m, f),
    error: (m, f) => line('error', m, f),
  };
}

/** The ratio is the point: it shows how much traffic the Store absorbed. */
export function statsFields(counters: Counters): Record<string, unknown> {
  return {
    eventsIn: counters.eventsIn,
    repaints: counters.repaints,
    ratio: counters.repaints ? (counters.eventsIn / counters.repaints).toFixed(1) : 'n/a',
  };
}

/** Every pad write is best-effort: a failed LED update must never stop the daemon. */
export function paint(update: Promise<void>, what: string, log: Logger): void {
  update.catch((error: Error) => log.warn(`${what} failed`, { reason: error.message }));
}

/** Renders the status row, mirroring it onto the pad whenever one is attached. */
export function makePainter(
  pad: CreatorMicro,
  config: Config,
  log: Logger,
  counters: Counters,
  write: (line: string) => void = (line) => void process.stdout.write(line),
): (view: SlotView[]) => void {
  return (view) => {
    counters.repaints++;
    write(`${renderRow(view)}\n`);

    // The row on stdout is the real output; the pad is a bonus when present.
    if (!pad.connected) return;
    paint(pad.setThreadLighting(renderSlotLighting(view, config)), 'LED update', log);
  };
}

/** Pad lighting follows the store; pad input drives the controls. */
/**
 * The slice of PadControls this needs: the dial's current label, and somewhere
 * to hand input. Naming it lets a test supply those two without a cast that
 * would also claim every herdr call PadControls makes.
 */
export type PadControlSurface = Pick<PadControls, 'dialMode' | 'handle'>;

export function wirePad(
  pad: CreatorMicro,
  controls: PadControlSurface,
  store: Store,
  config: Config,
  log: Logger,
): void {
  pad.on('connected', () => {
    log.info('Creator Micro ready');

    // A pad plugged in mid-session has dark keys until something changes, so
    // paint the current state immediately rather than waiting for an event.
    paint(
      pad
        .setAmbientLighting(ambientLighting(controls.dialMode))
        .then(() => pad.setThreadLighting(renderSlotLighting(store.view(), config))),
      'initial LED update',
      log,
    );
  });
  pad.on('disconnected', (reason) => log.warn('Creator Micro disconnected', { reason }));
  pad.on('input', (input) => controls.handle(input));
}
