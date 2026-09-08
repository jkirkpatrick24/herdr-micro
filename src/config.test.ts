import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { DEFAULT_CONFIG, loadConfig } from './config.js';
import type { Logger } from './log.js';
import { silentLogger } from './testing/fixtures.js';

/** Records warnings so a test can assert a fallback was announced, not just taken. */
function capturingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info() {}, warn: (msg) => void warnings.push(msg), error() {} };
}

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
    ['[underglow]\ncolor = "nope"', (c) => c.underglow.color, DEFAULT_CONFIG.underglow.color],
    [
      '[underglow]\nbrightness = 4',
      (c) => c.underglow.brightness,
      DEFAULT_CONFIG.underglow.brightness,
    ],
    [
      '[underglow.dial]\nagents = "#GG0000"',
      (c) => c.underglow.dial.agents,
      DEFAULT_CONFIG.underglow.dial.agents,
    ],
  ];
  for (const [body, pick, expected] of cases) {
    const p = withConfig(body);
    t.onTestFinished(() => rmSync(p, { force: true }));
    assert.equal(pick(await loadConfig(silentLogger, p)), expected, body);
  }
});

test('a disabled harness leaves no dead detent on the dial', async (t) => {
  const p = withConfig('[harness]\nenabled = false\n');
  t.onTestFinished(() => rmSync(p, { force: true }));

  const cfg = await loadConfig(silentLogger, p);
  // `enabled = false` is meant to read as "this never shipped", and a mode that
  // cycles to nothing is the most visible way to break that.
  assert.ok(!cfg.controls.dialModeOrder.includes('harness'));
  assert.deepEqual(cfg.controls.dialModeOrder, ['workspaces', 'agents']);
});

test('a dial order of only harness still leaves the dial somewhere to go', async (t) => {
  const p = withConfig('[controls]\ndial_mode_order = ["harness"]\n\n[harness]\nenabled = false\n');
  t.onTestFinished(() => rmSync(p, { force: true }));

  const log = capturingLogger();
  const cfg = await loadConfig(log, p);
  assert.deepEqual(cfg.controls.dialModeOrder, ['workspaces', 'agents']);
  // The order is well formed and the layer is off; only together are they
  // contradictory, so this is the one fallback that has to announce itself.
  assert.ok(log.warnings.some((w) => w.includes('dial_mode_order names only harness')));
});

test('a partial dial order is a choice, not a typo', async (t) => {
  const p = withConfig('[controls]\ndial_mode_order = ["agents", "harness"]\n');
  t.onTestFinished(() => rmSync(p, { force: true }));

  // It used to demand every mode exactly once. With `harness` optional, an
  // order that omits modes is something a user can mean.
  const cfg = await loadConfig(silentLogger, p);
  assert.deepEqual(cfg.controls.dialModeOrder, ['agents', 'harness']);
});

test('an empty dial order is rejected, not honoured', async (t) => {
  const p = withConfig('[controls]\ndial_mode_order = []\n');
  t.onTestFinished(() => rmSync(p, { force: true }));

  // Honouring it would leave the dial with nothing to cycle to: `handleDial`
  // computes the next index modulo the length, and modulo zero is NaN.
  const cfg = await loadConfig(silentLogger, p);
  assert.deepEqual(cfg.controls.dialModeOrder, DEFAULT_CONFIG.controls.dialModeOrder);
});

test('a dial order with a repeat is still rejected', async (t) => {
  const p = withConfig('[controls]\ndial_mode_order = ["agents", "agents", "harness"]\n');
  t.onTestFinished(() => rmSync(p, { force: true }));

  const cfg = await loadConfig(silentLogger, p);
  assert.deepEqual(cfg.controls.dialModeOrder, DEFAULT_CONFIG.controls.dialModeOrder);
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
    '[controls]\ndial_mode_order = ["harness", "agents", "workspaces"]\n\n[controls.bindings]\nACT06 = "none"\nACT12 = "escape"\n\n[controls.joystick]\nleft = "none"\n',
  );
  t.onTestFinished(() => rmSync(p, { force: true }));
  const cfg = await loadConfig(silentLogger, p);
  assert.deepEqual(cfg.controls.dialModeOrder, ['harness', 'agents', 'workspaces']);
  assert.equal(cfg.controls.buttons.ACT06, 'none');
  assert.equal(cfg.controls.buttons.ACT12, 'escape');
  assert.equal(cfg.controls.joystick.left, 'none');
  assert.equal(cfg.controls.joystick.right, 'pane');
});

test('underglow colours are configurable per dial mode', async (t) => {
  const p = withConfig(
    ['[underglow]', 'brightness = 0.75', '', '[underglow.dial]', 'workspaces = "#112233"'].join(
      '\n',
    ),
  );
  t.onTestFinished(() => rmSync(p, { force: true }));

  const cfg = await loadConfig(silentLogger, p);

  assert.equal(cfg.underglow.brightness, 0.75);
  assert.equal(cfg.underglow.dial.workspaces, '#112233');
  // An unset mode keeps its default rather than going dark with its neighbour.
  assert.equal(cfg.underglow.dial.agents, DEFAULT_CONFIG.underglow.dial.agents);
  assert.equal(cfg.underglow.color, null);
});

test('a static underglow colour is read as one colour for every mode', async (t) => {
  const p = withConfig('[underglow]\ncolor = "#FF6600"');
  t.onTestFinished(() => rmSync(p, { force: true }));

  assert.equal((await loadConfig(silentLogger, p)).underglow.color, '#FF6600');
});
