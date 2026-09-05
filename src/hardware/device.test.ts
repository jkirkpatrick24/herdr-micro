import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';

import type { Logger } from '../log.js';
import { fakeHid, padDeviceInfo } from '../testing/fake-pad.js';
import { silentLogger } from '../testing/fixtures.js';
import { CreatorMicro } from './device.js';
import { MAX_RPC_LINE_CHARS, type PadInput } from './protocol.js';

const RETRY = 15;

function pad(opts: { listing?: ReturnType<typeof padDeviceInfo>[]; log?: Logger } = {}) {
  const hid = fakeHid(opts.listing ?? [padDeviceInfo()]);
  const device = new CreatorMicro(opts.log ?? silentLogger, {
    hid: hid.backend,
    retryMs: RETRY,
  });
  const inputs: PadInput[] = [];
  const events: string[] = [];
  device.on('input', (i) => void inputs.push(i));
  device.on('connected', () => void events.push('connected'));
  device.on('disconnected', (why) => void events.push(`disconnected:${why}`));
  return { hid, device, inputs, events };
}

/** A single vendor-channel input report carrying one complete RPC line. */
function reportFor(message: string): Buffer {
  const body = Buffer.from(`${message}\n`, 'utf8');
  const report = Buffer.alloc(64, 0);
  report[0] = 6;
  report[1] = 2;
  report[2] = body.length;
  body.copy(report, 3);
  return report;
}

/** The decoded payload of every RPC frame written to the pad, reassembled. */
function writtenRpc(writes: number[][]): string[] {
  const lines: string[] = [];
  let current = '';
  for (const report of writes) {
    const length = report[2] ?? 0;
    current += Buffer.from(report.slice(3, 3 + length)).toString('utf8');
    while (current.includes('\n')) {
      const at = current.indexOf('\n');
      lines.push(current.slice(0, at));
      current = current.slice(at + 1);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Finding the pad
// ---------------------------------------------------------------------------

test('the pad is matched on vendor, product and usage page together', (t) => {
  // The Creator Micro publishes several HID interfaces on the same
  // vendor/product pair; only the 0xFF00 vendor page carries the RPC channel,
  // so matching on vendor and product alone opens a handle that never answers.
  const decoys = [
    { vendorId: 0x1234, productId: 0x8298, usagePage: 0xff00, path: '/wrong-vendor' },
    { vendorId: 0x303a, productId: 0x0001, usagePage: 0xff00, path: '/wrong-product' },
    { vendorId: 0x303a, productId: 0x8298, usagePage: 0x0001, path: '/keyboard-page' },
    { vendorId: 0x303a, productId: 0x8298, usagePage: 0xff00, path: undefined },
    padDeviceInfo('/the-real-one'),
  ];
  const { hid, device } = pad({ listing: decoys });
  t.onTestFinished(() => device.stop());

  device.start();

  assert.deepEqual(hid.openPaths, ['/the-real-one']);
  assert.equal(device.connected, true);
});

test('an absent pad is retried until it appears, without ever throwing', async (t) => {
  const { hid, device, events } = pad({ listing: [] });
  t.onTestFinished(() => device.stop());

  device.start();
  assert.equal(device.connected, false, 'nothing to open yet');
  assert.equal(events.length, 0, 'and nothing to announce');

  // The daemon is expected to run with the pad unplugged and pick it up
  // whenever it arrives, so this is the normal startup path, not an error one.
  hid.setListing([padDeviceInfo()]);
  for (let i = 0; i < 100 && !device.connected; i++) await delay(RETRY);

  assert.equal(device.connected, true);
  assert.deepEqual(events, ['connected']);
});

test('an open that throws is contained and retried', async (t) => {
  const warnings: string[] = [];
  const log: Logger = { info() {}, warn: (m) => void warnings.push(m), error() {} };
  const { hid, device } = pad({ log });
  t.onTestFinished(() => device.stop());
  hid.failOpen(new Error('cannot open HID device'));

  device.start();
  assert.equal(device.connected, false);
  assert.deepEqual(warnings, ['Creator Micro unavailable']);

  // Another process holding the handle is transient; releasing it must be
  // enough for the daemon to recover on its own.
  hid.failOpen(null);
  for (let i = 0; i < 100 && !device.connected; i++) await delay(RETRY);
  assert.equal(device.connected, true);
});

// ---------------------------------------------------------------------------
// Reports in
// ---------------------------------------------------------------------------

test('both report families reach listeners from the one handle', (t) => {
  const { hid, device, inputs } = pad();
  t.onTestFinished(() => device.stop());
  device.start();

  // Standard keyboard report: a press, then its release.
  hid.pad.emitData(Buffer.from([1, 0, 0, 0x04]));
  hid.pad.emitData(Buffer.from([1, 0, 0, 0]));
  // Vendor RPC report on the same handle: the dial.
  const line = Buffer.from('{"m":"v.oai.hid","p":{"k":"ENC_CW","act":2}}\n');
  hid.pad.emitData(Buffer.concat([Buffer.from([6, 2, line.length]), line]));

  assert.deepEqual(inputs, [
    { kind: 'key', key: 'AG00', pressed: true },
    { kind: 'key', key: 'AG00', pressed: false },
    { kind: 'dial', action: 'clockwise' },
  ]);
});

test('reconnecting clears held keys and any half-received line', async (t) => {
  const { hid, device, inputs } = pad();
  t.onTestFinished(() => device.stop());
  device.start();

  // A key goes down and the pad is yanked before its release arrives.
  hid.pad.emitData(Buffer.from([1, 0, 0, 0x04]));
  const head = Buffer.from('{"m":"v.oai.hid","p":{"k":"AG0');
  hid.pad.emitData(Buffer.concat([Buffer.from([6, 2, head.length]), head]));
  const before = inputs.length;

  hid.pad.emitError(new Error('device disconnected'));
  for (let i = 0; i < 100 && !device.connected; i++) await delay(RETRY);
  assert.equal(device.connected, true, 'the pad came back');

  // Stale held keys would report a phantom release on the first report after
  // reconnect; a stale prefix would splice into the next RPC line.
  const tail = Buffer.from('0","act":1}}\n');
  hid.pad.emitData(Buffer.concat([Buffer.from([6, 2, tail.length]), tail]));
  hid.pad.emitData(Buffer.from([1, 0, 0, 0]));

  assert.equal(inputs.length, before, 'neither fragment survived the reconnect');
});

// ---------------------------------------------------------------------------
// Losing the pad
// ---------------------------------------------------------------------------

test('a HID error closes the handle, announces the reason, and reconnects', async (t) => {
  const { hid, device, events } = pad();
  t.onTestFinished(() => device.stop());
  device.start();
  const first = hid.pad;

  first.emitError(new Error('device disconnected'));

  assert.equal(device.connected, false, 'the dead handle is dropped at once');
  assert.equal(first.closed, true, 'and actually closed rather than leaked');
  assert.equal(first.listenerCount, 0, 'its listeners are detached');
  assert.deepEqual(events, ['connected', 'disconnected:device disconnected']);

  for (let i = 0; i < 100 && !device.connected; i++) await delay(RETRY);
  assert.deepEqual(events, ['connected', 'disconnected:device disconnected', 'connected']);
});

test('a close that throws is warned about, not propagated', (t) => {
  const warnings: string[] = [];
  const log: Logger = { info() {}, warn: (m) => void warnings.push(m), error() {} };
  const { hid, device, events } = pad({ log });
  t.onTestFinished(() => device.stop());
  device.start();
  // The OS handle is already gone, so close() fails. Nothing about that changes
  // what the daemon should do next.
  hid.pad.failClose(new Error('handle already closed'));

  assert.doesNotThrow(() => device.stop());

  assert.deepEqual(warnings, ['Creator Micro close failed']);
  assert.deepEqual(events, ['connected', 'disconnected:stopped']);
});

test('stop halts the retry loop rather than reconnecting behind the daemon', async () => {
  const { hid, device, events } = pad({ listing: [] });
  device.start();
  device.stop();

  // A retry firing after shutdown reopens a handle nothing will ever close,
  // and keeps the process alive past its own exit path.
  hid.setListing([padDeviceInfo()]);
  await delay(RETRY * 6);

  assert.equal(hid.opens, 0);
  assert.equal(device.connected, false);
  assert.deepEqual(events, [], 'a pad that never connected has nothing to report');
});

test('start is idempotent, so a second call cannot open a second handle', (t) => {
  const { hid, device } = pad();
  t.onTestFinished(() => device.stop());

  device.start();
  device.start();

  assert.equal(hid.opens, 1);
});

// ---------------------------------------------------------------------------
// Writes out
// ---------------------------------------------------------------------------

test('lighting commands are written as report-ID-6 RPC frames', async (t) => {
  const { hid, device } = pad();
  t.onTestFinished(() => device.stop());
  device.start();

  await device.setThreadLighting([
    { id: 0, color: 0x1e5aa8, brightness: 1, effect: 4, speed: 0.35 },
  ]);
  await device.setAmbientLighting({
    color: 0x2277ff,
    brightness: 0.5,
    effect: 1,
    speed: 0,
    magic: 0,
  });

  for (const report of hid.pad.writes) {
    assert.deepEqual(report.slice(0, 2), [6, 2], 'report id and channel');
    assert.equal(report.length, 64);
  }

  const sent = writtenRpc(hid.pad.writes).map((l) => JSON.parse(l));
  assert.deepEqual(sent[0], {
    jsonrpc: '2.0',
    id: 1,
    method: 'v.oai.thstatus',
    params: [{ id: 0, c: 0x1e5aa8, b: 1, e: 4, s: 0.35 }],
  });
  assert.deepEqual(sent[1], {
    jsonrpc: '2.0',
    id: 2,
    method: 'v.oai.rgbcfg',
    params: {
      ambient: { e: 1, b: 0.5, s: 0, m: 0, c: 0x2277ff },
      keys: { e: 0, b: 0, s: 0, m: 0, c: 0 },
    },
  });
});

test('writing with no pad attached rejects instead of throwing into the caller', async (t) => {
  const { device } = pad({ listing: [] });
  t.onTestFinished(() => device.stop());
  device.start();

  // main.ts treats every pad write as best-effort and only logs the reason, so
  // this has to be a rejection rather than a synchronous throw.
  await assert.rejects(
    () => device.setAmbientLighting({ color: 0, brightness: 0, effect: 0, speed: 0, magic: 0 }),
    /not connected/,
  );
});

test('a write aimed at a handle that has since been replaced is refused', async (t) => {
  const { hid, device } = pad();
  t.onTestFinished(() => device.stop());
  device.start();
  const first = hid.pad;

  // Queue a write, then lose the pad before the queue drains. Writing to the
  // old handle would either throw inside node-hid or paint the wrong device.
  const inFlight = device.setThreadLighting([]);
  first.emitError(new Error('device disconnected'));

  await assert.rejects(() => inFlight, /not connected/);
  assert.deepEqual(first.writes, []);
});

test('a failed write does not wedge the queue behind it', async (t) => {
  const { hid, device } = pad();
  t.onTestFinished(() => device.stop());
  device.start();

  hid.pad.failWrite(new Error('write failed'));
  await assert.rejects(() => device.setThreadLighting([]), /write failed/);

  // The queue is a single chained promise; a rejection left unhandled on it
  // would stop every later repaint for the life of the process.
  hid.pad.failWrite(null); // stop failing; the queue must still be usable
  await device.setThreadLighting([{ id: 0, color: 1, brightness: 1, effect: 1, speed: 0 }]);

  // One RPC line, however many 64-byte reports it took to carry it.
  const sent = writtenRpc(hid.pad.writes).map((l) => JSON.parse(l).method);
  assert.deepEqual(sent, ['v.oai.thstatus'], 'the next paint still got through');
});

test('writes are serialised in call order', async (t) => {
  const { hid, device } = pad();
  t.onTestFinished(() => device.stop());
  device.start();

  // Fired without awaiting, as the painter does on a burst of repaints. HID
  // writes are not reentrant, so interleaving them corrupts a multi-frame RPC.
  const all = [
    device.setThreadLighting([{ id: 0, color: 1, brightness: 1, effect: 1, speed: 0 }]),
    device.setThreadLighting([{ id: 1, color: 2, brightness: 1, effect: 1, speed: 0 }]),
    device.setThreadLighting([{ id: 2, color: 3, brightness: 1, effect: 1, speed: 0 }]),
  ];
  await Promise.all(all);

  const ids = writtenRpc(hid.pad.writes).map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, [1, 2, 3]);
});

test('an oversized pad notification is reported and the channel resyncs', () => {
  const warnings: string[] = [];
  const log: Logger = { info() {}, warn: (m) => void warnings.push(m), error() {} };
  const { hid, device, inputs } = pad({ log });
  device.start();

  // Firmware that stops emitting newlines: 61 payload bytes a report, past the cap.
  const filler = Buffer.alloc(64, 0);
  filler[0] = 6;
  filler[1] = 2;
  filler[2] = 61;
  filler.fill(0x78, 3);
  for (let sent = 0; sent <= MAX_RPC_LINE_CHARS; sent += 61) hid.pad.emitData(filler);

  assert.equal(
    warnings.filter((w) => w.includes('oversized pad notification')).length,
    1,
    'reported once per dropped line, not per report',
  );
  assert.deepEqual(inputs, [], 'nothing decodes out of a dropped line');

  // The tail is discarded, then the pad is usable again.
  hid.pad.emitData(reportFor('xxx"}}'));
  hid.pad.emitData(reportFor('{"m":"v.oai.hid","p":{"k":"AG03","act":1}}'));
  assert.deepEqual(inputs, [{ kind: 'key', key: 'AG03', pressed: true }]);
});
