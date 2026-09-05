import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';

import { DEFAULT_CONFIG } from './config.js';
import {
  type Counters,
  formatLine,
  makeLogger,
  makePainter,
  type PadControlSurface,
  paint,
  statsFields,
  wirePad,
} from './daemon.js';
import { CreatorMicro } from './hardware/device.js';
import type { PadInput } from './hardware/protocol.js';
import type { Logger } from './log.js';
import { Store } from './state/store.js';
import { fakeHid, padDeviceInfo } from './testing/fake-pad.js';
import { pane, silentLogger, snapshot, workspace } from './testing/fixtures.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

/** wirePad reads the dial's label and hands input to handle(); nothing else. */
function controlSurface(handle: (input: PadInput) => void = () => {}): PadControlSurface {
  return { dialMode: 'workspaces', handle };
}

function recorder() {
  const lines: string[] = [];
  const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const log: Logger = {
    info: () => {},
    warn: (msg, fields) => void warnings.push({ msg, fields }),
    error: () => {},
  };
  return { lines, warnings, log, write: (line: string) => void lines.push(line) };
}

/** A real CreatorMicro over a fake HID backend, so the pad's events are real. */
function attachedPad() {
  const hid = fakeHid([padDeviceInfo()]);
  const pad = new CreatorMicro(silentLogger, { hid: hid.backend, retryMs: 5 });
  return { hid, pad };
}

// ---------------------------------------------------------------------------
// Log formatting
// ---------------------------------------------------------------------------

test('a log line is timestamped, levelled, and carries its fields as key=value', () => {
  const line = formatLine('warn', 'herdr stream lost', { reason: 'socket closed', attempt: 3 });

  assert.match(line, ISO);
  // The level column is padded so messages align down the log.
  assert.ok(line.includes('WARN  herdr stream lost'), line);
  // Strings unquoted, everything else JSON: a reason reads as prose rather than
  // as an escaped blob, which is the whole point of the split.
  assert.ok(line.endsWith('reason=socket closed attempt=3'), line);
});

test('a log line with no fields carries no trailing separator', () => {
  assert.ok(formatLine('info', 'Creator Micro ready').endsWith('Creator Micro ready'));
  assert.ok(formatLine('info', 'Creator Micro ready', {}).endsWith('Creator Micro ready'));
});

test('the logger stamps each level and ends every line', () => {
  const { lines, write } = recorder();
  const log = makeLogger(write);

  log.info('connected', { path: '/tmp/h.sock' });
  log.warn('slow');
  log.error('fatal');

  assert.deepEqual(
    lines.map((l) => l.split(/\s+/)[1]),
    ['INFO', 'WARN', 'ERROR'],
  );
  for (const line of lines) assert.ok(line.endsWith('\n'), 'lines are written whole');
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

test('the event-to-repaint ratio survives a zero repaint count', () => {
  // The dedupe gate means repaints can legitimately be zero while events pour
  // in -- which is exactly when the ratio is most worth logging, and exactly
  // when dividing by it yields Infinity.
  assert.deepEqual(statsFields({ eventsIn: 75, repaints: 0 }), {
    eventsIn: 75,
    repaints: 0,
    ratio: 'n/a',
  });
  assert.deepEqual(statsFields({ eventsIn: 75, repaints: 6 }), {
    eventsIn: 75,
    repaints: 6,
    ratio: '12.5',
  });
  assert.equal(statsFields({ eventsIn: 0, repaints: 0 }).ratio, 'n/a');
});

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

test('a failed pad write is logged and swallowed', async () => {
  const { warnings, log } = recorder();

  // paint() is the containment point for every LED write in the daemon: an
  // unhandled rejection here would take the process down over a cosmetic
  // failure while herdr and the store are both perfectly healthy.
  assert.doesNotThrow(() =>
    paint(Promise.reject(new Error('device disconnected')), 'LED update', log),
  );
  await delay(5);

  assert.deepEqual(warnings, [
    { msg: 'LED update failed', fields: { reason: 'device disconnected' } },
  ]);
});

test('the painter writes a status row per repaint and counts it', () => {
  const { log, write, lines } = recorder();
  const { pad } = attachedPad();
  const counters: Counters = { eventsIn: 0, repaints: 0 };
  const store = new Store(silentLogger);
  const painter = makePainter(pad, DEFAULT_CONFIG, log, counters, write);

  store.applySeed(
    snapshot([workspace('w1', 'fix-auth')], [pane('w1:p1', 'w1', { agent: 'claude' })]),
  );
  painter(store.view());
  painter(store.view());

  assert.equal(counters.repaints, 2);
  assert.match(lines[0]!, /fix-auth\/claude/);
  for (const line of lines) assert.ok(line.endsWith('\n'), 'the row is a whole line');
});

test('the row still prints with no pad attached, and quietly', async () => {
  const { log, write, lines, warnings } = recorder();
  // No pad on the bus at all: the daemon is expected to be useful as a plain
  // status row, so the stdout half must not be gated on the hardware.
  const hid = fakeHid([]);
  const pad = new CreatorMicro(silentLogger, { hid: hid.backend, retryMs: 5 });
  pad.start();
  const counters: Counters = { eventsIn: 0, repaints: 0 };
  const painter = makePainter(pad, DEFAULT_CONFIG, log, counters, write);

  for (let i = 0; i < 3; i++) painter([]);
  await delay(5);

  assert.equal(pad.connected, false);
  assert.equal(lines.length, 3);
  assert.equal(counters.repaints, 3);
  assert.equal(hid.opens, 0, 'and nothing is written to a pad that is not there');
  // Skipping the write is what keeps this quiet. Attempting it instead would
  // reject, and paint() would dutifully log a warning on every single repaint
  // for as long as the pad stays unplugged -- which is the normal case.
  assert.deepEqual(warnings, [], 'an absent pad is not an error to report per repaint');
});

test('an attached pad is painted with the configured colours', async () => {
  const { log, write } = recorder();
  const { hid, pad } = attachedPad();
  pad.start();
  const store = new Store(silentLogger);
  store.applySeed(
    snapshot([workspace('w1', 'fix-auth')], [pane('w1:p1', 'w1', { agent: 'claude' })]),
  );
  store.applyPaneStatus('w1:p1', 'blocked');

  makePainter(pad, DEFAULT_CONFIG, log, { eventsIn: 0, repaints: 0 }, write)(store.view());
  await delay(5);

  const sent = JSON.parse(
    hid.pad.writes
      .map((r) => Buffer.from(r.slice(3, 3 + (r[2] ?? 0))).toString('utf8'))
      .join('')
      .trim(),
  );
  assert.equal(sent.method, 'v.oai.thstatus');
  assert.equal(sent.params.length, 6, 'all six threads, occupied or not');
  assert.equal(sent.params[0].c, 0xc87a0a, 'the blocked colour from DEFAULT_CONFIG');
  assert.equal(sent.params[1].b, 0, 'and an empty slot stays dark');
});

// ---------------------------------------------------------------------------
// Pad wiring
// ---------------------------------------------------------------------------

test('a pad appearing is announced and lit from current state, not left dark', async () => {
  const { warnings, log } = recorder();
  const hid = fakeHid([]);
  const pad = new CreatorMicro(silentLogger, { hid: hid.backend, retryMs: 5 });
  const store = new Store(silentLogger);
  wirePad(pad, controlSurface(), store, DEFAULT_CONFIG, log);
  store.applySeed(
    snapshot([workspace('w1', 'fix-auth')], [pane('w1:p1', 'w1', { agent: 'claude' })]),
  );
  store.applyPaneStatus('w1:p1', 'working');

  // The pad is plugged in after the daemon is already running and already
  // knows the state; without this it would sit dark until the next repaint,
  // which for an idle session may never come.
  pad.start();
  hid.setListing([padDeviceInfo()]);
  for (let i = 0; i < 100 && !pad.connected; i++) await delay(5);
  await delay(10);

  const methods = hid.pad.writes
    .map((r) => Buffer.from(r.slice(3, 3 + (r[2] ?? 0))).toString('utf8'))
    .join('')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).method);
  assert.deepEqual(methods, ['v.oai.rgbcfg', 'v.oai.thstatus'], 'ring first, then the keys');
  assert.deepEqual(warnings, []);
});

test('pad input is handed to the controls', async () => {
  const { log } = recorder();
  const { hid, pad } = attachedPad();
  const handled: string[] = [];
  const controls = controlSurface((input) => void handled.push(input.kind));
  wirePad(pad, controls, new Store(silentLogger), DEFAULT_CONFIG, log);

  pad.start();
  hid.pad.emitData(Buffer.from([1, 0, 0, 0x04]));

  assert.deepEqual(handled, ['key']);
});

test('losing the pad is reported with its reason rather than silently', async () => {
  const { warnings, log } = recorder();
  const { hid, pad } = attachedPad();
  wirePad(pad, controlSurface(), new Store(silentLogger), DEFAULT_CONFIG, log);
  pad.start();

  hid.pad.emitError(new Error('device disconnected'));

  assert.deepEqual(warnings, [
    { msg: 'Creator Micro disconnected', fields: { reason: 'device disconnected' } },
  ]);
});
