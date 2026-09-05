import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentInfo,
  EventFrame,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from '../herdr/rpc.js';
import { isHerdrKey } from '../herdr/rpc.js';
import { asArray, isRecord } from '../json.js';
import { snapshot as snapshotFixture } from './fixtures.js';

/**
 * A stand-in for the herdr API socket.
 *
 * The one behaviour it MUST reproduce is that herdr answers only the first
 * request on a connection and silently ignores anything after it. That
 * constraint is what forces the whole N+1-sockets design, so a fake that
 * accepted multiple requests would make the architecture tests tautological.
 *
 * Kept in src/testing/ rather than src/test/ deliberately: Node's test runner
 * treats every file inside a directory named `test` as a test file.
 */
export type FakeRequest = { conn: number; method: string; params: Record<string, unknown> };

export type FakeHerdr = {
  path: string;
  requests: FakeRequest[];
  connections: number;
  /** Broadcast an event frame to every live subscriber socket. */
  push(frame: EventFrame): void;
  /** Write raw bytes to every live subscriber socket, for chunk-boundary tests. */
  pushRaw(bytes: string): void;
  /** Drop every live connection, simulating a herdr restart. */
  dropAll(): void;
  setSnapshot(snapshot: SessionSnapshot): void;
  setAgents(agents: AgentInfo[]): void;
  setWorkspaces(workspaces: WorkspaceInfo[]): void;
  setTabs(tabs: Record<string, TabInfo[]>): void;
  setCurrentPane(paneId: string | null): void;
  readonly openConnections: number;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
};

export type FakeOptions = {
  snapshot?: SessionSnapshot;
  agents?: AgentInfo[];
  /** Accept the connection but never acknowledge the subscribe. */
  stallSubscribe?: boolean;
  /** Accept every request and never answer any of them. */
  stallRequests?: boolean;
  /** Reply to a subscribe with an error envelope. */
  rejectSubscribe?: string;
  /** Emit this frame in the SAME write() as the subscription ack. */
  ackChunkFrame?: EventFrame;
  /** On receiving this method, drop every connection instead of answering. */
  dropAllOnMethod?: string;
  /** Drop every connection once this many requests have been received. */
  dropAllAfterRequests?: number;
  /** Delay each subscription ack, so serialised opening is measurable. */
  ackDelayMs?: number;
  /** Reject only per-pane status subscribes, leaving the global stream healthy. */
  failPaneSubscribe?: boolean;
  workspaces?: WorkspaceInfo[];
  /** Tabs per workspace id; tab.list answers from this map. */
  tabs?: Record<string, TabInfo[]>;
  /** What pane.current reports; null means no pane is focused. */
  currentPane?: string | null;
  /**
   * Methods that answer with an error envelope instead of a result. The popup
   * toggle is defined by which of its three methods fail, so testing it needs
   * this rather than another bespoke flag.
   */
  failMethods?: string[];
};

/** Methods that only acknowledge; the assertion is that they were called at all. */
const MUTATIONS = new Set([
  'workspace.focus',
  'tab.focus',
  'agent.focus',
  'pane.focus_direction',
  'pane.send_text',
  'notification.show',
  'popup.close',
  'plugin.pane.open',
]);

export async function startFakeHerdr(opts: FakeOptions = {}): Promise<FakeHerdr> {
  // macOS caps sun_path at 104 bytes; a short tmp dir keeps well inside it.
  const dir = mkdtempSync(join(tmpdir(), 'herdr-'));
  const path = join(dir, 'h.sock');

  const requests: FakeRequest[] = [];
  const subscribers = new Set<net.Socket>();
  const open = new Set<net.Socket>();
  let connections = 0;
  let snapshot: SessionSnapshot = opts.snapshot ?? snapshotFixture([], []);
  // Derive the agent list from the snapshot unless one is given explicitly. A
  // real server never reports agent panes in its snapshot and an empty
  // agent.list, and subscription reconciliation is sensitive to that
  // disagreement.
  let agents: AgentInfo[] =
    opts.agents ??
    // flatMap rather than filter().map(): filter does not narrow `agent` away
    // from null, and asserting it back was the only thing holding the shape up.
    (opts.snapshot?.panes ?? []).flatMap((p) =>
      p.agent
        ? [
            {
              agent: p.agent,
              agent_status: p.agent_status,
              pane_id: p.pane_id,
              tab_id: p.tab_id,
              workspace_id: p.workspace_id,
            },
          ]
        : [],
    );

  let workspaces: WorkspaceInfo[] = opts.workspaces ?? [];
  let tabs: Record<string, TabInfo[]> = opts.tabs ?? {};
  let currentPane: string | null = opts.currentPane ?? null;
  const failMethods = new Set(opts.failMethods ?? []);

  const dropEveryConnection = () => {
    for (const s of open) s.destroy();
    open.clear();
    subscribers.clear();
  };

  const server = net.createServer((socket) => {
    const conn = ++connections;
    open.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      open.delete(socket);
      subscribers.delete(socket);
    });

    let buf = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        // The real server does not merely ignore a second request on a
        // connection: it CLOSES the connection, taking any live subscription
        // with it. Measured against herdr 0.8.2 -- see tools/herdr-probe.mjs,
        // which times a control socket against one that sends a second
        // request. Ignoring it here would let a multiplexing bug pass.
        if (handled) {
          socket.destroy();
          return;
        }
        handled = true;

        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) return;

        const req = {
          id: typeof parsed.id === 'string' ? parsed.id : '',
          method: typeof parsed.method === 'string' ? parsed.method : '',
        };
        const params = isRecord(parsed.params) ? parsed.params : {};
        requests.push({ conn, method: req.method, params });

        if (opts.stallRequests) return;

        if (opts.dropAllAfterRequests && requests.length === opts.dropAllAfterRequests) {
          dropEveryConnection();
          return;
        }

        if (opts.dropAllOnMethod && req.method === opts.dropAllOnMethod) {
          dropEveryConnection();
          return;
        }

        const reply = (result: Record<string, unknown>) =>
          socket.write(`${JSON.stringify({ id: req.id, result })}\n`);
        const fail = (message: string) =>
          socket.write(`${JSON.stringify({ id: req.id, error: { message } })}\n`);

        if (failMethods.has(req.method)) {
          fail(`${req.method} refused`);
          return;
        }

        if (req.method === 'session.snapshot') {
          reply({ type: 'session_snapshot', snapshot });
        } else if (req.method === 'agent.list') {
          reply({ type: 'agent_list', agents });
        } else if (req.method === 'events.subscribe') {
          if (opts.stallSubscribe) return;
          if (opts.failPaneSubscribe && JSON.stringify(params).includes('agent_status_changed')) {
            fail('pane subscribe refused');
            return;
          }
          if (opts.rejectSubscribe) {
            fail(opts.rejectSubscribe);
            return;
          }
          subscribers.add(socket);
          const ack = `${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`;
          // Deliberately one write: exercises the ack/event chunk boundary.
          const payload = opts.ackChunkFrame
            ? `${ack + JSON.stringify(opts.ackChunkFrame)}\n`
            : ack;
          if (opts.ackDelayMs) setTimeout(() => socket.write(payload), opts.ackDelayMs);
          else socket.write(payload);
        } else if (req.method === 'workspace.list') {
          reply({ type: 'workspace_list', workspaces });
        } else if (req.method === 'tab.list') {
          const id = String(params.workspace_id ?? '');
          reply({ type: 'tab_list', tabs: tabs[id] ?? [] });
        } else if (req.method === 'pane.current') {
          // A pane_id-less envelope is how herdr reports "nothing focused", and
          // the client is meant to treat that as a no-op rather than an error.
          reply({
            type: 'pane_current',
            pane: currentPane === null ? {} : { pane_id: currentPane },
          });
        } else if (req.method === 'pane.send_keys') {
          // The real server validates every key name before writing a byte and
          // answers `invalid_key` for anything outside its vocabulary. Echoing
          // back whatever it was handed is what let the daemon ship `pageup`
          // and `pagedown`: scroll mode's tests passed while herdr rejected
          // every request the dial actually sent.
          const bad = asArray(params.keys)
            .filter((k): k is string => typeof k === 'string')
            .find((k) => !isHerdrKey(k));

          if (bad !== undefined) fail(`unsupported key ${bad}`);
          else reply({ type: 'ok' });
        } else if (MUTATIONS.has(req.method)) {
          reply({ type: 'ok' });
        } else {
          // Loud beats slow: an unhandled method would otherwise hang the client
          // until its request timeout and surface as an unrelated flake.
          fail(`fake-herdr has no handler for ${req.method}`);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(path, resolve));

  return {
    path,
    requests,
    get connections() {
      return connections;
    },
    push(frame) {
      const line = `${JSON.stringify(frame)}\n`;
      for (const s of subscribers) s.write(line);
    },
    pushRaw(bytes) {
      for (const s of subscribers) s.write(bytes);
    },
    dropAll: dropEveryConnection,
    setSnapshot(next) {
      snapshot = next;
    },
    setAgents(next) {
      agents = next;
    },
    setWorkspaces(next) {
      workspaces = next;
    },
    setTabs(next) {
      tabs = next;
    },
    setCurrentPane(next) {
      currentPane = next;
    },
    get openConnections() {
      return open.size;
    },
    async waitFor(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      // Most tests here wait on several conditions in turn, so a bare "timed
      // out" names neither which one stalled nor how far the client got. The
      // predicate's own source is the only description available, and the
      // request log is what almost every one of them is really asking about.
      const source = predicate.toString().replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms: ${source}\n` +
          `  requests (${requests.length}): ${requests.map((r) => r.method).join(', ') || '(none)'}\n` +
          `  connections: ${connections} opened, ${open.size} still open`,
      );
    },
    async stop() {
      dropEveryConnection();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
