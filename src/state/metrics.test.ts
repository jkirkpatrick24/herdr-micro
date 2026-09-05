import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import type { Logger } from '../log.js';
import { silentLogger } from '../testing/fixtures.js';
import { Metrics } from './metrics.js';

test('a transition is appended as one parseable NDJSON line', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-metrics-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'metrics.jsonl');

  const m = new Metrics(silentLogger, p);
  m.record({
    paneId: 'w1:p1',
    label: 'fix-auth/claude',
    from: 'working',
    to: 'blocked',
    durationMs: 42,
  });
  // Writes are fire-and-forget, and the file appears before its contents do,
  // so poll for actual content rather than racing a fixed delay.
  const read = () => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  for (let i = 0; i < 200 && read().trim() === ''; i++) await delay(5);

  const lines = readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]!);
  assert.equal(row.pane_id, 'w1:p1');
  assert.equal(row.duration_ms, 42);
  assert.equal(row.to, 'blocked');
});

test('a write failure disables metrics and is reported once, not per record', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-metrics-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  // A regular file where the metrics directory should be, so the mkdir behind
  // the first write fails and keeps failing.
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, '');

  const warnings: string[] = [];
  const log: Logger = { info() {}, warn: (m) => void warnings.push(m), error() {} };
  const m = new Metrics(log, join(blocker, 'metrics.jsonl'));

  const record = () =>
    m.record({ paneId: 'w1:p1', label: 'x', from: 'idle', to: 'working', durationMs: 1 });

  // Writes are fire-and-forget, so the only way a failure surfaces at all is
  // this warning -- and the only way it takes the daemon down is as an
  // unhandled rejection, which vitest fails the run on.
  record();
  for (let i = 0; i < 200 && warnings.length === 0; i++) await delay(5);
  assert.deepEqual(warnings, ['metrics disabled after write failure']);

  // A transition can fire many times a minute. Retrying a path already known to
  // be broken would spend a syscall and a log line on each one.
  for (let i = 0; i < 5; i++) record();
  await delay(50);
  assert.deepEqual(warnings, ['metrics disabled after write failure'], 'disabled means disabled');
});

test('metrics disabled writes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-metrics-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'metrics.jsonl');

  const m = new Metrics(silentLogger, p, false);
  m.record({ paneId: 'w1:p1', label: 'x', from: 'idle', to: 'working', durationMs: 1 });
  await delay(50);
  assert.throws(() => readFileSync(p, 'utf8'));
});
