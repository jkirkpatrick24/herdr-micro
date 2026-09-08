import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { asArray, isArray, isRecord } from '../json.js';
import { Coalescer, type Logger, reason } from '../log.js';

import {
  type AgentInfo,
  type AgentStatus,
  type EventFrame,
  Evt,
  eventName,
  GLOBAL_SUBSCRIPTIONS,
  isAgentInfo,
  isAgentStatus,
  isErrorResponse,
  isEventFrame,
  isResultResponse,
  isTabInfo,
  isWorkspaceInfo,
  MEMBERSHIP_EVENTS,
  PROTOCOL,
  paneStatusSubscription,
  parseSnapshot,
  type Request,
  ResultKey,
  reqAgentFocus,
  reqAgentList,
  reqNotificationShow,
  reqPaneCurrent,
  reqPaneFocusDirection,
  reqPaneSendKeys,
  reqPaneSendText,
  reqPluginPaneOpen,
  reqPopupClose,
  reqSnapshot,
  reqSubscribe,
  reqTabFocus,
  reqTabList,
  reqWorkspaceFocus,
  reqWorkspaceList,
  type SessionSnapshot,
  SUBSCRIPTION_STARTED,
  type SubscriptionSpec,
  type TabInfo,
  type WorkspaceInfo,
} from './rpc.js';

const execFileAsync = promisify(execFile);

/** Set equality against a pre-sorted, de-duplicated list. */
function sameSet(sorted: string[], current: ReadonlySet<string>): boolean {
  return sorted.length === current.size && sorted.every((id) => current.has(id));
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
 * Finds herdr's socket: explicit env var, then the named session, then the
 * default path.
 *
 * Resolving this wrong gives the worst failure mode there is -- a daemon that
 * connects, seeds nothing, and looks perfectly healthy. Hence a log line on
 * every branch saying what was chosen and why.
 */
export async function resolveSocketPath(log: Logger): Promise<string> {
  const fromEnv = process.env.HERDR_SOCKET_PATH;
  if (fromEnv) {
    log.info('socket resolved', { path: fromEnv, via: 'HERDR_SOCKET_PATH' });
    return fromEnv;
  }

  const session = process.env.HERDR_SESSION;

  if (session) {
    // Layout confirmed from herdr's own `server_not_running` error, which
    // names this path. It exists only once a named session has been created,
    // so its absence proves nothing -- fall through to asking herdr.
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
 * Cap on a single unterminated frame. A session snapshot is the largest thing
 * herdr sends and runs to tens of KB, so this is far above any legitimate line
 * while still bounding what a peer that never sends a newline can cost us.
 */
const MAX_LINE_CHARS = 1_000_000;

/**
 * Only JSON.parse is guarded. Wrapping the onMessage call too would swallow
 * every downstream bug -- a throw in the store or renderer would be logged as
 * "unparseable frame from herdr" and the daemon would carry on with a stale
 * key and a log line pointing at the wrong subsystem.
 */
function readLines(socket: net.Socket, onMessage: (msg: unknown) => void, log: Logger): void {
  let buf = '';
  // Set while the tail of an oversized line is still arriving, so it is
  // discarded rather than parsed as though it were a frame of its own.
  let resyncing = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (resyncing) {
        resyncing = false;
        continue;
      }
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
    // Dropping the buffer bounds the memory; resyncing at the next newline is
    // what keeps the stream usable afterwards, rather than parsing the tail of
    // the discarded frame and logging a second, misleading parse failure.
    if (buf.length > MAX_LINE_CHARS) {
      log.warn('oversized frame from herdr; resyncing at the next newline', {
        chars: buf.length,
      });
      buf = '';
      resyncing = true;
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

    // Every outcome funnels through here, so the socket and timer are cleaned
    // up once no matter which of them fires first. Split in two rather than
    // taking an `(err, value?)` pair: that shape cannot express "exactly one of
    // these is present", so the success path needed a non-null assertion to
    // stand in for an invariant only the callers were keeping.
    const done = (): boolean => {
      if (settled) return false;
      settled = true;

      clearTimeout(timer);
      socket.destroy();
      return true;
    };

    const fail = (err: Error) => {
      if (done()) reject(err);
    };

    const succeed = (value: Record<string, unknown>) => {
      if (done()) resolve(value);
    };

    timer = setTimeout(() => fail(new Error(`herdr request timed out: ${req.method}`)), timeoutMs);

    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on('error', (err) => fail(err));
    socket.on('close', () => fail(new Error(`herdr closed before responding: ${req.method}`)));

    readLines(
      socket,
      (msg) => {
        if (isErrorResponse(msg)) {
          fail(new Error(`herdr error on ${req.method}: ${msg.error?.message ?? 'unknown'}`));
          return;
        }

        if (isResultResponse(msg)) succeed(msg.result);
      },
      log,
    );
  });
}

// ---------------------------------------------------------------------------
// Subscriber: one subscription set == one connection
// ---------------------------------------------------------------------------

/**
 * One subscription set on one socket, because herdr accepts a single request
 * per connection -- so subscriptions can never be added to a live stream.
 *
 * Two subtleties, both learned the hard way:
 *
 *  - The event handler is passed INTO start() rather than attached after it.
 *    Any frame herdr batched into the same chunk as the ack would otherwise be
 *    emitted before the caller's `await` resumed, and lost.
 *
 *  - Loss is latched, because emitting to no listener is a silent no-op. A drop
 *    that happens before the consumer attaches would otherwise strand the
 *    reconnect loop forever.
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

  /**
   * Resolves once herdr acknowledges the subscription. Before the ack, every
   * problem rejects; after it, every problem is a loss.
   */
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
        // A close before the ack must reject, or start() never settles at all:
        // the ack timer is already cleared and no other path resolves. That
        // would park connectOnce forever, holding stale colours and logging
        // nothing.
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

          if (isResultResponse(msg) && msg.result.type === SUBSCRIPTION_STARTED) {
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

export type PaneStatus = { paneId: string; status: AgentStatus };

export type HerdrClientEvents = {
  seed: (snapshot: SessionSnapshot) => void;
  event: (frame: EventFrame) => void;
  /** The authoritative status signal, one subscription per agent pane. */
  paneStatus: (s: PaneStatus) => void;
  /** The full authoritative agent list, from each agent.list refresh. */
  agents: (list: AgentInfo[]) => void;
  /** Authoritative workspace membership and order, from workspace.list. */
  workspaces: (list: WorkspaceInfo[]) => void;
  /**
   * The focused pane changed. Carries no payload on purpose: it says *when*,
   * and whoever cares reads what they need for themselves. Unlike the other
   * events here it triggers no refresh of its own -- focus moves far too often
   * to spend an `agent.list` on each one, and nothing this client owns depends
   * on it.
   */
  focus: () => void;
  /** Fired on every gap. Consumers must repaint from the next seed, never carry colour across. */
  disconnected: (reason: string) => void;
};

export declare interface HerdrClient {
  on<K extends keyof HerdrClientEvents>(e: K, l: HerdrClientEvents[K]): this;
  emit<K extends keyof HerdrClientEvents>(e: K, ...a: Parameters<HerdrClientEvents[K]>): boolean;
}

/**
 * The subscribe half of the client, which is all a consumer of its events
 * needs. Asking for the whole HerdrClient forced anything standing in for one
 * to be cast through `unknown`, which then silently covered every method the
 * stand-in did not have.
 */
export type HerdrClientEventSource = {
  on<K extends keyof HerdrClientEvents>(e: K, l: HerdrClientEvents[K]): unknown;
};

/**
 * Owns exactly two connections: one for topology, one for agent status.
 *
 * Status comes only from `pane.agent_status_changed`, which needs a pane_id --
 * but one subscribe can carry an entry per pane, so all of them share a single
 * socket (measured; re-runnable with tools/herdr-probe.mjs). Panes cannot be
 * ADDED to a live subscription, so that socket is rebuilt whenever the agent
 * set changes, and the agent.list refresh behind every trigger covers the gap.
 *
 * Topology has its own connection so an agent appearing never tears it down,
 * and so it can be subscribed before the snapshot is requested.
 *
 * Either socket dropping rebuilds both, so colours never survive a gap.
 */
export class HerdrClient extends EventEmitter {
  private globalSub: Subscriber | null = null;
  /** One connection carrying every agent pane's status subscription. */
  private statusSub: Subscriber | null = null;
  /** The pane set statusSub covers, so it is only rebuilt when that changes. */
  private watchedPanes = new Set<string>();
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

  /**
   * Single-use: a stopped client cannot be started again. Restarting would
   * have to rendezvous with a connectLoop that is still draining, and reviving
   * it would resume on a stale generation. Nothing needs it -- both entry
   * points stop only at shutdown -- so this refuses loudly rather than
   * returning normally and never connecting.
   *
   * `stopped` is checked before `loopRunning` so a restart landing in the
   * draining window reports the real reason, not "already started".
   */
  async start(): Promise<void> {
    if (this.stopped) {
      this.log.warn('herdr client was stopped and cannot be restarted; ignoring start()');
      return;
    }
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

  focusAgent(paneId: string): Promise<void> {
    return this.call(reqAgentFocus(`pad:focus:${paneId}`, paneId));
  }
  focusWorkspace(workspaceId: string): Promise<void> {
    return this.call(reqWorkspaceFocus('pad:workspace-focus', workspaceId));
  }

  focusTab(tabId: string): Promise<void> {
    return this.call(reqTabFocus('pad:tab-focus', tabId));
  }

  focusPaneDirection(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
    return this.call(reqPaneFocusDirection('pad:pane-focus', direction));
  }

  agentList(): Promise<AgentInfo[]> {
    return this.list(reqAgentList('pad:agents'), ResultKey.agents, isAgentInfo);
  }

  workspaceList(): Promise<WorkspaceInfo[]> {
    return this.list(reqWorkspaceList('pad:workspaces'), ResultKey.workspaces, isWorkspaceInfo);
  }

  tabList(workspaceId: string): Promise<TabInfo[]> {
    return this.list(reqTabList('pad:tabs', workspaceId), ResultKey.tabs, isTabInfo);
  }

  async currentPaneId(): Promise<string | null> {
    const current = await this.request(reqPaneCurrent('pad:current'));
    const pane = current.pane;
    return isRecord(pane) && typeof pane.pane_id === 'string' ? pane.pane_id : null;
  }

  sendKeysToPane(paneId: string, keys: string[]): Promise<void> {
    return this.call(reqPaneSendKeys('pad:send-keys', paneId, keys));
  }

  async sendKeysToFocusedPane(keys: string[]): Promise<void> {
    const paneId = await this.currentPaneId();
    if (paneId) await this.sendKeysToPane(paneId, keys);
  }

  /**
   * Raw input for what the key vocabulary cannot say. Separate from
   * sendKeysToPane rather than folded into it, because losing herdr's
   * server-side key validation is a real cost and should be visible at the
   * call site: this method's bytes are checked by nothing.
   */
  sendTextToPane(paneId: string, text: string): Promise<void> {
    return this.call(reqPaneSendText('pad:send-text', paneId, text));
  }

  /**
   * There is no toggle method, so this probes: close whatever popup is open,
   * and if there was none, open ours. The notification is the last resort for
   * a standalone install with no plugin pane registered.
   */
  async toggleAgentPopup(): Promise<void> {
    try {
      await this.call(reqPopupClose('pad:popup-close'));
      return;
    } catch {
      // No popup is open; try the House of Herdr plugin entrypoint.
    }
    try {
      await this.call(reqPluginPaneOpen('pad:popup-open'));
    } catch {
      await this.call(reqNotificationShow('pad:popup-fallback', 'Creator Micro controls'));
    }
  }

  /** Back to the pre-connect state, so the next attempt starts clean. */
  private teardown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    this.globalSub?.stop();
    this.globalSub = null;

    this.statusSub?.stop();
    this.statusSub = null;
    this.watchedPanes = new Set();

    this.seeded = false;
    this.pending = [];
    this.lossLatch = null;
  }

  /** Connect, wait for the connection to die, back off, repeat until stopped. */
  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      // Each attempt gets a generation, so work from an abandoned one can tell
      // that it is stale and bow out. See stale().
      const gen = ++this.generation;
      let connectedAt = 0;

      try {
        await this.connectOnce(gen);
        connectedAt = Date.now();

        // Park here until something wakes us: a lost stream, or stop().
        await new Promise<void>((resolve) => {
          const finish = (err: Error | null) => {
            if (err && gen === this.generation) {
              this.log.warn('herdr stream lost', { reason: err.message });
              this.emit('disconnected', err.message);
            }
            resolve();
          };

          this.wake = finish;

          // A drop during connectOnce happened before `wake` existed, but
          // signalLoss latches it, so it is picked up here rather than parking
          // the loop on an already-dead connection.
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
      // successful subscribe alone lets a herdr that accepts subscriptions and
      // immediately drops them drive a permanent reconnect storm.
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

    // 1. Topology stream first, so nothing that happens from here is missed.
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
    sub.onLost((err) => {
      if (gen === this.generation) this.signalLoss(err);
    });

    // 2. Snapshot. Frames arriving during this request are buffered, not lost.
    const result = await this.request(reqSnapshot('seed'));
    if (this.stale(gen)) throw new Error('client stopped during connect');

    const snapshot = parseSnapshot(result[ResultKey.snapshot]);
    if (!snapshot) throw new Error('snapshot response had no usable snapshot payload');

    // A protocol bump does not necessarily break anything, but it should never
    // be discovered by debugging a wrong colour weeks later.
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

    // 3. Seed, then replay whatever arrived while the snapshot was in flight.
    this.emit('seed', snapshot);
    this.seeded = true;

    const replay = this.pending;
    this.pending = [];
    for (const frame of replay) this.emit('event', frame);

    // 4. Status stream. Opened here rather than left to refreshAgents, which
    // runs behind a Coalescer: if a lifecycle event already triggered one,
    // that call returns immediately and we would finish with no status source.
    await this.syncStatusSubscription(agentPanes, gen);
    if (this.stale(gen)) throw new Error('client stopped during connect');

    // 5. Backfill. The snapshot's statuses predate the subscription just
    // opened, and status events only report future changes, so anything that
    // moved in between would stay invisible until the next real transition.
    await this.refreshAgents(gen);

    // ...and again on a timer, which is what makes the daemon self-healing.
    this.refreshTimer = setInterval(() => {
      if (this.stale(gen)) return;
      void this.refreshAgents(gen);
    }, this.opts.refreshIntervalMs);

    this.refreshTimer.unref?.();
  }

  private request(req: Request): Promise<Record<string, unknown>> {
    return requestOnce(this.socketPath, req, this.log, this.opts.requestTimeoutMs);
  }

  /** A request whose result carries nothing worth reading. */
  private async call(req: Request): Promise<void> {
    await this.request(req);
  }

  /**
   * A request whose result is one named array, absent meaning empty.
   *
   * The element guard is required rather than optional. Without it this was
   * `result[key] as T[]` -- an assertion about a payload nobody had looked at,
   * made in a generic that could not have checked it even in principle, and
   * inferred from the call site's return type. Anything herdr put in that array
   * became a `T` on the strength of the caller's expectations.
   */
  private async list<T>(req: Request, key: string, valid: (v: unknown) => v is T): Promise<T[]> {
    const result = await this.request(req);
    return asArray(result[key]).filter(valid);
  }

  private stale(gen: number): boolean {
    return this.stopped || gen !== this.generation;
  }

  /** Buffers until the seed has been emitted, then forwards. */
  private onGlobalFrame(frame: EventFrame, gen: number): void {
    if (gen !== this.generation) return;

    if (!this.seeded) this.pending.push(frame);
    else this.emit('event', frame);

    void this.trackPaneLifecycle(frame, gen);
  }

  /**
   * Point the status connection at exactly `paneIds`, rebuilding it if that set
   * has changed.
   *
   * A subscription cannot be extended in place -- a second request on a live
   * socket closes it -- so growth means a new connection. The window while it
   * reconnects is covered by the agent.list that triggered this call and by the
   * periodic refresh, both of which carry authoritative statuses.
   */
  private async syncStatusSubscription(paneIds: string[], gen: number): Promise<void> {
    // Sorted so the comparison against the watched set is order-independent.
    const desired = [...new Set(paneIds)].sort();
    if (this.statusSub && sameSet(desired, this.watchedPanes)) return;

    // A deliberate rebuild is not a loss and must not trigger a reconnect.
    this.statusSub?.removeAllListeners('lost');
    this.statusSub?.stop();
    this.statusSub = null;
    this.watchedPanes = new Set();

    if (desired.length === 0 || this.stale(gen)) return;

    const sub = new Subscriber(
      this.socketPath,
      desired.map(paneStatusSubscription),
      this.log,
      `status x${desired.length}`,
      this.opts.ackTimeoutMs,
    );

    try {
      await sub.start((frame) => {
        if (gen !== this.generation) return;

        // Validate rather than cast: an unrecognised status would reach the
        // glyph and colour tables, which only know the five real ones. The
        // pane id must be present too, since one socket carries many panes.
        const d = frame.data ?? {};
        const paneId = d.pane_id;
        const status = d.agent_status;
        if (typeof paneId !== 'string' || !isAgentStatus(status)) return;

        this.emit('paneStatus', { paneId, status });
      });
    } catch (err) {
      sub.stop();

      // With no status source every key holds its seed colour forever while
      // the rest keep updating -- a stale pad that looks healthy. Treat it as
      // a connection failure so the whole set is rebuilt.
      this.log.warn('status subscription failed; reconnecting', {
        panes: desired.length,
        reason: reason(err),
      });

      if (gen === this.generation) {
        this.signalLoss(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    if (this.stale(gen)) {
      sub.stop();
      return;
    }

    this.statusSub = sub;
    this.watchedPanes = new Set(desired);

    sub.onLost((err) => {
      if (gen === this.generation) this.signalLoss(err);
    });
  }

  /**
   * Turns pane lifecycle events into agent.list refreshes, which own the
   * status subscription set.
   *
   * The events are triggers, never the source: agent.list is what decides which
   * panes hold an agent. That closes two gaps lifecycle events leave open -- an
   * agent can stop being one without its pane closing, and a
   * pane_agent_detected can be missed entirely. Each branch here only decides
   * whether a refresh is worth a round trip.
   */
  private async trackPaneLifecycle(frame: EventFrame, gen: number): Promise<void> {
    const d = frame.data ?? {};
    const type = eventName(frame);

    // A pane appeared, or became an agent.
    if (type === Evt.paneAgentDetected || type === Evt.paneCreated) {
      // pane_created carries the record, so a plain shell pane can be filtered
      // out before it costs a round trip. pane_agent_detected carries only ids
      // and always implies an agent.
      const pane = d.pane;
      if (type === Evt.paneCreated && isRecord(pane) && !pane.agent) return;

      await this.refreshAgents(gen);
      return;
    }

    if (type === Evt.paneFocused) {
      this.emit('focus');
      return;
    }

    // A pane went away.
    if (type === Evt.paneClosed || type === Evt.paneExited) {
      // Only a pane we actually watch is worth a round trip; shell panes open
      // and close constantly and never held a status subscription.
      const paneId = d.pane_id;
      if (typeof paneId === 'string' && this.watchedPanes.has(paneId)) {
        await this.refreshAgents(gen);
      }
      return;
    }

    if (MEMBERSHIP_EVENTS.has(type)) await this.reconcileWorkspaces(gen);
  }

  /**
   * Membership and order come from workspace.list, never from the events --
   * they are only triggers to re-read it.
   *
   * This was originally written to defend against herdr replaying a backlog of
   * historical workspace events out of order on subscribe, which could
   * resurrect a long-deleted workspace. That is UNREPRODUCED on herdr 0.8.2
   * (tools/herdr-probe.mjs): subscribing to all six lifecycle events in a
   * three-workspace session replayed nothing at all. One session's silence is
   * not a disproof, so the shape stays.
   *
   * It is the right shape regardless: workspace.list is authoritative and
   * events are not, and membership changes are rare enough that a round trip
   * each costs nothing.
   */
  private reconcileWorkspaces(gen: number): Promise<void> {
    return this.reconcileGate.run(async () => {
      try {
        const result = await this.request(reqWorkspaceList('workspaces'));
        if (this.stale(gen)) return;
        // An absent list means "herdr said nothing", which must not be read as
        // "there are no workspaces" -- that would blank every label.
        const list = result[ResultKey.workspaces];
        if (isArray(list)) this.emit('workspaces', list.filter(isWorkspaceInfo));
      } catch (err) {
        this.log.warn('could not reconcile workspaces', { reason: reason(err) });
      }
    });
  }

  /**
   * The authoritative agent refresh: one `agent.list` covering every pane.
   *
   * Runs at connect, on lifecycle events, and on a timer. The timer is what
   * makes the daemon self-healing -- a missed event, a status stream gone
   * quiet, or an agent that vanished without the event we expected all resolve
   * on the next pass rather than persisting until a reconnect. Coalesced, so a
   * burst of triggers costs one extra listing, not one each.
   */
  private refreshAgents(gen: number): Promise<void> {
    return this.backfillGate.run(async () => {
      try {
        const result = await this.request(reqAgentList('agents'));
        if (this.stale(gen)) return;
        // isAgentInfo subsumes the pane_id and agent_status checks this used to
        // make by hand, right after asserting the array's element type.
        const agents = asArray(result[ResultKey.agents]).filter(isAgentInfo);
        this.emit('agents', agents);
        await this.syncStatusSubscription(
          agents.map((a) => a.pane_id),
          gen,
        );
      } catch (err) {
        this.log.warn('could not refresh agents', { reason: reason(err) });
      }
    });
  }
}
