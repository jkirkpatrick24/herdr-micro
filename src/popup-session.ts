import type { HerdrClient } from './herdr/client.js';
import { paintPopup, renderPopup } from './popup-view.js';
import type { SlotView } from './state/store.js';

/**
 * The alternate screen is borrowed, not owned: whatever the popup does, the
 * terminal has to come back with its scrollback and cursor intact. That is why
 * entering and leaving live together here rather than at the two ends of an
 * entry point, where only one of them is easy to forget.
 */
const ALT_ENTER = '\x1b[?1049h';
const ALT_LEAVE = '\x1b[?1049l';
/** The popup takes no typed input, so a parked block cursor is just an artefact. */
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
/** A piped stdout reports no size; the popup still has to render something. */
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/** Everything the popup does to the process, narrowed so a test can hold it. */
export type PopupIo = {
  stdout: { write(text: string): unknown; columns?: number; rows?: number };
  stdin: { isTTY?: boolean; setRawMode(raw: boolean): unknown };
  exit: () => void;
};

export type PopupSession = {
  /** Take the terminal: alternate screen, no cursor, raw keys on a TTY. */
  enter(): void;
  render(view?: SlotView[]): void;
  /** Hand the terminal back, then exit. Safe to call more than once. */
  quit(): void;
  /** Feed one chunk of stdin. */
  onKey(data: Buffer): void;
};

/**
 * q, Esc and Ctrl-C: the three ways out a terminal user will try unprompted.
 *
 * A lone byte, so an escape SEQUENCE is not read as the Esc key. Every arrow
 * key, function key and bracketed-paste marker also arrives with 0x1b first,
 * and matching on that byte alone closed the popup on a stray cursor key --
 * and swallowed a paste into the pane underneath before it landed.
 */
export function isQuitKey(data: Buffer): boolean {
  if (data.length !== 1) return false;

  const key = data.toString('utf8');
  return key === 'q' || key === '\x1b' || key === '\x03';
}

export function createPopupSession(
  store: { view(): SlotView[] },
  client: Pick<HerdrClient, 'stop'>,
  io: PopupIo,
): PopupSession {
  let exiting = false;

  const render = (view: SlotView[] = store.view()): void => {
    const columns = io.stdout.columns ?? DEFAULT_COLUMNS;
    const rows = io.stdout.rows ?? DEFAULT_ROWS;
    io.stdout.write(paintPopup(renderPopup(view, columns, rows), rows));
  };

  const enter = (): void => {
    io.stdout.write(`${ALT_ENTER}${HIDE_CURSOR}`);
    if (io.stdin.isTTY) io.stdin.setRawMode(true);
  };

  const quit = (): void => {
    // SIGINT and SIGTERM can both land, and a 'q' can beat either of them. The
    // second pass would take the terminal out of raw mode and off the alternate
    // screen a second time -- the second ALT_LEAVE pops a screen the popup does
    // not own, taking the user's own scrollback with it.
    if (exiting) return;
    exiting = true;
    client.stop();
    if (io.stdin.isTTY) io.stdin.setRawMode(false);
    io.stdout.write(`${SHOW_CURSOR}${ALT_LEAVE}`);
    io.exit();
  };

  return {
    enter,
    render,
    quit,
    onKey: (data) => {
      if (isQuitKey(data)) quit();
    },
  };
}
