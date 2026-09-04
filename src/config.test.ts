import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_CONFIG, loadConfig } from './config.js';
import { silentLogger } from './testing/fixtures.js';

function withConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hm-cfg-'));
  const p = join(dir, 'config.toml');
  writeFileSync(p, body);
  return p;
}

test('a missing file yields defaults', async () => {
  const cfg = await loadConfig(silentLogger, '/nonexistent/nope.toml');
  assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test('malformed TOML yields defaults', async (t) => {
  const p = withConfig('this is [not valid');
  t.after(() => rmSync(p, { force: true }));
  assert.deepEqual(await loadConfig(silentLogger, p), DEFAULT_CONFIG);
});

test('invalid values fall back per key without rejecting the file', async (t) => {
  const cases: Array<[string, (c: Awaited<ReturnType<typeof loadConfig>>) => unknown, unknown]> = [
    [
      '[gestures]\ntap_max_ms = "400"',
      (c) => c.gestures.tapMaxMs,
      DEFAULT_CONFIG.gestures.tapMaxMs,
    ],
    ['[gestures]\ntap_max_ms = -1', (c) => c.gestures.tapMaxMs, DEFAULT_CONFIG.gestures.tapMaxMs],
    ['[gestures]\nhold_ms = 0', (c) => c.gestures.holdMs, DEFAULT_CONFIG.gestures.holdMs],
    ['[colors]\nidle = "red"', (c) => c.colors.idle, DEFAULT_CONFIG.colors.idle],
    ['[colors]\ndone = "#FFF"', (c) => c.colors.done, DEFAULT_CONFIG.colors.done],
    ['[metrics]\nenabled = "yes"', (c) => c.metricsEnabled, DEFAULT_CONFIG.metricsEnabled],
  ];
  for (const [body, pick, expected] of cases) {
    const p = withConfig(body);
    t.after(() => rmSync(p, { force: true }));
    assert.equal(pick(await loadConfig(silentLogger, p)), expected, body);
  }
});

test('valid values are honoured', async (t) => {
  const p = withConfig(
    '[gestures]\nhold_ms = 750\n\n[colors]\nblocked = "#ABCDEF"\n\n[metrics]\nenabled = false\n',
  );
  t.after(() => rmSync(p, { force: true }));
  const cfg = await loadConfig(silentLogger, p);
  assert.equal(cfg.gestures.holdMs, 750);
  assert.equal(cfg.colors.blocked, '#ABCDEF');
  assert.equal(cfg.metricsEnabled, false, 'metrics.enabled must actually be readable');
});
