#!/usr/bin/env node
/**
 * Read-only diagnostic for the Work Louder Creator Micro 2.
 *
 * Enumerates the pad's HID collections, attempts to open the vendor-defined
 * one, and — if that succeeds — listens for input reports. It never writes to
 * the device, so it cannot disturb firmware state or the current keymap.
 *
 * Why this exists: the pad puts all five HID collections on a single USB
 * interface, so the vendor channel shares one IOHIDDevice path with the
 * keyboard. macOS requires that shared device to be opened non-exclusively.
 * This tool tells us which barrier we are actually hitting.
 *
 *   node tools/hid-probe.mjs           # as your user
 *   sudo node tools/hid-probe.mjs      # to test whether root lifts it
 */
import HID from 'node-hid';

const VENDOR_ID = 0x303a;
const PRODUCT_ID = 0x8298;
const RAW_USAGE_PAGE = 0xff00;
const LISTEN_MS = Number(process.env.LISTEN_MS ?? 8000);

const hex = (n, w = 2) => `0x${(n ?? 0).toString(16).toUpperCase().padStart(w, '0')}`;

function describeError(err) {
  const msg = String(err?.message ?? err);
  if (msg.includes('0xE00002E2')) {
    return 'TCC denied — grant Input Monitoring to the calling app';
  }
  if (msg.includes('0xE00002C1')) {
    return 'privileged — macOS refuses this device to an unprivileged process';
  }
  if (msg.includes('0xE00002C5')) return 'exclusive access — another process holds the device';
  return msg;
}

const devices = HID.devices().filter((d) => d.vendorId === VENDOR_ID);
if (devices.length === 0) {
  console.log('pad not found (VID 0x303A). Is it plugged in?');
  process.exit(1);
}

console.log(`running as uid=${process.getuid()}\n`);
console.log(`${devices.length} HID collections on ${devices[0].product}:`);
for (const d of devices) {
  const tag = d.usagePage === RAW_USAGE_PAGE ? '  <-- vendor raw channel' : '';
  console.log(
    `  usagePage=${hex(d.usagePage, 4)} usage=${hex(d.usage)} interface=${d.interface}${tag}`,
  );
}
const paths = new Set(devices.map((d) => d.path));
console.log(`\ndistinct IOHIDDevice paths: ${paths.size}`);
if (paths.size === 1) {
  console.log('  all collections share one path; opening non-exclusively');
}

const raw = devices.find((d) => d.usagePage === RAW_USAGE_PAGE);
if (!raw) {
  console.log('\nno vendor collection present');
  process.exit(2);
}

console.log(`\nopening ${raw.path} ...`);
let device;
try {
  device = new HID.HID(raw.path, { nonExclusive: true });
} catch (err) {
  console.log(`FAILED: ${describeError(err)}`);
  console.log(`  raw: ${err.message}`);
  process.exit(3);
}

console.log('OPEN OK\n');
console.log(`listening ${LISTEN_MS}ms — press keys / turn the dial on the pad`);
console.log('(report ID 6 carries the 63-byte vendor input report)\n');

let count = 0;
let rpcText = '';
device.on('data', (buf) => {
  count += 1;
  const bytes = buf.toString('hex').match(/.{1,2}/g) ?? [];
  const head = bytes.slice(0, 16).join(' ');
  const tail = bytes.length > 16 ? ` … (+${bytes.length - 16} more)` : '';
  console.log(`  IN  len=${String(buf.length).padStart(3)}  ${head}${tail}`);

  if (buf[0] !== 0x06 || buf[1] !== 0x02) return;
  const payloadLength = buf[2] ?? 0;
  if (payloadLength > buf.length - 3) return;
  rpcText += buf.subarray(3, 3 + payloadLength).toString('utf8');
  let newline;
  while ((newline = rpcText.indexOf('\n')) >= 0) {
    const message = rpcText.slice(0, newline).replace(/\r$/, '');
    rpcText = rpcText.slice(newline + 1);
    console.log(`  RPC ${message}`);
  }
});
device.on('error', (err) => console.log(`  ERROR: ${describeError(err)}`));

setTimeout(() => {
  console.log(`\n${count} input report(s) received`);
  if (count === 0) {
    console.log('none — the firmware likely only emits on this channel in response');
    console.log('to a host request, so the protocol needs discovering another way.');
  }
  try {
    device.close();
  } catch {}
  process.exit(0);
}, LISTEN_MS);
