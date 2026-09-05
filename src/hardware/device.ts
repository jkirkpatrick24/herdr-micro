import { EventEmitter } from 'node:events';
import { devices, HID } from 'node-hid';

import { type Logger, reason } from '../log.js';
import {
  type AmbientLighting,
  encodeRpc,
  type PadInput,
  PadMethod,
  PRODUCT_ID,
  parseStandardInput,
  RpcReassembler,
  type ThreadLighting,
  USAGE_PAGE,
  VENDOR_ID,
} from './protocol.js';

/**
 * The slice of node-hid this class actually uses.
 *
 * Named as an interface so tests can supply a fake pad: everything below --
 * enumeration, the retry loop, the write queue, report routing -- is ordinary
 * logic that has nothing to do with USB, and reaching it should not require the
 * hardware to be plugged in.
 */
export type HidDeviceInfo = {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  path?: string | undefined;
};

export type HidHandle = {
  on(event: 'data', listener: (report: Buffer) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeAllListeners(): unknown;
  close(): void;
  write(values: number[]): unknown;
};

export type HidBackend = {
  list(): HidDeviceInfo[];
  open(path: string): HidHandle;
};

const nodeHid: HidBackend = {
  list: () => devices(),
  // nonExclusive so the pad keeps working as a keyboard while the daemon holds it.
  open: (path) => new HID(path, { nonExclusive: true }),
};

type DeviceHandle = HidHandle;

const RETRY_MS = 3000;

export type CreatorMicroOptions = {
  hid?: HidBackend;
  /** How long to wait before re-enumerating after a miss or a drop. */
  retryMs?: number;
};

export interface CreatorMicroEvents {
  connected: () => void;
  disconnected: (reason: string) => void;
  input: (input: PadInput) => void;
}

export declare interface CreatorMicro {
  on<K extends keyof CreatorMicroEvents>(event: K, listener: CreatorMicroEvents[K]): this;
  emit<K extends keyof CreatorMicroEvents>(
    event: K,
    ...args: Parameters<CreatorMicroEvents[K]>
  ): boolean;
}

/** Owns the Creator Micro 2 HID handle and its report-ID-6 RPC channel. */
export class CreatorMicro extends EventEmitter {
  private device: DeviceHandle | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private nextId = 1;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly heldKeys = new Set<number>();
  /**
   * Assigned in the constructor, not initialised inline: it closes over `log`,
   * which is a parameter property and so is not set until the constructor body.
   */
  private readonly rpc: RpcReassembler;

  private readonly hid: HidBackend;
  private readonly retryMs: number;

  constructor(
    private readonly log: Logger,
    opts: CreatorMicroOptions = {},
  ) {
    super();
    this.hid = opts.hid ?? nodeHid;
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.rpc = new RpcReassembler((chars) =>
      log.warn('oversized pad notification; resyncing at the next newline', { chars }),
    );
  }

  get connected(): boolean {
    return this.device !== null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.closeDevice('stopped');
  }

  setThreadLighting(slots: ThreadLighting[]): Promise<void> {
    return this.sendRpc(
      PadMethod.threadStatus,
      slots.map(({ id, color, brightness, effect, speed }) => ({
        id,
        c: color,
        b: brightness,
        e: effect,
        s: speed,
      })),
    );
  }

  setAmbientLighting(ambient: AmbientLighting): Promise<void> {
    return this.sendRpc(PadMethod.rgbConfig, {
      ambient: {
        e: ambient.effect,
        b: ambient.brightness,
        s: ambient.speed,
        m: ambient.magic,
        c: ambient.color,
      },
      keys: { e: 0, b: 0, s: 0, m: 0, c: 0 },
    });
  }

  /** Find the pad and open it. A miss is normal: it may just be unplugged. */
  private connect(): void {
    if (this.stopped || this.device) return;

    try {
      // The pad exposes several HID interfaces; the usage page picks the
      // vendor one, which is the only one carrying the RPC channel.
      const info = this.hid
        .list()
        .find(
          (entry) =>
            entry.vendorId === VENDOR_ID &&
            entry.productId === PRODUCT_ID &&
            entry.usagePage === USAGE_PAGE &&
            entry.path,
        );

      if (!info?.path) {
        this.scheduleRetry();
        return;
      }

      const device = this.hid.open(info.path);
      this.device = device;

      // A previous session's half-line and held keys mean nothing now.
      this.rpc.reset();
      this.heldKeys.clear();

      device.on('data', (report: Buffer) => this.handleReport(report));
      device.on('error', (error: Error) => {
        this.log.warn('Creator Micro HID error', { reason: error.message });
        this.closeDevice(error.message);
        this.scheduleRetry();
      });

      this.emit('connected');
      this.log.info('Creator Micro connected', { path: info.path });
    } catch (error) {
      this.log.warn('Creator Micro unavailable', { reason: reason(error) });
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  /** Idempotent: safe to call for a device that has already gone. */
  private closeDevice(why: string): void {
    const device = this.device;
    this.device = null;

    this.rpc.reset();
    this.heldKeys.clear();

    if (!device) return;

    device.removeAllListeners();
    try {
      device.close();
    } catch (error) {
      // A pad yanked from the port is already gone at OS level; closing it
      // throws and there is nothing to do about that but note it.
      this.log.warn('Creator Micro close failed', {
        reason: reason(error),
      });
    }

    this.emit('disconnected', why);
  }

  /** Reports arrive on one stream; only one of these two decodes any given one. */
  private handleReport(report: Buffer): void {
    for (const input of parseStandardInput(report, this.heldKeys)) this.emit('input', input);
    for (const input of this.rpc.push(report)) this.emit('input', input);
  }

  /**
   * Writes are serialised through a promise chain, because a multi-report
   * message must not interleave with another one on the wire. `target` is
   * captured now so a write queued before a disconnect fails instead of
   * landing on a replacement handle.
   */
  private sendRpc(method: string, params: unknown): Promise<void> {
    const target = this.device;
    const id = this.nextId++;

    const write = this.writeQueue.then(() => {
      if (!target || this.device !== target) throw new Error('Creator Micro is not connected');
      for (const report of encodeRpc(method, params, id)) target.write([...report]);
    });

    // The queue swallows failures so one bad write cannot poison the chain;
    // the caller still sees them through the returned promise.
    this.writeQueue = write.catch(() => {});

    return write;
  }
}
