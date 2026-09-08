import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { DEFAULT_CONFIG, loadConfig } from '../config.js';
import { silentLogger } from '../testing/fixtures.js';

type Loaded = Awaited<ReturnType<typeof loadConfig>>;

function withConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hm-harness-'));
  const path = join(dir, 'config.toml');
  writeFileSync(path, body);
  return path;
}

const DEFAULTS = DEFAULT_CONFIG.harness;

test('the harness section defaults when the file says nothing about it', async () => {
  const path = withConfig('[colors]\nidle = "#101010"\n');
  const config = await loadConfig(silentLogger, path);
  rmSync(path, { force: true });

  assert.deepEqual(config.harness, DEFAULTS);
});

test('valid harness values are honoured', async (t) => {
  const cases: Array<[string, (c: Loaded) => unknown, unknown]> = [
    ['[harness]\nenabled = false', (c) => c.harness.enabled, false],
    ['[harness.underglow]\nactive = "#123456"', (c) => c.harness.underglow.active, '#123456'],
  ];

  for (const [body, read, expected] of cases) {
    const path = withConfig(body);
    t.onTestFinished(() => rmSync(path, { force: true }));
    assert.deepEqual(read(await loadConfig(silentLogger, path)), expected, body);
  }
});

test('invalid harness values fall back per key without rejecting the file', async (t) => {
  const cases: Array<[string, (c: Loaded) => unknown, unknown]> = [
    ['[harness]\nenabled = "yes"', (c) => c.harness.enabled, DEFAULTS.enabled],
    [
      '[harness.underglow]\nactive = "orange"',
      (c) => c.harness.underglow.active,
      DEFAULTS.underglow.active,
    ],
  ];

  for (const [body, read, expected] of cases) {
    const path = withConfig(body);
    t.onTestFinished(() => rmSync(path, { force: true }));
    assert.deepEqual(read(await loadConfig(silentLogger, path)), expected, body);
  }
});

test('a bad harness value does not cost the rest of the file', async (t) => {
  const path = withConfig('[colors]\nidle = "#101010"\n\n[harness]\nenabled = 7\n');
  t.onTestFinished(() => rmSync(path, { force: true }));

  const config = await loadConfig(silentLogger, path);
  assert.equal(config.colors.idle, '#101010');
  assert.equal(config.harness.enabled, DEFAULTS.enabled);
});
