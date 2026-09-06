import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { makeLogger } from './daemon.js';
import { HerdrClient } from './herdr/client.js';
import { reason } from './log.js';
import { createPopupSession } from './popup-session.js';
import { Store } from './state/store.js';
import { wireClientToStore } from './wiring.js';

// ---------------------------------------------------------------------------
// Entry point: wiring only. The session's behaviour lives in popup-session.ts,
// where it can be tested without a terminal to borrow or a process to exit.
// ---------------------------------------------------------------------------

export const POPUP_LOG_PATH = join(homedir(), '.local', 'state', 'herdr-micro', 'popup.log');

/**
 * Diagnostics go to a file, because the popup owns the alternate screen and
 * anything written to stdout or stderr lands on top of the panel.
 *
 * They previously went nowhere at all: this was three no-op methods, and the
 * catch around `client.start()` below could not fire to make up for it, so a
 * popup that could not reach herdr rendered six empty rows and said nothing
 * anywhere. Writes are fire-and-forget -- a popup that cannot log is still a
 * popup, and there is no second channel to report the failure on.
 */
let logDir: Promise<unknown> | null = null;
let writes: Promise<unknown> = Promise.resolve();

const log = makeLogger((line) => {
  logDir ??= mkdir(dirname(POPUP_LOG_PATH), { recursive: true });
  // Chained rather than fired off in parallel: concurrent appendFile calls
  // complete in nondeterministic order, and this log is read to find out what
  // happened first. Unchained it already reordered its own opening lines,
  // filing `socket resolved` after the first `connect failed` it caused.
  writes = writes
    .then(() => logDir)
    .then(() => appendFile(POPUP_LOG_PATH, line, 'utf8'))
    .catch(() => {});
});

const store = new Store(log);
const client = new HerdrClient(log);
const session = createPopupSession(store, client, {
  stdout: process.stdout,
  stdin: process.stdin,
  exit: () => process.exit(0),
});

store.on('changed', session.render);
wireClientToStore(client, store);

session.enter();
if (process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on('data', session.onKey);
}
process.on('SIGINT', session.quit);
process.on('SIGTERM', session.quit);
process.stdout.on('resize', () => session.render());
session.render();

try {
  await client.start();
} catch (error) {
  // A safety net, not the diagnostic path: start() resolves as soon as the
  // socket is resolved, and every connection failure after that is reported by
  // connectLoop through `log` above. Kept because an unhandled rejection here
  // would tear the process down while it still holds the alternate screen,
  // leaving the user's terminal in raw mode with no cursor.
  log.error('popup connection failed', { reason: reason(error) });
}
