import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInfo, EventFrame, SessionSnapshot } from '../herdr/rpc.js';
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
};

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
    (opts.snapshot?.panes ?? [])
      .filter((p) => p.agent)
      .map((p) => ({
        agent: p.agent as string,
        agent_status: p.agent_status,
        pane_id: p.pane_id,
        tab_id: p.tab_id,
        workspace_id: p.workspace_id,
      }));

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
        if (handled) continue; // one request per connection, like the real server
        handled = true;

        const req = JSON.parse(line) as { id: string; method: string; params: unknown };
        requests.push({
          conn,
          method: req.method,
          params: (req.params ?? {}) as Record<string, unknown>,
        });

        if (opts.stallRequests) return;

        if (opts.dropAllAfterRequests && requests.length === opts.dropAllAfterRequests) {
          for (const s2 of open) s2.destroy();
          open.clear();
          subscribers.clear();
          return;
        }

        if (opts.dropAllOnMethod && req.method === opts.dropAllOnMethod) {
          for (const s2 of open) s2.destroy();
          open.clear();
          subscribers.clear();
          return;
        }

        if (req.method === 'session.snapshot') {
          socket.write(
            `${JSON.stringify({ id: req.id, result: { type: 'session_snapshot', snapshot } })}\n`,
          );
        } else if (req.method === 'agent.list') {
          socket.write(
            `${JSON.stringify({ id: req.id, result: { type: 'agent_list', agents } })}\n`,
          );
        } else if (req.method === 'events.subscribe') {
          if (opts.stallSubscribe) return;
          if (
            opts.failPaneSubscribe &&
            JSON.stringify(req.params).includes('agent_status_changed')
          ) {
            socket.write(
              `${JSON.stringify({ id: req.id, error: { message: 'pane subscribe refused' } })}\n`,
            );
            return;
          }
          if (opts.rejectSubscribe) {
            socket.write(
              `${JSON.stringify({ id: req.id, error: { message: opts.rejectSubscribe } })}\n`,
            );
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
    dropAll() {
      for (const s of open) s.destroy();
      open.clear();
      subscribers.clear();
    },
    setSnapshot(next) {
      snapshot = next;
    },
    setAgents(next) {
      agents = next;
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
      throw new Error('waitFor timed out');
    },
    async stop() {
      for (const s of open) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
