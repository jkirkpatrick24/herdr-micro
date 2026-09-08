import type { AgentStatus } from './herdr/rpc.js';
import type { SlotView } from './state/store.js';

/** The rendered rows and the 0-based pane column they start at. */
export type Panel = {
  lines: string[];
  column: number;
};

/** Control Sequence Introducer: the prefix every sequence below shares. */
const CSI = '\x1b[';
const RESET = `${CSI}0m`;
const DIM = `${CSI}2m`;
const BOLD = `${CSI}1m`;
/** Erase from the cursor to the end of the line. */
const ERASE_TO_EOL = `${CSI}K`;
/** Absolute cursor position. Both coordinates are 1-based, unlike everything else here. */
const cursorTo = (row: number, column: number): string => `${CSI}${row};${column}H`;
/** 24-bit foreground colour. */
const foreground = (r: number, g: number, b: number): string => `${CSI}38;2;${r};${g};${b}m`;

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: '#F3F4F6',
  working: '#60A5FA',
  done: '#4ADE80',
  blocked: '#FBBF24',
  unknown: '#9CA3AF',
};

/** The pane's own border already reads "Creator Micro keys". */
const TITLE = 'Agent status';
const HINTS = [
  'Keys focus agents · ACT07 Esc · ACT08/09 tabs · ACT12 Enter',
  'Dial: workspaces / agents / harness · Joystick: pane focus',
  'Press q or Esc to close',
];
const EMPTY_LABEL = 'empty';
/** Columns between the key, label, and status columns. */
const GAP = 2;
/** Below this a label is all ellipsis, so stop shrinking it. */
const MIN_LABEL = 6;
/**
 * Inset from the pane's border. The pane is sized to the panel, so there is
 * nothing to centre: two columns and one row, and herdr's own inset supplies
 * the matching margin on the right and below.
 */
const MARGIN_X = 2;
const MARGIN_Y = 1;

function color(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return foreground((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

/**
 * Terminal cells, not UTF-16 units: emoji and CJK glyphs occupy two. Getting
 * this wrong misaligns every column to the right of a non-ASCII label.
 */
export function displayWidth(value: string): number {
  let width = 0;

  for (const char of value) {
    // for...of iterates whole code points, so this is always defined. The
    // fallback stands in for an assertion tsc cannot check; 0 is not wide and
    // not a modifier, so the unreachable case would cost one cell.
    const cp = char.codePointAt(0) ?? 0;

    // Zero-width joiners, combining marks and variation selectors modify the
    // previous glyph rather than adding a cell of their own.
    if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;

    width += isWide(cp) ? 2 : 1;
  }

  return width;
}

/** The double-width ranges: CJK, Hangul, and most emoji. */

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Cuts to `width` cells, leaving one for the ellipsis. */
function truncate(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;

  let out = '';
  for (const char of value) {
    if (displayWidth(out) + displayWidth(char) > width - 1) break;
    out += char;
  }

  return `${out}…`;
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

/** `AG00`-`AG05`: the legend printed on the pad, so a row names its key. */
function keyName(slot: number): string {
  return `AG${String(slot).padStart(2, '0')}`;
}

/**
 * A block of one width, inset from the pane's border. The pane draws its own
 * border, so this draws none, and column widths come from the content on every
 * repaint.
 */
export function renderPopup(view: SlotView[], columns: number, rows: number): Panel {
  const budget = Math.max(MIN_LABEL, columns - 2 * MARGIN_X);

  // The key and status columns are sized by their content, which is short and
  // bounded. The label column takes whatever is left, so it absorbs the squeeze.
  const keyWidth = Math.max(...view.map((slot) => keyName(slot.slot).length));
  const statusWidth = Math.max(0, ...view.map((slot) => (slot.status ?? '').length));
  const fixed = keyWidth + GAP + (statusWidth > 0 ? GAP + statusWidth : 0);

  const labelWidth = Math.min(
    Math.max(...view.map((slot) => displayWidth(slot.label ?? EMPTY_LABEL))),
    Math.max(MIN_LABEL, budget - fixed),
  );

  // Wide enough for the rows or the fixed text, whichever needs more.
  const width = Math.min(
    budget,
    Math.max(fixed + labelWidth, displayWidth(TITLE), ...HINTS.map((h) => displayWidth(h))),
  );

  const rule = `${DIM}${'─'.repeat(width)}${RESET}`;
  const body = [
    `${BOLD}${truncate(TITLE, width)}${RESET}`,
    rule,
    ...view.map((slot) => row(slot, keyWidth, labelWidth)),
    rule,
    ...HINTS.map((hint) => `${DIM}${truncate(hint, width)}${RESET}`),
  ];

  const blank = Array.from({ length: MARGIN_Y }, () => '');
  return { lines: [...blank, ...body].slice(0, rows), column: MARGIN_X };
}

/**
 * Places every row absolutely and erases it rightward, so columns left of the
 * panel keep the pane's background and no newline can scroll the title away.
 */
export function paintPopup(panel: Panel, rows: number): string {
  let out = '';
  for (let row = 1; row <= rows; row++) {
    out += `${cursorTo(row, panel.column + 1)}${panel.lines[row - 1] ?? ''}${ERASE_TO_EOL}`;
  }
  return out;
}

/** One slot: `AG00  workspace/agent  status`. */
function row(slot: SlotView, keyWidth: number, labelWidth: number): string {
  const key = `${DIM}${pad(keyName(slot.slot), keyWidth)}${RESET}${' '.repeat(GAP)}`;

  // An empty slot still prints its key, so the legend always reads top to bottom.
  if (!slot.label || !slot.status) {
    return `${key}${DIM}${truncate(EMPTY_LABEL, labelWidth)}${RESET}`;
  }

  // Padded before tinting, so the status column stays aligned across rows.
  const label = pad(truncate(slot.label, labelWidth), labelWidth);
  const tint = color(STATUS_COLORS[slot.status]);

  return `${key}${tint}${label}${RESET}${' '.repeat(GAP)}${tint}${slot.status}${RESET}`;
}
