import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { test } from 'vitest';
import { asArray, isRecord } from './json.js';

import { displayWidth, paintPopup, renderPopup } from './popup-view.js';
import type { SlotView } from './state/store.js';

// Built from a code point: a literal control character in a regex is a lint error.
const CSI = `${String.fromCharCode(27)}\\[`;
const ESC = new RegExp(`${CSI}[0-9;]*m`, 'g');
const plain = (line: string) => line.replace(ESC, '');

function slots(...labels: Array<[string, SlotView['status']] | null>): SlotView[] {
  return Array.from({ length: 6 }, (_, slot) => {
    const entry = labels[slot];
    return entry
      ? { slot, paneId: `w${slot}:p1`, workspaceId: `w${slot}`, label: entry[0], status: entry[1] }
      : { slot, paneId: null, workspaceId: null, label: null, status: null };
  });
}

/** A pane comfortably larger than the panel, as herdr hands one over. */
const panel = (view: SlotView[], columns = 98, rows = 22) => renderPopup(view, columns, rows);
const statusColumn = (line: string) => {
  const text = plain(line);
  const match = /\s{2}(idle|working|blocked|done|unknown)$/.exec(text);
  return match ? displayWidth(text.slice(0, match.index)) : -1;
};
const slotRows = (lines: string[]) => lines.map(plain).filter((l) => /^AG\d\d\b/.test(l));

test('statuses share one column regardless of label length', () => {
  const { lines } = panel(
    slots(['a/omp', 'idle'], ['a-much-longer-workspace/claude', 'working'], ['b/pi', 'blocked']),
  );
  const columns = lines.map(statusColumn).filter((c) => c >= 0);
  assert.equal(columns.length, 3);
  assert.equal(new Set(columns).size, 1, `status column drifted: ${columns.join()}`);
});

test('wide glyphs are measured in cells, so columns stay aligned', () => {
  // An emoji is two cells but two UTF-16 units; a CJK glyph is two cells but
  // one. Measuring with String.length shears these rows in opposite directions.
  const { lines } = panel(slots(['🚀/omp', 'idle'], ['作業場/claude', 'working']));
  const columns = lines.map(statusColumn).filter((c) => c >= 0);
  assert.equal(new Set(columns).size, 1, `status column drifted: ${columns.join()}`);
});

test('the panel is inset, not floated in the middle of the pane', () => {
  // Centring a 59-column panel in a wide pane strands it in whitespace; the
  // pane is sized to the panel, so a fixed inset is the whole story.
  const p = panel(slots(['a/omp', 'idle']), 62, 14);
  assert.equal(p.column, 2);
  assert.equal(p.lines[0], '', 'a blank row above the title');
  assert.equal(p.column, panel(slots(['a/omp', 'idle']), 120, 40).column, 'inset is fixed');
});

test('the paint never writes left of the panel, and never a newline', () => {
  // herdr paints written cells with the pane background, so writing column 1
  // puts the panel against the border; a newline on the last row scrolls it.
  const p = panel(slots(['a/omp', 'idle']));
  const frame = paintPopup(p, 22);
  const placements = [...frame.matchAll(new RegExp(`${CSI}\\d+;(\\d+)H`, 'g'))].map((m) => m[1]);
  assert.equal(placements.length, 22, 'every row is placed absolutely');
  assert.deepEqual([...new Set(placements)], [String(p.column + 1)]);
  assert.ok(!/[\r\n]/.test(frame));
});

test('nothing exceeds the pane, and a short pane keeps the title', () => {
  const wide = 'a'.repeat(200);
  for (const [columns, rows] of [
    [24, 22],
    [40, 8],
    [98, 22],
  ] as const) {
    const p = panel(slots([wide, 'working']), columns, rows);
    assert.ok(p.lines.length <= rows, `${p.lines.length} lines overflows ${rows} rows`);
    for (const line of p.lines) {
      const cells = p.column + displayWidth(plain(line));
      assert.ok(cells <= columns, `${cells} cells overflows ${columns}`);
    }
    // Clipping the hints is recoverable; scrolling the title away is not.
    assert.equal(plain(p.lines.find((l) => l !== '')!), 'Agent status');
  }
});

test('a truncated label is elided rather than silently cut', () => {
  assert.match(
    slotRows(panel(slots(['workspace-with-a-long-name/claude', 'idle']), 30).lines)[0]!,
    /…/,
  );
});

test('empty slots start in the label column', () => {
  const rows = slotRows(panel(slots(['a/omp', 'idle'])).lines);
  assert.equal(rows[1], 'AG01  empty');
  assert.equal(rows[1]!.indexOf('empty'), rows[0]!.indexOf('a/omp'));
});

// ---------------------------------------------------------------------------
// The pane herdr gives us is sized by herdr-plugin.toml, which is hand-written
// and cannot see these constants. Lengthening a hint by two characters is
// enough to start eliding it, and the only symptom is a truncated popup at
// runtime -- so the manifest is checked against a real render here instead.
// ---------------------------------------------------------------------------

/** herdr draws the pane border: one column each side, one row above and below. */
const BORDER_COLUMNS = 2;
const BORDER_ROWS = 2;

function keysPaneSize(): { width: number; height: number } {
  const manifest = parseToml(
    readFileSync(new URL('../herdr-plugin.toml', import.meta.url), 'utf8'),
  );

  // Read out of the parsed TOML rather than asserted onto it: this file is
  // hand-written, so "the manifest says what this test thinks it says" is
  // exactly the thing under test, and a cast would have assumed it.
  const pane = asArray(manifest.panes).find((p) => isRecord(p) && p.id === 'keys');
  assert.ok(isRecord(pane), 'herdr-plugin.toml declares a "keys" pane');

  const { width, height } = pane;
  assert.ok(typeof width === 'number', 'the "keys" pane declares a numeric width');
  assert.ok(typeof height === 'number', 'the "keys" pane declares a numeric height');

  return { width, height };
}

test('the pane declared in herdr-plugin.toml fits the panel without eliding', () => {
  const { width, height } = keysPaneSize();
  // Long labels are expected to elide; the fixed chrome is what must not.
  const { lines } = renderPopup(
    slots(['a/claude', 'working'], ['b/omp', 'idle']),
    width - BORDER_COLUMNS,
    height - BORDER_ROWS,
  );
  const chrome = lines.map(plain).filter((l) => !/^AG\d\d\b/.test(l));

  assert.ok(
    !chrome.some((l) => l.includes('…')),
    `title or hints elided at ${width} columns; widen the keys pane in herdr-plugin.toml`,
  );
});

test('the pane declared in herdr-plugin.toml is tall enough for every row', () => {
  const { width, height } = keysPaneSize();
  const rows = height - BORDER_ROWS;
  const full = renderPopup(slots(), width - BORDER_COLUMNS, rows);
  // renderPopup slices to the row budget, so dropped content is silent: a panel
  // that exactly fills the budget is one row from losing its last hint.
  assert.ok(
    full.lines.length < rows,
    `the panel needs ${full.lines.length} of ${rows} rows; heighten the keys pane in herdr-plugin.toml`,
  );
});
