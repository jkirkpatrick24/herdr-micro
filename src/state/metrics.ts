import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Logger } from '../log.js';
import type { Transition } from './store.js';

export const DEFAULT_METRICS_PATH = join(
  homedir(),
  '.local',
  'state',
  'herdr-micro',
  'metrics.jsonl',
);

/**
 * One NDJSON line per status transition. Nothing gates on this -- it exists so
 * that "how often does an agent actually block, and for how long" is
 * answerable later instead of guessed at.
 *
 * Writes are fire-and-forget: a metrics failure must never disturb the daemon.
 */
export class Metrics {
  private ready: Promise<void> | null = null;
  private failed = false;

  constructor(
    private readonly log: Logger,
    private readonly path: string = DEFAULT_METRICS_PATH,
    private readonly enabled: boolean = true,
  ) {}

  record(t: Transition): void {
    if (!this.enabled || this.failed) return;
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      pane_id: t.paneId,
      label: t.label,
      from: t.from,
      to: t.to,
      duration_ms: t.durationMs,
    })}\n`;

    void this.write(line);
  }

  private async write(line: string): Promise<void> {
    try {
      this.ready ??= mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
      await this.ready;
      await appendFile(this.path, line, 'utf8');
    } catch (err) {
      this.failed = true;
      this.log.warn('metrics disabled after write failure', {
        path: this.path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
