import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

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
  t.onTestFinished(() => rmSync(p, { force: true }));
  assert.deepEqual(await loadConfig(silentLogger, p), DEFAULT_CONFIG);
});

test('invalid values fall back per key without rejecting the file', async (t) => {
  const cases: Array<[string, (c: Awaited<ReturnType<typeof loadConfig>>) => unknown, unknown]> = [
    ['[colors]\nidle = "red"', (c) => c.colors.idle, DEFAULT_CONFIG.colors.idle],
    ['[colors]\ndone = "#FFF"', (c) => c.colors.done, DEFAULT_CONFIG.colors.done],
    ['[metrics]\nenabled = "yes"', (c) => c.metricsEnabled, DEFAULT_CONFIG.metricsEnabled],
  ];
  for (const [body, pick, expected] of cases) {
    const p = withConfig(body);
    t.onTestFinished(() => rmSync(p, { force: true }));
    assert.equal(pick(await loadConfig(silentLogger, p)), expected, body);
  }
});

test('valid values are honoured', async (t) => {
  const p = withConfig('[colors]\nblocked = "#ABCDEF"\n\n[metrics]\nenabled = false\n');
  t.onTestFinished(() => rmSync(p, { force: true }));
  const cfg = await loadConfig(silentLogger, p);
  assert.equal(cfg.colors.blocked, '#ABCDEF');
  assert.equal(cfg.metricsEnabled, false, 'metrics.enabled must actually be readable');
});

test('control settings are configurable', async (t) => {
  const p = withConfig(
    '[controls]\nscroll_steps = 3\ndial_mode_order = ["scroll", "agents", "workspaces"]\n\n[controls.bindings]\nACT06 = "none"\nACT12 = "escape"\n\n[controls.joystick]\nleft = "none"\n',
  );
  t.onTestFinished(() => rmSync(p, { force: true }));
  const cfg = await loadConfig(silentLogger, p);
  assert.equal(cfg.controls.scrollSteps, 3);
  assert.deepEqual(cfg.controls.dialModeOrder, ['scroll', 'agents', 'workspaces']);
  assert.equal(cfg.controls.buttons.ACT06, 'none');
  assert.equal(cfg.controls.buttons.ACT12, 'escape');
  assert.equal(cfg.controls.joystick.left, 'none');
  assert.equal(cfg.controls.joystick.right, 'pane');
});
