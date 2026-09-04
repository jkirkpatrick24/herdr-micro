import { loadConfig } from './config.js';
import { HerdrClient } from './herdr/client.js';
import { eventName, type SessionSnapshot } from './herdr/rpc.js';
import type { Logger } from './log.js';
import { renderRow, route } from './route.js';
import { Metrics } from './state/metrics.js';
import { type SlotView, Store, type Transition } from './state/store.js';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), msg];
    if (fields && Object.keys(fields).length) {
      parts.push(
        Object.entries(fields)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' '),
      );
    }
    process.stderr.write(`${parts.join(' ')}\n`);
  };
  return {
    info: (m, f) => line('info', m, f),
    warn: (m, f) => line('warn', m, f),
    error: (m, f) => line('error', m, f),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const log = makeLogger();
  const config = await loadConfig(log);
  const store = new Store(log);
  const metrics = new Metrics(log, undefined, config.metricsEnabled);
  const client = new HerdrClient(log);

  let eventsIn = 0;
  let repaints = 0;

  store.on('transition', (t: Transition) => {
    log.info('transition', {
      agent: t.label,
      from: t.from,
      to: t.to,
      afterMs: t.durationMs,
    });
    metrics.record(t);
  });

  store.on('changed', (view: SlotView[]) => {
    repaints++;
    process.stdout.write(`${renderRow(view)}\n`);
  });

  client.on('seed', (snapshot: SessionSnapshot) => store.applySeed(snapshot));

  client.on('workspaces', (list) => store.applyWorkspaces(list));

  client.on('agents', (list) => store.applyAgents(list));

  client.on('paneStatus', (s) => {
    eventsIn++;
    store.applyPaneStatus(s.paneId, s.status);
  });

  client.on('disconnected', (reason: string) => {
    log.warn('disconnected, painting idle', { reason });
    store.setDisconnected();
  });

  client.on('event', (frame) => {
    eventsIn++;
    route(store, eventName(frame), frame.data ?? {});
  });

  // The headline number for the acceptance run: inbound events should vastly
  // exceed repaints. If they are close, the dedupe gate is not working and the
  // pad would be receiving ~120 frames/sec.
  const stats = setInterval(() => {
    log.info('stats', {
      eventsIn,
      repaints,
      ratio: repaints ? (eventsIn / repaints).toFixed(1) : 'n/a',
    });
  }, 30_000);
  stats.unref();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal, eventsIn, repaints });
    clearInterval(stats);
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
