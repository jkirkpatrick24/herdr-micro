/**
 * The logging seam, in its own module so that state, config and metrics do not
 * have to import from the transport layer just to name this type.
 */
export type Logger = {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
};

/**
 * Runs an async job, and if asked again while one is in flight, runs it exactly
 * once more afterwards. Collapses a burst of triggers into at most one extra
 * pass instead of one round trip per trigger.
 */
export class Coalescer {
  private running = false;
  private again = false;

  async run(fn: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await fn();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }
}
