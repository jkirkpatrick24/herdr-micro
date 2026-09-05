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
 *
 * The extra pass runs the job that was asked for LAST, not the one already
 * running. A callback closes over the state it was made for -- the client's
 * gates capture a connection generation -- so re-running the original was not
 * a cheaper way to do the same work, it was doing the wrong work: the pending
 * request was dropped, and the re-run bowed out as stale. That silently skipped
 * the post-seed agent backfill whenever a stream dropped during a refresh.
 */
export class Coalescer {
  private running = false;
  /** The job to run next, or null when nothing has been asked for. */
  private queued: (() => Promise<void>) | null = null;

  async run(fn: () => Promise<void>): Promise<void> {
    // A newer request supersedes one that is only waiting: both would see the
    // same state, so running the older one first is a wasted round trip.
    if (this.running) {
      this.queued = fn;
      return;
    }
    this.running = true;
    try {
      let next: (() => Promise<void>) | null = fn;
      while (next) {
        this.queued = null;
        await next();
        next = this.queued;
      }
    } finally {
      this.queued = null;
      this.running = false;
    }
  }
}

/** The most-repeated expression in the codebase, in one place. */
export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
