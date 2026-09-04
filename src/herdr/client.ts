import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Coalescer, type Logger } from '../log.js';

import {
  type AgentInfo,
  type AgentStatus,
  type EventFrame,
  Evt,
  eventName,
  GLOBAL_SUBSCRIPTIONS,
  isAgentStatus,
  isErrorResponse,
  isEventFrame,
  MEMBERSHIP_EVENTS,
  type PaneInfo,
  PROTOCOL,
  paneStatusSubscription,
  type Request,
  reqAgentList,
  reqSnapshot,
  reqSubscribe,
  reqWorkspaceList,
  type SessionSnapshot,
  SUBSCRIPTION_STARTED,
  type SubscriptionSpec,
  type WorkspaceInfo,
} from './rpc.js';

const execFileAsync = promisify(execFile);

/** The most-repeated expression in the codebase, in one place. */
export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type ClientOptions = {
  socketPath?: string;
  ackTimeoutMs?: number;
  requestTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** A connection must survive this long before the backoff is considered recovered. */
  healthyAfterMs?: number;
  /** Cadence of the authoritative agent.list refresh that makes the daemon self-healing. */
  refreshIntervalMs?: number;
};

const DEFAULTS = {
  ackTimeoutMs: 2000,
  requestTimeoutMs: 5000,
  backoffMinMs: 250,
  backoffMaxMs: 8000,
  healthyAfterMs: 10_000,
  refreshIntervalMs: 2500,
};

// ---------------------------------------------------------------------------
// Socket resolution
// ---------------------------------------------------------------------------

/**
 * Resolving this wrong produces the worst failure mode there is: a daemon that
 * connects, seeds zero workspaces, and looks perfectly healthy while showing
 * nothing. Always log what was resolved and how many workspaces it seeded.
 *
 * The named-session layout is ~/.config/herdr/sessions/<name>/herdr.sock --
 * confirmed from herdr's own `server_not_running` error, which names that
 * exact path. The directory only exists once a named session has been created,
 * so its absence proves nothing. `herdr session list` is the fallback.
 */
export async function resolveSocketPath(log: Logger): Promise<string> {
  const fromEnv = process.env.HERDR_SOCKET_PATH;
  if (fromEnv) {
    log.info('socket resolved', { path: fromEnv, via: 'HERDR_SOCKET_PATH' });
    return fromEnv;
  }

  const session = process.env.HERDR_SESSION;
  if (session) {
    const direct = join(homedir(), '.config', 'herdr', 'sessions', session, 'herdr.sock');
    if (existsSync(direct)) {
      log.info('socket resolved', { path: direct, via: `HERDR_SESSION=${session}` });
      return direct;
    }
    const listed = await socketFromSessionList(session);
    if (listed) {
      log.info('socket resolved', { path: listed, via: `herdr session list (${session})` });
      return listed;
    }
    log.warn('named session has no socket yet', { session, tried: direct });
  }

  const fallback = join(homedir(), '.config', 'herdr', 'herdr.sock');
  log.info('socket resolved', { path: fallback, via: 'default path' });
  return fallback;
}

/** Extracted so it can be tested without stubbing child_process. */
export function parseSessionList(stdout: string, session: string): string | null {
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    const name = cols[0];
    const sock = cols[cols.length - 1];
    if (name === session && sock?.endsWith('.sock')) return sock;
  }
  return null;
}

async function socketFromSessionList(session: string): Promise<string | null> {
  const bin = process.env.HERDR_BIN_PATH ?? 'herdr';
  try {
    const { stdout } = await execFileAsync(bin, ['session', 'list'], { timeout: 5000 });
    return parseSessionList(stdout, session);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Newline-delimited JSON framing
// ---------------------------------------------------------------------------

/**
 * Only JSON.parse is guarded. Wrapping the onMessage call too would swallow
 * every downstream bug -- a throw in the store or renderer would be logged as
 * "unparseable frame from herdr" and the daemon would carry on with a stale
 * key and a log line pointing at the wrong subsystem.
 */
function readLines(socket: net.Socket, onMessage: (msg: unknown) => void, log: Logger): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        log.warn('unparseable frame from herdr', { line: line.slice(0, 200) });
        continue;
      }
      onMessage(parsed);
    }
  });
}

// ---------------------------------------------------------------------------
// One-shot request
// ---------------------------------------------------------------------------

/**
 * Opens a connection, sends exactly one request, resolves with the response,
 * closes. The single-request-per-connection constraint makes this the only
 * correct shape for a request: it cannot share the subscriber's socket.
 */
export function requestOnce(
  socketPath: string,
  req: Request,
  log: Logger,
  timeoutMs = DEFAULTS.requestTimeoutMs,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (err: Error | null, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value!);
    };

    timer = setTimeout(
      () => finish(new Error(`herdr request timed out: ${req.method}`)),
      timeoutMs,
    );

    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(new Error(`herdr closed before responding: ${req.method}`)));

    readLines(
      socket,
      (msg) => {
        if (isErrorResponse(msg)) {
          finish(new Error(`herdr error on ${req.method}: ${msg.error?.message ?? 'unknown'}`));
          return;
        }
        const result = (msg as { result?: Record<string, unknown> }).result;
        if (result) finish(null, result);
      },
      log,
    );
  });
}

// ---------------------------------------------------------------------------
// Subscriber: one subscription set == one connection
// ---------------------------------------------------------------------------

/**
 * A subscription is a connection. herdr accepts one request per socket, so
 * subscriptions cannot be added to a live stream -- a new set means a new
 * Subscriber.
 *
 * Two subtleties, both learned the hard way:
 *
 *  - The event handler is passed to start() rather than attached afterwards.
 *    resolve() runs inside the data callback, so the caller's `await` resumes
 *    on a microtask *after* readLines has finished draining the current chunk.
 *    Any frame herdr batched into the same TCP segment as the ack would be
 *    emitted to nobody and lost.
 *
 *  - Loss is latched. EventEmitter.emit with no listener is a silent no-op, so
 *    a drop occurring before the consumer attaches its handler would otherwise
 *    strand the reconnect loop forever.
 */
export class Subscriber extends EventEmitter {
  private socket: net.Socket | null = null;
  private closed = false;
  private acked = false;
  private lostError: Error | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly subscriptions: SubscriptionSpec[],
    private readonly log: Logger,
    private readonly label: string,
    private readonly ackTimeoutMs = DEFAULTS.ackTimeoutMs,
  ) {
    super();
  }

  /** Registers `cb` for loss, firing immediately if the stream is already gone. */
  onLost(cb: (err: Error) => void): void {
    if (this.lostError) {
      cb(this.lostError);
      return;
    }
    this.once('lost', cb);
  }

  private markLost(err: Error): void {
    if (this.lostError || this.closed) return;
    this.lostError = err;
    this.emit('lost', err);
  }

  start(onEvent?: (frame: EventFrame) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      this.socket = socket;
      this.acked = false;

      const fail = (err: Error) => {
        clearTimeout(ackTimer);
        socket.destroy(); // never leave a socket behind on a failed start
        reject(err);
      };

      const ackTimer = setTimeout(() => {
        if (this.acked) return;
        fail(new Error(`subscribe ack timeout after ${this.ackTimeoutMs}ms (${this.label})`));
      }, this.ackTimeoutMs);

      socket.on('connect', () => {
        socket.write(`${JSON.stringify(reqSubscribe(`sub:${this.label}`, this.subscriptions))}\n`);
      });

      socket.on('error', (err) => {
        if (!this.acked) fail(err);
        else this.markLost(err);
      });

      socket.on('close', () => {
        // A close BEFORE the ack must reject, or start() never settles: the
        // ack timer is gone and no other path resolves the promise. An awaited
        // watchPane would then hang forever, connectOnce would never return,
        // and the reconnect loop would never even attach its handler -- a
        // permanently parked daemon holding stale colours, with nothing logged.
        if (!this.acked) {
          fail(new Error(`herdr closed before subscribe ack (${this.label})`));
          return;
        }
        clearTimeout(ackTimer);
        this.markLost(new Error('stream closed'));
      });

      readLines(
        socket,
        (msg) => {
          if (isErrorResponse(msg)) {
            if (!this.acked) fail(new Error(msg.error?.message ?? 'subscribe rejected'));
            return;
          }
          const result = (msg as { result?: { type?: string } }).result;
          if (result?.type === SUBSCRIPTION_STARTED) {
            this.acked = true;
            clearTimeout(ackTimer);
            resolve();
            return;
          }
          if (isEventFrame(msg)) onEvent?.(msg);
        },
        this.log,
      );
    });
  }

  stop(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type PaneStatus = { paneId: string; workspaceId: string; status: AgentStatus };

export type HerdrClientEvents = {
  seed: (snapshot: SessionSnapshot) => void;
  event: (frame: EventFrame) => void;
  /** The authoritative status signal, one subscription per agent pane. */
  paneStatus: (s: PaneStatus) => void;
  /** The full authoritative agent list, from each agent.list refresh. */
  agents: (list: AgentInfo[]) => void;
  /** Authoritative workspace membership and order, from workspace.list. */
  workspaces: (list: WorkspaceInfo[]) => void;
  /** Fired on every gap. Consumers must repaint from the next seed, never carry colour across. */
  disconnected: (reason: string) => void;
};

export declare interface HerdrClient {
  on<K extends keyof HerdrClientEvents>(e: K, l: HerdrClientEvents[K]): this;
  emit<K extends keyof HerdrClientEvents>(e: K, ...a: Parameters<HerdrClientEvents[K]>): boolean;
}

/**
 * Owns one topology subscription plus one status subscription per agent pane.
 *
 * The fan-out is not an optimisation, it is the only design that works:
 * `pane.agent_status_changed` is the sole reliable status signal, it requires a
 * pane_id, and herdr accepts one request per connection -- so N agent panes
 * means N+1 sockets. Any socket dropping tears the whole set down and
 * reconnects, so colours are never carried across a gap.
 */
export class HerdrClient extends EventEmitter {
  private globalSub: Subscriber | null = null;
  private paneSubs = new Map<string, Subscriber | 'pending'>();
  private stopped = false;
  private loopRunning = false;
  private backoff: number;
  private socketPath = '';
  private generation = 0;
  private seeded = false;
  private readonly reconcileGate = new Coalescer();
  private readonly backfillGate = new Coalescer();
  /** Frames arriving between the subscribe ack and the seed, replayed after it. */
  private pending: EventFrame[] = [];
  /**
   * Loss is latched rather than emitted. A pane subscription can fail while
   * connectOnce is still running -- it opens them concurrently -- and an emit
   * with no listener attached yet is a silent no-op, leaving the client
   * connected with a pane that has no status source and nothing able to notice.
   * Same hazard as Subscriber.onLost, one level up.
   */
  private refreshTimer: NodeJS.Timeout | null = null;
  private lossLatch: Error | null = null;
  private wake: ((err: Error | null) => void) | null = null;
  private readonly opts: Required<Omit<ClientOptions, 'socketPath'>> & { socketPath?: string };

  constructor(
    private readonly log: Logger,
    opts: ClientOptions = {},
  ) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.backoff = this.opts.backoffMinMs;
  }

  async start(): Promise<void> {
    if (this.loopRunning) {
      this.log.warn('herdr client already started; ignoring duplicate start()');
      return;
    }
    this.loopRunning = true;
    this.socketPath = this.opts.socketPath ?? (await resolveSocketPath(this.log));
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.(null);
    this.teardown();
  }

  /** Record a stream loss, waking the reconnect loop if it is already waiting. */
  private signalLoss(err: Error): void {
    if (this.lossLatch) return;
    this.lossLatch = err;
    this.wake?.(err);
  }

  get path(): string {
    return this.socketPath;
  }

  private teardown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.globalSub?.stop();
    this.globalSub = null;
    for (const sub of this.paneSubs.values()) if (sub !== 'pending') sub.stop();
    this.paneSubs.clear();
    this.seeded = false;
    this.pending = [];
    this.lossLatch = null;
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      const gen = ++this.generation;
      let connectedAt = 0;
      try {
        await this.connectOnce(gen);
        connectedAt = Date.now();
        await new Promise<void>((resolve) => {
          const finish = (err: Error | null) => {
            if (err && gen === this.generation) {
              this.log.warn('herdr stream lost', { reason: err.message });
              this.emit('disconnected', err.message);
            }
            resolve();
          };
          this.wake = finish;
          // Both loss paths are latched, so a drop during connectOnce -- the
          // global socket, or any of the concurrently-opened pane
          // subscriptions -- is picked up here instead of parking the loop on
          // an already-dead connection.
          this.globalSub?.onLost(finish);
          if (this.lossLatch) finish(this.lossLatch);
          else if (this.stopped) finish(null);
        });
        this.wake = null;
      } catch (err) {
        const why = reason(err);
        this.log.warn('herdr connect failed', { reason: why, retryInMs: this.backoff });
        this.emit('disconnected', why);
      }

      this.teardown();
      if (this.stopped) break;

      // Reset the backoff only if the connection actually held. Resetting on a
      // successful subscribe alone lets a daemon that accepts subscriptions and
      // then drops them immediately drive a permanent reconnect storm.
      if (connectedAt && Date.now() - connectedAt >= this.opts.healthyAfterMs) {
        this.backoff = this.opts.backoffMinMs;
      }

      await sleep(this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.opts.backoffMaxMs);
    }
    this.loopRunning = false;
  }

  /**
   * Subscribe FIRST, then seed, buffering anything that arrives in between.
   *
   * Ordering alone is not enough: frames delivered while the snapshot request
   * is in flight describe state newer than the snapshot, and applySeed rebuilds
   * from scratch -- so replaying them afterwards is what actually closes the
   * window.
   */
  private async connectOnce(gen: number): Promise<void> {
    this.seeded = false;
    this.pending = [];

    const sub = new Subscriber(
      this.socketPath,
      GLOBAL_SUBSCRIPTIONS,
      this.log,
      'global',
      this.opts.ackTimeoutMs,
    );
    await sub.start((frame) => this.onGlobalFrame(frame, gen));
    if (this.stale(gen)) {
      sub.stop();
      throw new Error('client stopped during connect');
    }
    this.globalSub = sub;

    const result = await this.request(reqSnapshot('seed'));
    if (this.stale(gen)) throw new Error('client stopped during connect');

    const snapshot = result.snapshot as SessionSnapshot | undefined;
    if (!snapshot) throw new Error('snapshot response had no snapshot payload');

    // rpc.ts was verified against one protocol version. A bump does not
    // necessarily break anything, but it should never be discovered by
    // debugging a wrong colour weeks later.
    if (snapshot.protocol !== PROTOCOL) {
      this.log.warn('herdr protocol differs from the one rpc.ts was verified against', {
        herdr: snapshot.protocol,
        expected: PROTOCOL,
      });
    }

    const agentPanes = (snapshot.panes ?? []).filter((p) => p.agent).map((p) => p.pane_id);

    this.log.info('herdr connected', {
      path: this.socketPath,
      version: snapshot.version,
      protocol: snapshot.protocol,
      workspaces: snapshot.workspaces?.length ?? 0,
      panes: snapshot.panes?.length ?? 0,
      agentPanes: agentPanes.length,
    });

    this.emit('seed', snapshot);
    this.seeded = true;
    const replay = this.pending;
    this.pending = [];
    for (const frame of replay) this.emit('event', frame);

    // Concurrently: each subscribe is a round trip, and on a sick daemon each
    // costs the full ack timeout. Sequentially that is N x ackTimeoutMs of dead
    // air before the pad shows anything. watchPane handles its own failures.
    await Promise.all(agentPanes.map((paneId) => this.watchPane(paneId, gen)));
    if (this.stale(gen)) throw new Error('client stopped during connect');

    // The snapshot's statuses were read before these subscriptions existed, and
    // pane.agent_status_changed only reports future changes -- so anything that
    // moved in between would be invisible until the next real transition. One
    // agent.list covers every pane.
    await this.refreshAgents(gen);

    this.refreshTimer = setInterval(() => {
      if (this.stale(gen)) return;
      void this.refreshAgents(gen);
    }, this.opts.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  private request(req: Request): Promise<Record<string, unknown>> {
    return requestOnce(this.socketPath, req, this.log, this.opts.requestTimeoutMs);
  }

  private stale(gen: number): boolean {
    return this.stopped || gen !== this.generation;
  }

  private onGlobalFrame(frame: EventFrame, gen: number): void {
    if (gen !== this.generation) return;
    if (!this.seeded) this.pending.push(frame);
    else this.emit('event', frame);
    void this.trackPaneLifecycle(frame, gen);
  }

  /** Open a status subscription for one agent pane. Idempotent under concurrency. */
  private async watchPane(paneId: string, gen: number): Promise<void> {
    if (gen !== this.generation || this.paneSubs.has(paneId)) return;
    // Reserve the slot before awaiting: two lifecycle events for the same pane
    // (pane_created then pane_agent_detected) otherwise both pass the guard and
    // open a second, permanently orphaned socket that double-emits status.
    this.paneSubs.set(paneId, 'pending');

    const sub = new Subscriber(
      this.socketPath,
      paneStatusSubscription(paneId),
      this.log,
      paneId,
      this.opts.ackTimeoutMs,
    );

    try {
      await sub.start((frame) => {
        if (gen !== this.generation) return;
        const d = frame.data ?? {};
        // Validate rather than cast: an unrecognised status would otherwise
        // reach the glyph and colour tables, which are keyed on the five known
        // values.
        const status = d.agent_status;
        if (!isAgentStatus(status)) return;
        this.emit('paneStatus', {
          paneId: (d.pane_id as string) ?? paneId,
          workspaceId: (d.workspace_id as string) ?? '',
          status,
        });
      });
    } catch (err) {
      this.paneSubs.delete(paneId);
      sub.stop();
      // A pane with no status source shows its seed colour forever while every
      // other key keeps updating -- a stale colour that looks healthy. Treat it
      // as a connection failure so the whole set is rebuilt.
      this.log.warn('pane status subscription failed; reconnecting', {
        paneId,
        reason: reason(err),
      });
      if (gen === this.generation) {
        this.signalLoss(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    // The pane may have closed while the ack was in flight, in which case
    // unwatchPane already ran and found only the marker.
    if (this.stale(gen) || this.paneSubs.get(paneId) !== 'pending') {
      this.paneSubs.delete(paneId);
      sub.stop();
      return;
    }
    this.paneSubs.set(paneId, sub);
    sub.onLost((err) => {
      if (gen !== this.generation) return;
      this.signalLoss(err);
    });
  }

  private unwatchPane(paneId: string): void {
    const sub = this.paneSubs.get(paneId);
    if (!sub) return;
    this.paneSubs.delete(paneId);
    if (sub === 'pending') return; // watchPane sees the missing marker and cleans up
    sub.removeAllListeners('lost'); // an intentional close must not trigger reconnect
    sub.stop();
  }

  /**
   * Keeps the per-pane subscription set in step with reality. Only panes that
   * actually hold an agent are watched -- pane.created also fires for plain
   * shell panes, and subscribing to those would grow one socket per pane the
   * user ever opens.
   */
  private async trackPaneLifecycle(frame: EventFrame, gen: number): Promise<void> {
    const d = frame.data ?? {};
    const type = eventName(frame);

    if (type === Evt.paneAgentDetected || type === Evt.paneCreated) {
      const pane = d.pane as PaneInfo | undefined;
      const paneId = (d.pane_id as string) ?? pane?.pane_id;
      if (!paneId) return;
      // pane_created carries the record, so a shell pane can be filtered out.
      // pane_agent_detected carries only ids and always implies an agent.
      if (type === Evt.paneCreated && pane && !pane.agent) return;
      await this.watchPane(paneId, gen);
      await this.refreshAgents(gen);
      return;
    }

    if (type === Evt.paneClosed || type === Evt.paneExited) {
      const paneId = d.pane_id as string | undefined;
      if (paneId) this.unwatchPane(paneId);
      return;
    }

    if (MEMBERSHIP_EVENTS.has(type)) await this.reconcileWorkspaces(gen);
  }

  /**
   * Membership and order come from workspace.list, never from the events
   * themselves.
   *
   * On subscribe herdr replays a backlog of historical workspace events, and
   * replays them OUT OF ORDER -- a workspace_closed can arrive before the
   * matching workspace_created. Applying those directly resurrects a workspace
   * that was deleted long ago, and it then holds a key forever. Verified
   * against herdr 0.8.2: a workspace closed an hour earlier reappeared because
   * its create was replayed after its close.
   *
   * Treating the events purely as triggers and re-reading the real list costs
   * one round trip per membership change, which is rare.
   */
  private reconcileWorkspaces(gen: number): Promise<void> {
    return this.reconcileGate.run(async () => {
      try {
        const result = await this.request(reqWorkspaceList('workspaces'));
        if (this.stale(gen)) return;
        const list = result.workspaces as WorkspaceInfo[] | undefined;
        if (list) this.emit('workspaces', list);
      } catch (err) {
        this.log.warn('could not reconcile workspaces', { reason: reason(err) });
      }
    });
  }

  /**
   * The authoritative agent refresh: one `agent.list` covering every agent
   * pane.
   *
   * Runs at connect, on lifecycle events, and on a timer. The timer is what
   * makes the daemon self-healing -- a missed event, a status subscription that
   * went quiet, or an agent that disappeared without the lifecycle event we
   * expected all resolve on the next pass instead of persisting until a
   * reconnect. Coalesced, so a burst of triggers costs one extra listing rather
   * than one per trigger.
   */
  private refreshAgents(gen: number): Promise<void> {
    return this.backfillGate.run(async () => {
      try {
        const result = await this.request(reqAgentList('agents'));
        if (this.stale(gen)) return;
        const agents = ((result.agents as AgentInfo[] | undefined) ?? []).filter(
          (a) => a?.pane_id && isAgentStatus(a.agent_status),
        );
        this.emit('agents', agents);
        await this.reconcileSubscriptions(agents, gen);
      } catch (err) {
        this.log.warn('could not refresh agents', { reason: reason(err) });
      }
    });
  }

  /**
   * Bring the per-pane subscription set in line with the authoritative list.
   *
   * Lifecycle events alone are not enough: an agent can stop being an agent
   * without the pane closing, and a pane_agent_detected can be missed. Deriving
   * the desired set from agent.list closes both, rather than trusting that
   * every departure announces itself.
   */
  private async reconcileSubscriptions(agents: AgentInfo[], gen: number): Promise<void> {
    const desired = new Set(agents.map((a) => a.pane_id));

    for (const [paneId, sub] of this.paneSubs) {
      // Leave in-flight opens alone; they settle themselves.
      if (sub !== 'pending' && !desired.has(paneId)) this.unwatchPane(paneId);
    }

    const missing = [...desired].filter((id) => !this.paneSubs.has(id));
    if (missing.length === 0) return;
    await Promise.all(missing.map((id) => this.watchPane(id, gen)));
  }
}
