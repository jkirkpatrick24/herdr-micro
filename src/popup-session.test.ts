import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createPopupSession, isQuitKey, type PopupIo } from './popup-session.js';
import type { SlotView } from './state/store.js';

// Built from a code point: a literal control character in a source string is
// invisible in a diff, and these are the bytes under test rather than an
// implementation detail -- spelling them out here is what makes the assertions
// mean something the module cannot silently agree with itself about.
const ESC = String.fromCharCode(27);
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_LEAVE = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
/** Every row paintPopup places is one absolute cursor move. */
const placements = (out: string) =>
  [...out.matchAll(new RegExp(`${ESC}\\[\\d+;\\d+H`, 'g'))].length;

function slots(...labels: Array<[string, SlotView['status']] | null>): SlotView[] {
  return Array.from({ length: 6 }, (_, slot) => {
    const entry = labels[slot];
    return entry
      ? { slot, paneId: `w${slot}:p1`, workspaceId: `w${slot}`, label: entry[0], status: entry[1] }
      : { slot, paneId: null, workspaceId: null, label: null, status: null };
  });
}

/**
 * The popup's whole outside world: a terminal it writes to and puts in raw
 * mode, a client it stops, and a process it exits. Held rather than faked out,
 * because the assertions worth making here are about the ORDER these happen in
 * and how many times -- a terminal handed back twice is as broken as one never
 * handed back at all.
 */
function harness(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const writes: string[] = [];
  const rawModes: boolean[] = [];
  const events: string[] = [];

  const io: PopupIo = {
    stdout: {
      write: (text) => {
        writes.push(text);
        events.push('write');
      },
      columns: opts.columns,
      rows: opts.rows,
    },
    stdin: {
      isTTY: opts.isTTY ?? true,
      setRawMode: (raw) => {
        rawModes.push(raw);
        events.push(`raw:${raw}`);
      },
    },
    exit: () => void events.push('exit'),
  };

  const store = { view: () => slots(['fix-auth/claude', 'working']) };
  const client = {
    stop: () => void events.push('stop'),
  };

  return {
    writes,
    rawModes,
    events,
    out: () => writes.join(''),
    session: createPopupSession(store, client, io),
  };
}

// ---------------------------------------------------------------------------
// Borrowing the terminal, and giving it back
// ---------------------------------------------------------------------------

test('entering takes the alternate screen and hides the cursor', () => {
  const h = harness();
  h.session.enter();

  assert.equal(h.out(), `${ALT_ENTER}${HIDE_CURSOR}`);
  assert.deepEqual(
    h.rawModes,
    [true],
    'keys must arrive unbuffered, or q does nothing until Enter',
  );
});

test('quitting hands the terminal back before the process goes away', () => {
  const h = harness();
  h.session.enter();
  h.session.quit();

  // Order is the whole assertion. Exiting before the restore leaves the user on
  // the alternate screen with no cursor and no shell prompt; restoring after
  // process.exit never runs at all.
  assert.deepEqual(h.events, ['write', 'raw:true', 'stop', 'raw:false', 'write', 'exit']);
  assert.equal(h.writes.at(-1), `${SHOW_CURSOR}${ALT_LEAVE}`);
});

test('a second quit does not pop a screen the popup does not own', () => {
  const h = harness();
  h.session.enter();

  // The real shape: herdr sends SIGTERM while the user is already pressing q,
  // or SIGINT and SIGTERM both land. Both handlers are the same function.
  h.session.quit();
  h.session.onKey(Buffer.from('q'));
  h.session.quit();

  assert.equal(h.events.filter((e) => e === 'exit').length, 1);
  assert.equal(h.events.filter((e) => e === 'stop').length, 1, 'the client is stopped once');
  // A second ALT_LEAVE pops the screen *below* the one the popup entered --
  // the user's own scrollback -- so this is not merely redundant work.
  assert.equal(h.out().split(ALT_LEAVE).length - 1, 1, 'the alternate screen is left once');
  assert.deepEqual(h.rawModes, [true, false]);
});

test('a non-TTY stdin is never put into raw mode', () => {
  // setRawMode does not exist on a pipe, and calling it throws. The popup is
  // launched by herdr into a pane, but it is also runnable by hand under a
  // pipe, and that must degrade to a static render rather than a crash.
  const h = harness({ isTTY: false });
  h.session.enter();
  h.session.quit();

  assert.deepEqual(h.rawModes, [], 'raw mode is a TTY-only concern');
  // Everything else still happens: the terminal is still restored.
  assert.equal(h.writes.at(-1), `${SHOW_CURSOR}${ALT_LEAVE}`);
  assert.ok(h.events.includes('exit'));
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test('q, Esc and Ctrl-C each close the popup', () => {
  // The three a terminal user tries unprompted. The popup covers the pane it
  // was opened over, so a key that does not close it looks like a hang.
  for (const [name, key] of [
    ['q', Buffer.from('q')],
    ['Esc', Buffer.from([0x1b])],
    ['Ctrl-C', Buffer.from([0x03])],
  ] as const) {
    assert.ok(isQuitKey(key), name);

    const h = harness();
    h.session.enter();
    h.session.onKey(key);
    assert.ok(h.events.includes('exit'), `${name} must close the popup`);
  }
});

test('an ordinary key leaves the popup open', () => {
  const h = harness();
  h.session.enter();

  for (const key of [Buffer.from('Q'), Buffer.from('x'), Buffer.from('\r'), Buffer.from(' ')]) {
    assert.equal(isQuitKey(key), false, JSON.stringify(key.toString('utf8')));
    h.session.onKey(key);
  }

  assert.ok(!h.events.includes('exit'), 'the popup is still open');
  assert.ok(!h.events.includes('stop'), 'and still connected to herdr');
});

test('an escape sequence is not the Esc key', () => {
  // Every arrow key, function key and bracketed-paste marker arrives with 0x1b
  // as its first byte. Matching on that byte alone closed the popup on a stray
  // cursor key, and closed it on a paste into the pane underneath before the
  // paste landed -- an exit nobody asked for from a panel that otherwise takes
  // no input at all. What tells the two apart is the length.
  const h = harness();
  h.session.enter();

  for (const seq of ['\x1b[A', '\x1b[B', '\x1bOP', '\x1b[200~']) {
    assert.equal(isQuitKey(Buffer.from(seq)), false, JSON.stringify(seq));
    h.session.onKey(Buffer.from(seq));
  }

  assert.ok(!h.events.includes('exit'), 'the popup is still open');
  assert.ok(isQuitKey(Buffer.from([0x1b])), 'while a lone Esc still closes it');
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('the panel is rendered at the size the terminal reports', () => {
  const h = harness({ columns: 98, rows: 10 });
  h.session.render();

  assert.equal(placements(h.out()), 10, 'one absolute placement per row of the pane');
});

test('a stdout that reports no size still renders at a usable default', () => {
  // A piped stdout has no columns or rows at all. Falling through to 0 would
  // paint nothing and look exactly like a popup that failed to start.
  const h = harness();
  h.session.render();

  assert.equal(placements(h.out()), 24);
  assert.ok(h.out().includes('fix-auth/claude'), 'and the default width fits a real label');
});

test('a narrow pane truncates rather than overflowing', () => {
  const wide = harness({ columns: 98, rows: 22 });
  const narrow = harness({ columns: 24, rows: 22 });
  wide.session.render();
  narrow.session.render();

  assert.ok(wide.out().includes('fix-auth/claude'));
  assert.ok(!narrow.out().includes('fix-auth/claude'), 'the label cannot fit 24 columns');
  assert.ok(narrow.out().includes('…'), 'and is elided rather than silently cut');
});

test('render paints the view it is handed, not a re-read of the store', () => {
  // store.on('changed', session.render) passes the new view as the argument.
  // Ignoring it and re-reading the store would still work today, but couples
  // the paint to whatever the store holds at paint time rather than to the
  // view that was announced.
  const h = harness({ columns: 98, rows: 22 });
  h.session.render(slots(['other-branch/omp', 'blocked']));

  assert.ok(h.out().includes('other-branch/omp'));
  assert.ok(!h.out().includes('fix-auth/claude'));
});
