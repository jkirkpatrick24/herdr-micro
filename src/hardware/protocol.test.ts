import assert from 'node:assert/strict';
import { test } from 'vitest';

import { DEFAULT_CONFIG } from '../config.js';
import {
  encodeRpc,
  lightingForStatus,
  MAX_RPC_LINE_CHARS,
  parseStandardInput,
  RpcReassembler,
} from './protocol.js';

/** A single vendor-channel report carrying one complete RPC line. */
const reportFor = (message: string): Buffer => {
  const payload = Buffer.from(`${message}\n`);
  return Buffer.concat([Buffer.from([6, 2, payload.length]), payload]);
};

test('encodeRpc emits report-ID-6 channel frames with a newline', () => {
  const reports = encodeRpc('device.status', {}, 1);
  assert.equal(reports.length, 2);
  for (const report of reports) assert.deepEqual([...report.subarray(0, 2)], [6, 2]);
  const last = reports[reports.length - 1]!;
  const payloadLength = last[2]!;
  assert.equal(
    last
      .subarray(3, 3 + payloadLength)
      .toString('utf8')
      .endsWith('\n'),
    true,
  );
});

test('a chunked payload reassembles byte for byte', () => {
  // Six lit threads is a real command and comfortably longer than one report,
  // so the split is the normal path rather than an edge case.
  const params = Array.from({ length: 6 }, (_, id) => ({ id, c: 0x1e5aa8, b: 1, e: 4, s: 0.35 }));
  const reports = encodeRpc('v.oai.thstatus', params, 7);
  assert.ok(reports.length > 1, 'this payload is meant to span several reports');

  const rebuilt = reports.map((r) => r.subarray(3, 3 + r[2]!).toString('utf8')).join('');
  assert.equal(
    rebuilt,
    `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'v.oai.thstatus', params })}\n`,
  );

  // Every report but the last is packed full. A short one means the offset walk
  // and the declared chunk length disagree, which reaches the pad as a
  // truncated command rather than as an error.
  const lengths = reports.map((r) => r[2]!);
  assert.deepEqual([...new Set(lengths.slice(0, -1))], [61], 'MAX_RPC_PAYLOAD is 63 - 2');
  assert.ok(lengths.at(-1)! <= 61 && lengths.at(-1)! > 0);
  for (const report of reports) assert.equal(report.length, 64, 'fixed size, zero padded');
});

test('RpcReassembler parses a radial message across reports', () => {
  const message = Buffer.from('{"m":"v.oai.rad","p":{"a":0.77,"d":1,"s":4}}\r\n');
  const first = Buffer.alloc(64, 0);
  first[0] = 6;
  first[1] = 2;
  first[2] = 10;
  message.copy(first, 3, 0, 10);
  const second = Buffer.alloc(64, 0);
  second[0] = 6;
  second[1] = 2;
  second[2] = message.length - 10;
  message.copy(second, 3, 10);

  const reassembler = new RpcReassembler();
  assert.deepEqual(reassembler.push(first), []);
  assert.deepEqual(reassembler.push(second), [{ kind: 'joystick', angle: 0.77, distance: 1 }]);
});

test('RpcReassembler decodes Creator Micro vendor HID keys', () => {
  const reassembler = new RpcReassembler();
  assert.deepEqual(reassembler.push(reportFor('{"m":"v.oai.hid","p":{"k":"AG01","act":1}}')), [
    { kind: 'key', key: 'AG01', pressed: true },
  ]);
  assert.deepEqual(reassembler.push(reportFor('{"m":"v.oai.hid","p":{"k":"AG01","act":0}}')), [
    { kind: 'key', key: 'AG01', pressed: false },
  ]);
  assert.deepEqual(reassembler.push(reportFor('{"m":"v.oai.hid","p":{"k":"ACT07","act":1}}')), [
    { kind: 'key', key: 'ACT07', pressed: true },
  ]);

  // 0 and 1 are the only real edges; 2 is the firmware's auto-repeat, which
  // the dial uses as its turn edge. A legend key must reject it rather than
  // fall through to `pressed: act === 1` -- that reads a held key as a
  // phantom RELEASE, so holding AG01 would focus its pane and then look up.
  assert.deepEqual(reassembler.push(reportFor('{"m":"v.oai.hid","p":{"k":"AG01","act":2}}')), []);
  assert.deepEqual(reassembler.push(reportFor('{"m":"v.oai.hid","p":{"k":"ACT07","act":9}}')), []);
});

test('the vendor channel decodes the dial, and only on its acting edge', () => {
  const decode = (message: string) => new RpcReassembler().push(reportFor(message));
  const hid = (k: string, act: number) => `{"m":"v.oai.hid","p":{"k":"${k}","act":${act}}}`;

  // The dial is the one control the pad reports through the vendor channel
  // rather than as a consumer usage, and each key acts on its own edge value.
  assert.deepEqual(decode(hid('ENC_CW', 2)), [{ kind: 'dial', action: 'clockwise' }]);
  assert.deepEqual(decode(hid('ENC_CC', 2)), [{ kind: 'dial', action: 'counterclockwise' }]);
  assert.deepEqual(decode(hid('ENC_BTN', 1)), [{ kind: 'dial', action: 'click' }]);
  // Two firmware spellings of the same button.
  assert.deepEqual(decode(hid('ENC_CLK', 1)), [{ kind: 'dial', action: 'click' }]);

  // Wrong edge: a turn is act 2 and a click act 1, so these are the release and
  // repeat halves. Decoding them would double every dial step the user makes.
  assert.deepEqual(decode(hid('ENC_CW', 1)), []);
  assert.deepEqual(decode(hid('ENC_CC', 0)), []);
  assert.deepEqual(decode(hid('ENC_BTN', 0)), []);
});

test('the vendor channel rejects keys outside the pad legend', () => {
  const decode = (message: string) => new RpcReassembler().push(reportFor(message));
  const hid = (k: string) => `{"m":"v.oai.hid","p":{"k":"${k}","act":1}}`;

  // The pad has six agent keys and ACT06-ACT12; anything else reaching the
  // store would look up a slot that does not exist.
  assert.deepEqual(decode(hid('AG05')), [{ kind: 'key', key: 'AG05', pressed: true }]);
  assert.deepEqual(decode(hid('ACT12')), [{ kind: 'key', key: 'ACT12', pressed: true }]);
  for (const key of ['AG06', 'ACT05', 'ACT13', 'ACT99', 'ESC']) {
    assert.deepEqual(decode(hid(key)), [], key);
  }
});

test('the vendor channel drops malformed lines instead of throwing', () => {
  const decode = (message: string) => new RpcReassembler().push(reportFor(message));

  // Anything here reaches the daemon straight off the wire, so a bad line has
  // to be inert rather than an exception inside the HID data callback.
  assert.deepEqual(decode('not json at all'), []);
  assert.deepEqual(decode('null'), []);
  assert.deepEqual(decode('"a string"'), []);
  assert.deepEqual(decode('{"m":"v.oai.hid"}'), [], 'no params');
  assert.deepEqual(decode('{"m":"v.oai.hid","p":{"act":1}}'), [], 'no key name');
  assert.deepEqual(decode('{"m":"unknown.method","p":{"k":"AG00","act":1}}'), []);
  // A radial needs two finite numbers; NaN would reach the sector arithmetic.
  assert.deepEqual(decode('{"m":"kb.radial","p":{"a":0.5}}'), [], 'no distance');
  assert.deepEqual(decode('{"m":"kb.radial","p":{"a":"0.5","d":1}}'), [], 'angle not a number');
  assert.deepEqual(decode('{"m":"kb.radial","p":{"a":null,"d":null}}'), []);

  // JSON has no NaN literal, so the finiteness guard looks unreachable behind
  // the typeof check above -- but JSON.parse overflows a large exponent to
  // Infinity, which is typeof 'number'. Unfiltered it reaches the sector
  // arithmetic as Math.round(Infinity * 4) % 4, i.e. NaN, which indexes the
  // direction table as undefined and drops the push with nothing logged.
  assert.deepEqual(decode('{"m":"kb.radial","p":{"a":1e999,"d":1}}'), [], 'angle overflows');
  assert.deepEqual(decode('{"m":"kb.radial","p":{"a":0.5,"d":-1e999}}'), [], 'distance overflows');
});

test('RpcReassembler ignores reports that are not its own channel', () => {
  const reassembler = new RpcReassembler();
  const line = Buffer.from('{"m":"v.oai.hid","p":{"k":"AG00","act":1}}\n');
  const framed = (id: number, channel: number) =>
    Buffer.concat([Buffer.from([id, channel, line.length]), line]);

  // The pad's keyboard and consumer reports arrive on the same handle, and
  // parseStandardInput has already decoded them.
  assert.deepEqual(reassembler.push(framed(1, 2)), [], 'wrong report id');
  assert.deepEqual(reassembler.push(framed(6, 1)), [], 'wrong channel');
  assert.deepEqual(reassembler.push(Buffer.from([6, 2])), [], 'too short to carry a length');

  // A length larger than the channel can carry at all.
  assert.deepEqual(reassembler.push(Buffer.concat([Buffer.from([6, 2, 200]), line])), []);

  // And a plausible length that simply overruns this report: 40 is a legal
  // payload size, but only one byte follows it. Trusting the declared length
  // here appends that stray byte to the buffer, so the corruption surfaces on
  // the NEXT line rather than as anything visible at the time.
  assert.deepEqual(reassembler.push(Buffer.from([6, 2, 40, 0x41])), []);

  // None of the above left anything behind that could corrupt the next line.
  assert.deepEqual(reassembler.push(framed(6, 2)), [{ kind: 'key', key: 'AG00', pressed: true }]);
});

test('reset drops a half-received line so a reconnect cannot splice one', () => {
  const reassembler = new RpcReassembler();
  const head = Buffer.from('{"m":"v.oai.hid","p":{"k":"AG0');
  reassembler.push(Buffer.concat([Buffer.from([6, 2, head.length]), head]));

  // The device is reopened mid-line: without the reset the stale prefix would
  // be glued to the next report and decode as neither key.
  reassembler.reset();

  const tail = Buffer.from('0","act":1}}\n');
  assert.deepEqual(reassembler.push(Buffer.concat([Buffer.from([6, 2, tail.length]), tail])), []);
});

test('standard reports expose key edges and dial actions', () => {
  const held = new Set<number>();
  assert.deepEqual(parseStandardInput(Buffer.from([1, 0, 0, 4, 0, 0, 0, 0, 0]), held), [
    { kind: 'key', key: 'AG00', pressed: true },
  ]);
  assert.deepEqual(parseStandardInput(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0]), held), [
    { kind: 'key', key: 'AG00', pressed: false },
  ]);
  assert.deepEqual(parseStandardInput(Buffer.from([2, 0xe9, 0]), held), [
    { kind: 'dial', action: 'clockwise' },
  ]);
  assert.deepEqual(parseStandardInput(Buffer.from([2, 0xcd, 0]), held), [
    { kind: 'dial', action: 'click' },
  ]);
});

test('standard key codes map onto the legend printed on the pad', () => {
  const press = (code: number) => parseStandardInput(Buffer.from([1, 0, 0, code]), new Set());
  const nameOf = (code: number) => {
    const [input] = press(code);
    return input?.kind === 'key' ? input.key : null;
  };

  // 0x04-0x09 are the six agent keys, 0x0a-0x10 the seven action keys; the
  // legend is what the config file's binding names refer to.
  assert.deepEqual([nameOf(0x04), nameOf(0x09)], ['AG00', 'AG05']);
  assert.deepEqual([nameOf(0x0a), nameOf(0x10)], ['ACT06', 'ACT12']);
  // Anything else is named rather than dropped, so an unmapped key is
  // identifiable from the logs instead of being silently invisible.
  assert.equal(nameOf(0x2c), 'HID_2C');
});

test('several keys held at once report one edge each', () => {
  const held = new Set<number>();

  assert.deepEqual(parseStandardInput(Buffer.from([1, 0, 0, 0x04, 0x05]), held), [
    { kind: 'key', key: 'AG00', pressed: true },
    { kind: 'key', key: 'AG01', pressed: true },
  ]);
  // One released, one still down: only the released key reports, and the held
  // one must not re-report as a fresh press.
  assert.deepEqual(parseStandardInput(Buffer.from([1, 0, 0, 0x05]), held), [
    { kind: 'key', key: 'AG00', pressed: false },
  ]);
  assert.deepEqual(parseStandardInput(Buffer.from([1, 0, 0, 0x05]), held), []);
});

test('reports the pad does not define decode to nothing', () => {
  const held = new Set<number>();
  assert.deepEqual(parseStandardInput(Buffer.alloc(0), held), [], 'empty report');
  assert.deepEqual(parseStandardInput(Buffer.from([3, 0x01, 0x02]), held), [], 'unknown report id');
  assert.deepEqual(parseStandardInput(Buffer.from([2, 0xff, 0xff]), held), [], 'unmapped usage');
  assert.deepEqual(parseStandardInput(Buffer.from([2, 0xe9]), held), [], 'truncated consumer');
});

test('lighting maps empty, blocked, and working slots', () => {
  assert.deepEqual(lightingForStatus(0, null, DEFAULT_CONFIG.colors), {
    id: 0,
    color: 0,
    brightness: 0,
    effect: 0,
    speed: 0,
  });
  assert.equal(lightingForStatus(1, 'blocked', DEFAULT_CONFIG.colors).color, 0xc87a0a);
  assert.deepEqual(lightingForStatus(2, 'working', DEFAULT_CONFIG.colors), {
    id: 2,
    color: 0x1e5aa8,
    brightness: 1,
    effect: 4,
    speed: 0.35,
  });
});

test('lighting dims idle and borrows the idle colour for unknown', () => {
  const idle = lightingForStatus(0, 'idle', DEFAULT_CONFIG.colors);
  assert.deepEqual(idle, { id: 0, color: 0x302820, brightness: 0.25, effect: 1, speed: 0 });
  // An agent whose status has not settled yet must look like an idle one
  // rather than announcing itself.
  assert.deepEqual(lightingForStatus(0, 'unknown', DEFAULT_CONFIG.colors), idle);
});

test('lighting shows a finished agent at full brightness without animating', () => {
  assert.deepEqual(lightingForStatus(3, 'done', DEFAULT_CONFIG.colors), {
    id: 3,
    color: 0x1e8a3c,
    brightness: 1,
    effect: 1,
    speed: 0,
  });
});

test('RpcReassembler drops an oversized line and resyncs at the next newline', () => {
  const overflows: number[] = [];
  const reassembler = new RpcReassembler((chars) => void overflows.push(chars));

  // A notification that never terminates: 61 bytes a report, past the 8KB cap.
  const filler = Buffer.alloc(64, 0);
  filler[0] = 6;
  filler[1] = 2;
  filler[2] = 61;
  filler.fill(0x78, 3); // 'x'
  for (let sent = 0; sent <= MAX_RPC_LINE_CHARS; sent += 61) {
    assert.deepEqual(reassembler.push(filler), [], 'nothing decodes mid-line');
  }
  assert.equal(overflows.length, 1, 'the drop is reported once, not per report');
  assert.ok(overflows[0]! > MAX_RPC_LINE_CHARS);

  // The tail of the discarded line must not decode as a notification of its own.
  assert.deepEqual(reassembler.push(reportFor('xxx"}}')), [], 'tail discarded');
  // ...and the pad is usable again immediately afterwards.
  assert.deepEqual(reassembler.push(reportFor('{"m":"v.oai.hid","p":{"k":"AG02","act":1}}')), [
    { kind: 'key', key: 'AG02', pressed: true },
  ]);
});
