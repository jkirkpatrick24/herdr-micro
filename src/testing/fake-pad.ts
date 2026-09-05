import { EventEmitter } from 'node:events';

import type { HidBackend, HidDeviceInfo, HidHandle } from '../hardware/device.js';
import { PRODUCT_ID, USAGE_PAGE, VENDOR_ID } from '../hardware/protocol.js';

/**
 * A stand-in for the Creator Micro's HID handle.
 *
 * Everything CreatorMicro does around node-hid -- enumerating, retrying,
 * queueing writes, routing reports -- is ordinary logic, and none of it should
 * need the pad plugged in to reach. What this fake deliberately keeps faithful
 * is that `write` is synchronous and can throw, and that `data`/`error` arrive
 * as events on the handle.
 */
export type FakePad = HidHandle & {
  /** Every report handed to write(), in order. */
  writes: number[][];
  /** Deliver an input report, as the real handle's 'data' event would. */
  emitData(report: Buffer): void;
  /** Deliver a HID error, as a pad unplugged mid-session does. */
  emitError(error: Error): void;
  readonly closed: boolean;
  readonly listenerCount: number;
  /** Make the next close() throw, as a handle already gone at OS level does. */
  failClose(error: Error | null): void;
  /** Make every write() throw. Pass null to stop failing. */
  failWrite(error: Error | null): void;
};

export function fakePad(): FakePad {
  // A real emitter rather than two hand-held slots: `on` is overloaded, so
  // splitting the listener back out by event name meant asserting which of the
  // two it was. The emitter takes them both without anyone having to claim it.
  const bus = new EventEmitter();
  let closed = false;
  let closeError: Error | null = null;
  let writeError: Error | null = null;
  const writes: number[][] = [];

  return {
    writes,
    on(event: 'data' | 'error', listener: ((report: Buffer) => void) | ((error: Error) => void)) {
      bus.on(event, listener);
      return this;
    },
    removeAllListeners() {
      bus.removeAllListeners();
      return this;
    },
    close() {
      closed = true;
      if (closeError) throw closeError;
    },
    write(values: number[]) {
      if (writeError) throw writeError;
      writes.push(values);
      return values.length;
    },
    emitData(report) {
      bus.emit('data', report);
    },
    emitError(error) {
      bus.emit('error', error);
    },
    get closed() {
      return closed;
    },
    get listenerCount() {
      return bus.listenerCount('data') + bus.listenerCount('error');
    },
    failClose(error) {
      closeError = error;
    },
    failWrite(error) {
      writeError = error;
    },
  };
}

/** The enumeration entry the daemon is looking for. */
export function padDeviceInfo(path = '/dev/hidraw0'): HidDeviceInfo {
  return { vendorId: VENDOR_ID, productId: PRODUCT_ID, usagePage: USAGE_PAGE, path };
}

/**
 * A backend whose enumeration result is swappable, so "the pad is unplugged,
 * then plugged in" is expressible without touching a real bus.
 */
export function fakeHid(initial: HidDeviceInfo[] = [padDeviceInfo()]) {
  let listing = initial;
  let pad = fakePad();
  let opens = 0;
  let openError: Error | null = null;

  const backend: HidBackend = {
    list: () => listing,
    open(path: string) {
      opens++;
      if (openError) throw openError;
      pad = fakePad();
      openPaths.push(path);
      return pad;
    },
  };
  const openPaths: string[] = [];

  return {
    backend,
    openPaths,
    get opens() {
      return opens;
    },
    /** The handle handed out by the most recent open(). */
    get pad() {
      return pad;
    },
    setListing(next: HidDeviceInfo[]) {
      listing = next;
    },
    failOpen(error: Error | null) {
      openError = error;
    },
  };
}
