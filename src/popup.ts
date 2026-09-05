import { HerdrClient } from './herdr/client.js';
import { type Logger, reason } from './log.js';
import { createPopupSession } from './popup-session.js';
import { Store } from './state/store.js';
import { wireClientToStore } from './wiring.js';

// ---------------------------------------------------------------------------
// Entry point: wiring only. The session's behaviour lives in popup-session.ts,
// where it can be tested without a terminal to borrow or a process to exit.
// ---------------------------------------------------------------------------

const log: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
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
  process.stderr.write(`popup connection failed: ${reason(error)}\n`);
}
