import { loadConfig } from './config.js';
import { type Counters, makeLogger, makePainter, paint, statsFields, wirePad } from './daemon.js';
import { PadControls } from './hardware/controls.js';
import { CreatorMicro } from './hardware/device.js';
import { ambientLighting } from './hardware/lighting.js';
import { HerdrClient } from './herdr/client.js';
import { Metrics } from './state/metrics.js';
import { Store } from './state/store.js';
import { wireClientToStore } from './wiring.js';

const STATS_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const log = makeLogger();
  const config = await loadConfig(log);
  const store = new Store(log);
  const metrics = new Metrics(log, undefined, config.metricsEnabled);
  const client = new HerdrClient(log);
  const pad = new CreatorMicro(log);
  const counters: Counters = { eventsIn: 0, repaints: 0 };

  const controls = new PadControls(client, store, config.controls, log, (mode) => {
    paint(pad.setAmbientLighting(ambientLighting(config, mode)), 'dial ring update', log);
  });

  store.on('transition', (t) => {
    log.info('transition', { agent: t.label, from: t.from, to: t.to, afterMs: t.durationMs });
    metrics.record(t);
  });
  store.on('changed', makePainter(pad, config, log, counters));

  wireClientToStore(client, store, {
    onFrame: () => {
      counters.eventsIn++;
    },
    onDisconnected: (reason) => log.warn('disconnected, painting idle', { reason }),
  });
  wirePad(pad, controls, store, config, log);

  const stats = setInterval(() => log.info('stats', statsFields(counters)), STATS_INTERVAL_MS);
  stats.unref();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal, ...statsFields(counters) });
    clearInterval(stats);
    pad.stop();
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.start();
  pad.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
