import type { AgentStatus } from '../herdr/rpc.js';
import { isRecord } from '../json.js';

export const VENDOR_ID = 0x303a;
export const PRODUCT_ID = 0x8298;
export const USAGE_PAGE = 0xff00;
export const REPORT_ID = 0x06;
export const RPC_CHANNEL = 0x02;
export const REPORT_BYTES = 63;
const MAX_RPC_PAYLOAD = REPORT_BYTES - 2;

// ---------------------------------------------------------------------------
// The pad's wire vocabulary
//
// Catalogued here for the same reason rpc.ts catalogues herdr's: these strings
// are checked by firmware rather than by tsc, so a typo is not a build error --
// it is a control that silently stops working, or a light that never changes.
// ---------------------------------------------------------------------------

export const PadMethod = {
  /** Per-key ("thread") status lighting. */
  threadStatus: 'v.oai.thstatus',
  /** Ambient ring and key RGB configuration. */
  rgbConfig: 'v.oai.rgbcfg',
  /** Vendor HID: key presses and encoder movement. */
  hid: 'v.oai.hid',
  /** Joystick radial position. */
  radial: 'v.oai.rad',
  /** The same payload under the stock firmware's name; both are accepted. */
  radialLegacy: 'kb.radial',
} as const;

/** Encoder key names. Distinct from the AG/ACT legend printed on the pad. */
export const EncoderKey = {
  clockwise: 'ENC_CW',
  counterclockwise: 'ENC_CC',
  button: 'ENC_BTN',
  click: 'ENC_CLK',
} as const;

/** The `act` field: what happened to the key. `turn` is encoder-only. */
export const PadAction = {
  release: 0,
  press: 1,
  turn: 2,
} as const;

export type PadInput =
  | { kind: 'key'; key: string; pressed: boolean }
  | { kind: 'dial'; action: 'clockwise' | 'counterclockwise' | 'click' }
  | { kind: 'joystick'; angle: number; distance: number };

export type ThreadLighting = {
  id: number;
  color: number;
  brightness: number;
  effect: number;
  speed: number;
};

export type AmbientLighting = {
  color: number;
  brightness: number;
  effect: number;
  speed: number;
  magic: number;
};

/**
 * Encode one newline-delimited JSON-RPC request into report-ID-6 frames.
 *
 * Each report is fixed size and zero padded, with a three-byte header:
 * report id, channel, then how many of the remaining bytes are payload.
 */
export function encodeRpc(method: string, params: unknown, id: number): Buffer[] {
  const payload = Buffer.from(
    `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    'utf8',
  );

  const reports: Buffer[] = [];

  for (let offset = 0; offset < payload.length; offset += MAX_RPC_PAYLOAD) {
    const chunk = payload.subarray(offset, offset + MAX_RPC_PAYLOAD);
    const report = Buffer.alloc(REPORT_BYTES + 1, 0);

    report[0] = REPORT_ID;
    report[1] = RPC_CHANNEL;
    report[2] = chunk.length;
    chunk.copy(report, 3);

    reports.push(report);
  }

  return reports;
}

/**
 * Cap on a single unterminated notification. The pad's RPC lines are key and
 * radial events of well under 100 bytes, so this is orders of magnitude above
 * anything legitimate while still bounding what firmware that stops sending
 * newlines can accumulate.
 */
export const MAX_RPC_LINE_CHARS = 8192;

/** Reassembles newline-delimited RPC notifications from report-ID-6 input. */
export class RpcReassembler {
  private text = '';
  /**
   * Set while the tail of an oversized line is still arriving, so it is
   * discarded rather than decoded as a notification of its own.
   */
  private resyncing = false;

  /**
   * `onOverflow` reports a dropped line. It is a callback rather than a Logger
   * so this module stays free of the logging seam: everything else here is a
   * pure decode, and the one caller that has a Logger can supply one.
   */
  constructor(private readonly onOverflow: (chars: number) => void = () => {}) {}

  push(report: Buffer): PadInput[] {
    // Ignore anything that is not a well-formed frame on our channel.
    if (report.length < 3 || report[0] !== REPORT_ID || report[1] !== RPC_CHANNEL) {
      return [];
    }

    const length = report[2] ?? 0;
    if (length > MAX_RPC_PAYLOAD || length > report.length - 3) return [];

    this.text += report.subarray(3, 3 + length).toString('utf8');

    const out: PadInput[] = [];
    let newline: number;

    while ((newline = this.text.indexOf('\n')) >= 0) {
      const line = this.text.slice(0, newline).replace(/\r$/, '');
      this.text = this.text.slice(newline + 1);

      if (this.resyncing) {
        this.resyncing = false;
        continue;
      }

      const input = parseRpcInput(line);
      if (input) out.push(input);
    }

    // Drop the buffer to bound the memory, then resync at the next newline so
    // the tail of the discarded line is not decoded as a notification.
    if (this.text.length > MAX_RPC_LINE_CHARS) {
      const chars = this.text.length;
      this.text = '';
      this.resyncing = true;
      this.onOverflow(chars);
    }

    return out;
  }

  reset(): void {
    this.text = '';
    this.resyncing = false;
  }
}

/** Decode the standard keyboard and consumer-control reports emitted by CM2. */
export function parseStandardInput(report: Buffer, heldKeys: Set<number>): PadInput[] {
  if (report.length === 0) return [];
  if (report[0] === 0x01) return parseKeyboard(report, heldKeys);
  if (report[0] === 0x02) return parseConsumer(report);
  return [];
}

/**
 * A keyboard report lists the keys held right now, not what changed, so
 * presses and releases are the difference against the previous report.
 * `heldKeys` is updated in place to become that previous report.
 */
function parseKeyboard(report: Buffer, heldKeys: Set<number>): PadInput[] {
  const next = new Set<number>();
  for (const code of report.subarray(3)) if (code !== 0) next.add(code);

  const out: PadInput[] = [];

  for (const code of next) {
    if (!heldKeys.has(code)) out.push({ kind: 'key', key: standardKeyName(code), pressed: true });
  }

  for (const code of heldKeys) {
    if (!next.has(code)) out.push({ kind: 'key', key: standardKeyName(code), pressed: false });
  }

  heldKeys.clear();
  for (const code of next) heldKeys.add(code);

  return out;
}

/** HID usage codes map to the AG/ACT legend printed on the pad. */
function standardKeyName(code: number): string {
  if (code >= 0x04 && code <= 0x09) return `AG0${code - 0x04}`;
  if (code >= 0x0a && code <= 0x10) return `ACT${String(code - 0x04).padStart(2, '0')}`;
  return `HID_${code.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** The dial also reports as media keys: volume up/down and play/pause. */
function parseConsumer(report: Buffer): PadInput[] {
  if (report.length < 3) return [];

  const usage = (report[1] ?? 0) | ((report[2] ?? 0) << 8);
  const action =
    usage === 0xe9
      ? 'clockwise'
      : usage === 0xea
        ? 'counterclockwise'
        : usage === 0xcd
          ? 'click'
          : null;

  return action ? [{ kind: 'dial', action }] : [];
}

/** Message shape: `{"m": method, "p": params}`, with single-letter param names. */
function parseRpcInput(line: string): PadInput | null {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(message) || !isRecord(message.p)) return null;

  const method = message.m;
  // a = angle, d = distance, k = key name, act = press/release/turn.
  const { a, d, k, act } = message.p;

  // Joystick.
  if (method === PadMethod.radialLegacy || method === PadMethod.radial) {
    if (typeof a !== 'number' || typeof d !== 'number') return null;
    if (!Number.isFinite(a) || !Number.isFinite(d)) return null;
    return { kind: 'joystick', angle: a, distance: d };
  }

  if (method !== PadMethod.hid || typeof k !== 'string') return null;

  // Encoder: turning reports the direction, pressing reports either of two names.
  if (k === EncoderKey.clockwise && act === PadAction.turn) {
    return { kind: 'dial', action: 'clockwise' };
  }

  if (k === EncoderKey.counterclockwise && act === PadAction.turn) {
    return { kind: 'dial', action: 'counterclockwise' };
  }

  if ((k === EncoderKey.button || k === EncoderKey.click) && act === PadAction.press) {
    return { kind: 'dial', action: 'click' };
  }

  // Keys, restricted to the legend printed on the pad.
  if (act !== PadAction.release && act !== PadAction.press) return null;
  if (/^(?:AG0[0-5]|ACT(?:0[6-9]|1[0-2]))$/.test(k)) {
    return { kind: 'key', key: k, pressed: act === PadAction.press };
  }

  return null;
}

export function colorToNumber(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

/**
 * One key's lighting. An empty slot is dark; resting states are dimmed so a
 * `working` or `blocked` key stands out across the room. Effect 4 is the
 * firmware's breathe, effect 1 is steady.
 */
export function lightingForStatus(
  id: number,
  status: AgentStatus | null,
  colors: { idle: string; working: string; done: string; blocked: string },
): ThreadLighting {
  if (!status) return { id, color: 0, brightness: 0, effect: 0, speed: 0 };

  // `unknown` borrows the idle colour: it means unclassified, never an error.
  const color = colorToNumber(status === 'unknown' ? colors.idle : colors[status]);

  return {
    id,
    color,
    brightness: status === 'idle' || status === 'unknown' ? 0.25 : 1,
    effect: status === 'working' ? 4 : 1,
    speed: status === 'working' ? 0.35 : 0,
  };
}
