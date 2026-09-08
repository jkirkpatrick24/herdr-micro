import { loadConfig } from './config.js';
import {
  type Counters,
  makeLogger,
  makePainter,
  type PadControlSurface,
  paint,
  statsFields,
  wirePad,
} from './daemon.js';
import { PadControls } from './hardware/controls.js';
import { CreatorMicro } from './hardware/device.js';
import { ambientLighting, ringLighting } from './hardware/lighting.js';
import { HarnessLayer } from './harness/layer.js';
import { attachFocusEvents, attachHarnessLayer, harnessSurface } from './harness/wiring.js';
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

  // Declared before PadControls because its mode-change callback drives the
  // layer, and assigned after because the layer needs `controls.dialMode`.
  // The callback only ever runs later, so the cycle is in the types, not in time.
  let layer: HarnessLayer | null = null;

  const controls = new PadControls(client, store, config.controls, log, (mode) => {
    // `harness` is a dial mode like any other from PadControls' side; that it
    // latches a whole second layer is knowledge that lives here.
    layer?.setLatched(mode === 'harness');
    // The layer paints its own ring while latched, and would be overpainted here.
    if (mode !== 'harness') {
      paint(pad.setAmbientLighting(ambientLighting(config, mode)), 'dial ring update', log);
    }
  });

  // The harness layer sits in FRONT of PadControls rather than inside it: it
  // consumes an input or it does not, and the navigation layer sees everything
  // it declines. That is what keeps hardware/ and state/ unaware of it.
  //
  // Disabled, it is never built at all, and `surface` is the bare PadControls
  // -- so the config switch is genuinely "as if this feature did not ship",
  // not a live object that agrees to do nothing.
  layer = config.harness.enabled
    ? new HarnessLayer(client, config, log, (ring) => {
        const lighting =
          ring === null ? ambientLighting(config, controls.dialMode) : ringLighting(config, ring);
        paint(pad.setAmbientLighting(lighting), 'harness ring update', log);
      })
    : null;

  const surface: PadControlSurface = layer ? harnessSurface(controls, layer) : controls;

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
  wirePad(pad, surface, store, config, log);
  // After wirePad, deliberately -- see attachHarnessLayer.
  if (layer) {
    attachHarnessLayer(pad, layer);
    attachFocusEvents(client, layer);
  }

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

  // Only now: the dial's first mode is whatever the config puts first and no
  // mode-change callback fires for it, so an order starting at `harness` needs
  // latching by hand -- and latching resolves the focused harness, which cannot
  // work against a client that has not started.
  layer?.setLatched(controls.dialMode === 'harness');

  pad.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
