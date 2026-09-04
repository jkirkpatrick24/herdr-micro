import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { silentLogger } from '../testing/fixtures.js';
import { Metrics } from './metrics.js';

test('a transition is appended as one parseable NDJSON line', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-metrics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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

test('metrics disabled writes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-metrics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'metrics.jsonl');

  const m = new Metrics(silentLogger, p, false);
  m.record({ paneId: 'w1:p1', label: 'x', from: 'idle', to: 'working', durationMs: 1 });
  await delay(50);
  assert.throws(() => readFileSync(p, 'utf8'));
});
