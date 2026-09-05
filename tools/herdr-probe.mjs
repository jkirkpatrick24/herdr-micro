#!/usr/bin/env node
// Read-only probe of herdr's socket API.
//
// Every "measured against herdr 0.8.2" claim in src/herdr/rpc.ts and
// src/herdr/client.ts is re-runnable from here. It only subscribes and reads --
// it never focuses a pane, sends keys, or changes any session state.
//
//   node tools/herdr-probe.mjs            # all checks, ~20s
//   node tools/herdr-probe.mjs --watch 300  # also watch for status changes
//
// Needs a running herdr; HERDR_SOCKET_PATH, else the default socket path.
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOCKET =
  process.env.HERDR_SOCKET_PATH ?? join(homedir(), '.config', 'herdr', 'herdr.sock');
const STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);
const watchArg = process.argv.indexOf('--watch');
const WATCH_S = watchArg > 0 ? Number(process.argv[watchArg + 1] ?? 300) : 0;

/** Open a connection, send one request, collect frames until `ms` elapses. */
function session(req, ms, onFrame = () => {}) {
  return new Promise((resolve) => {
    const s = net.createConnection(SOCKET);
    const t0 = Date.now();
    const out = { frames: [], closedAt: null, error: null, ack: null };
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const f = JSON.parse(line);
        if (f.error) out.error = f.error;
        else if (f.result) out.ack = f.result;
        else {
          out.frames.push(f);
          onFrame(f, Date.now() - t0, s);
        }
      }
    });
    s.on('close', () => {
      out.closedAt ??= Date.now() - t0;
    });
    s.on('error', () => {});
    s.on('connect', () => s.write(`${JSON.stringify(req)}\n`));
    setTimeout(() => {
      s.destroy();
      resolve(out);
    }, ms);
  });
}

const sub = (subscriptions, id = 'probe') => ({ id, method: 'events.subscribe', params: { subscriptions } });
const ok = (b) => (b ? 'CONFIRMED' : 'NOT CONFIRMED');

async function snapshot() {
  const r = await session({ id: 'snap', method: 'session.snapshot', params: {} }, 1500);
  return r.ack?.snapshot ?? null;
}

// --- 1. one request per connection, and the second one closes it ------------
async function checkOneRequestPerConnection() {
  console.log('\n=== 1. one request per connection ===');
  const subs = [{ type: 'pane.updated' }];

  // Control: subscribe and send nothing further.
  const control = session(sub(subs, 'control'), 6000);

  // Victim: identical subscriptions, plus a second request at 3s. Hand-rolled
  // rather than via session() because it has to write again mid-flight.
  const victimSocket = net.createConnection(SOCKET);
  let vClosed = null;
  const vT0 = Date.now();
  victimSocket.setEncoding('utf8');
  victimSocket.resume(); // a paused socket never emits close
  victimSocket.on('close', () => (vClosed ??= Date.now() - vT0));
  victimSocket.on('error', () => {});
  victimSocket.on('connect', () => {
    victimSocket.write(`${JSON.stringify(sub(subs, 'v'))}\n`);
    setTimeout(
      () => victimSocket.write(`${JSON.stringify({ id: 'second', method: 'agent.list', params: {} })}\n`),
      3000,
    );
  });

  const c = await control;
  victimSocket.destroy();

  console.log(`  control (no second request): ${c.closedAt ? `closed at ${c.closedAt}ms` : 'STILL OPEN at 6000ms'}`);
  console.log(`  victim  (second request @3000ms): ${vClosed ? `closed at ${vClosed}ms` : 'still open'}`);
  console.log(`  -> ${ok(!c.closedAt && vClosed && vClosed > 3000 && vClosed < 4500)}: a second request closes the connection`);
}

// --- 2. pane.updated is not a status source ---------------------------------
async function checkPaneUpdated(snap) {
  console.log('\n=== 2. pane.updated scope and rate ===');
  const byPane = new Map();
  const titles = new Map();
  await session(sub([{ type: 'pane.updated' }], 'pu'), 8000, (f) => {
    const p = f.data?.pane ?? {};
    byPane.set(p.pane_id, (byPane.get(p.pane_id) ?? 0) + 1);
    titles.set(p.pane_id, p.terminal_title_stripped ?? p.terminal_title ?? '');
  });
  console.log(`  session has ${snap?.panes?.length ?? '?'} panes; focused is ${snap?.focused_pane_id}`);
  for (const [id, n] of [...byPane].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(id).padEnd(8)} ${String(n).padStart(4)} events  ${(n / 8).toFixed(1)} Hz  title=${JSON.stringify(titles.get(id))}`);
  }
  if (!byPane.size) console.log('    (no pane.updated at all -- nothing was redrawing)');
  const chatty = [...byPane.keys()];
  console.log(`  -> ${ok(byPane.size <= 1)}: pane.updated covers at most one pane at a time`);
  if (chatty.length === 1 && snap?.focused_pane_id && chatty[0] !== snap.focused_pane_id) {
    console.log(`  -> NOTE: the chatty pane (${chatty[0]}) is NOT the focused one (${snap.focused_pane_id});`);
    console.log('           it tracks whatever is redrawing, not focus.');
  }
}

// --- 3. pane_id is required, and many panes fit in one subscribe ------------
async function checkStatusSubscription(snap) {
  console.log('\n=== 3. pane.agent_status_changed subscription shape ===');
  const noId = await session(sub([{ type: 'pane.agent_status_changed' }], 'noid'), 2000);
  console.log(`  without pane_id: ${noId.error ? `ERROR ${noId.error.code}: ${noId.error.message}` : 'accepted'}`);
  console.log(`  -> ${ok(!!noId.error)}: pane_id is required, so it cannot join the global set`);

  const panes = (snap?.agents ?? []).map((a) => a.pane_id);
  if (panes.length > 1) {
    const many = await session(sub(panes.map((p) => ({ type: 'pane.agent_status_changed', pane_id: p })), 'many'), 2000);
    console.log(`  ${panes.length} panes in ONE subscribe: ${many.error ? `ERROR ${many.error.code}` : `accepted (${many.ack?.type})`}`);
    console.log(`  -> ${ok(!many.error)}: several panes can share one connection`);
    console.log('     (if so, the N+1 socket fan-out in client.ts may be reducible --');
    console.log('      but note a new pane still cannot be ADDED to a live subscription)');
  }
}

// --- 4. workspace lifecycle replay ------------------------------------------
async function checkWorkspaceReplay(snap) {
  console.log('\n=== 4. workspace lifecycle replay on subscribe ===');
  const r = await session(
    sub(
      [
        { type: 'workspace.created' },
        { type: 'workspace.closed' },
        { type: 'workspace.moved' },
        { type: 'workspace.reordered' },
      ],
      'replay',
    ),
    5000,
  );
  console.log(`  live workspaces: ${snap?.workspaces?.length ?? '?'}`);
  console.log(`  lifecycle events replayed in 5s: ${r.frames.length}`);
  for (const f of r.frames.slice(0, 10)) console.log(`    ${f.event} ${f.data?.workspace_id ?? ''}`);
  console.log(`  -> ${ok(r.frames.length > 0)}: a historical backlog is replayed on subscribe`);
  if (!r.frames.length) console.log('     (client.ts reconcileWorkspaces is justified by a replay this run did not see)');
}

// --- 5. one socket vs the fan-out, for real status frames -------------------
async function watchStatus(snap, seconds) {
  console.log(`\n=== 5. one socket vs per-pane fan-out, over ${seconds}s ===`);
  const panes = (snap?.agents ?? []).map((a) => a.pane_id);
  if (!panes.length) return console.log('  no agent panes');
  const combined = new Map();
  const solo = new Map();
  const seen = [];
  const record = (m, where) => (f, ms) => {
    const d = f.data ?? {};
    if (!STATUSES.has(d.agent_status)) return;
    m.set(d.pane_id, (m.get(d.pane_id) ?? 0) + 1);
    seen.push(`  ${String(ms).padStart(7)}ms  ${where.padEnd(12)} ${d.pane_id} -> ${d.agent_status}  (event=${f.event})`);
  };
  const ms = seconds * 1000;
  await Promise.all([
    session(sub(panes.map((p) => ({ type: 'pane.agent_status_changed', pane_id: p })), 'comb'), ms, record(combined, 'COMBINED')),
    ...panes.map((p) => session(sub([{ type: 'pane.agent_status_changed', pane_id: p }], `s${p}`), ms, record(solo, `solo:${p}`))),
  ]);
  console.log('  pane        ONE socket   N sockets');
  for (const p of panes) console.log(`    ${p.padEnd(8)} ${String(combined.get(p) ?? 0).padStart(10)} ${String(solo.get(p) ?? 0).padStart(11)}`);
  for (const l of seen) console.log(l);
  const c = [...combined.values()].reduce((a, b) => a + b, 0);
  const s = [...solo.values()].reduce((a, b) => a + b, 0);
  console.log(c === 0 && s === 0 ? '  INCONCLUSIVE: nothing changed status.' : c === s ? '  MATCH: one socket delivered everything the fan-out did.' : '  MISMATCH.');
}

const snap = await snapshot();
if (!snap) {
  console.error(`no herdr snapshot from ${SOCKET} -- is herdr running?`);
  process.exit(1);
}
console.log(`herdr ${snap.version}, protocol ${snap.protocol}, socket ${SOCKET}`);
console.log(`rpc.ts is written against protocol 20${snap.protocol === 20 ? '' : ' -- MISMATCH'}`);
await checkOneRequestPerConnection();
await checkPaneUpdated(snap);
await checkStatusSubscription(snap);
await checkWorkspaceReplay(snap);
if (WATCH_S) await watchStatus(snap, WATCH_S);
process.exit(0);
