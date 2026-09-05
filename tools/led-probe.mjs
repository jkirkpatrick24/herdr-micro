#!/usr/bin/env node
/**
 * LED protocol probe for the Work Louder Creator Micro 2.
 *
 * Work Louder's own bug tracker records that the ChatGPT/Codex integration
 * calls `v.oai.rgbcfg` successfully on this hardware over the vendor HID
 * channel, and that a sibling method `v.oai.thstatus` returns JSON-RPC error
 * 404 "Method not found". This probe uses the confirmed report-ID-6 RPC
 * framing and tests those two lighting calls after a read-only status call.
 *
 * It sends a visible blue ambient test and a red Agent-Key-0 test. These
 * changes are temporary firmware state; the normal layer configuration can
 * be restored through Work Louder Input.
 *
 * MUST be run from a plain Ghostty tab (not inside herdr), because TCC
 * attribution follows the process ancestry and herdr's server is a detached
 * daemon that predates the Input Monitoring grant.
 *
 *   node tools/led-probe.mjs
 */
import HID from 'node-hid';

const VENDOR_ID = 0x303a;
const RAW_USAGE_PAGE = 0xff00;
const REPORT_ID = 6;
const REPORT_BYTES = 63;
const REPLY_WAIT_MS = 600;

const devices = HID.devices().filter(
  (d) => d.vendorId === VENDOR_ID && d.usagePage === RAW_USAGE_PAGE,
);
if (devices.length === 0) {
  console.log('vendor interface not found — is the pad plugged in?');
  process.exit(1);
}

let device;
try {
  device = new HID.HID(devices[0].path, { nonExclusive: true });
} catch (err) {
  console.log(`could not open: ${err.message}`);
  console.log('\nIf this says "privilege violation", the calling app still lacks');
  console.log('Input Monitoring. Run this from a plain Ghostty tab, not inside herdr:');
  console.log('  herdr\'s server is a detached daemon and may predate the grant.');
  process.exit(2);
}

console.log(`opened ${devices[0].path}\n`);

const received = [];
device.on('data', (buf) => received.push(buf));
device.on('error', (err) => console.log(`  stream error: ${err.message}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Report ID 6 + RPC channel 2 + payload length; each chunk is 64 bytes. */
function frameRpc(payload) {
  const reports = [];
  for (let offset = 0; offset < payload.length; offset += REPORT_BYTES - 2) {
    const chunk = payload.subarray(offset, offset + REPORT_BYTES - 2);
    const out = Buffer.alloc(REPORT_BYTES + 1, 0);
    out[0] = REPORT_ID;
    out[1] = 0x02;
    out[2] = chunk.length;
    chunk.copy(out, 3);
    reports.push(out);
  }
  return reports;
}

const framings = [['RPC channel + length', frameRpc]];

/**
 * `device.status` is read-only. The lighting calls below are the two methods
 * used by the Codex integration and are intentionally tested on real hardware.
 */
const calls = [
  { jsonrpc: '2.0', id: 1, method: 'device.status' },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'v.oai.rgbcfg',
    params: {
      ambient: { e: 1, b: 1, s: 0, m: 0, c: 0x0000ff },
      keys: { e: 0, b: 0, s: 0, m: 0, c: 0 },
    },
  },
  {
    jsonrpc: '2.0',
    id: 3,
    method: 'v.oai.thstatus',
    params: [{ id: 0, c: 0xff0000, b: 1, e: 1, s: 0 }],
  },
];

const show = (buf) => {
  const hex = (buf.toString('hex').match(/.{1,2}/g) ?? []).slice(0, 24).join(' ');
  const text = buf.toString('utf8').replace(/[^\x20-\x7e]/g, '.');
  return `      hex : ${hex}\n      text: ${text.slice(0, 70)}`;
};

for (const [label, frame] of framings) {
  console.log(`--- framing: ${label} ---`);
  for (const call of calls) {
    received.length = 0;
    const payload = Buffer.from(`${JSON.stringify(call)}\n`, 'utf8');
    try {
      for (const report of frame(payload)) device.write([...report]);
    } catch (err) {
      console.log(`  ${call.method}: write failed — ${err.message}`);
      continue;
    }
    await wait(REPLY_WAIT_MS);
    if (received.length === 0) {
      console.log(`  ${call.method}: no reply`);
    } else {
      console.log(`  ${call.method}: ${received.length} report(s)`);
      for (const buf of received.slice(0, 3)) console.log(show(buf));
    }
  }
  console.log();
}

console.log('done — any readable JSON above identifies the framing.');
try {
  device.close();
} catch {}
process.exit(0);
