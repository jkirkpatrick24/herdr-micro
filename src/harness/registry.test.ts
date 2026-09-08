import assert from 'node:assert/strict';
import { test } from 'vitest';

import { claude } from './claude.js';
import { generic, harnessFor } from './registry.js';

test('a known kind resolves to its own adapter', () => {
  assert.equal(harnessFor('claude'), claude);
});

test('an unrecognised or absent kind resolves to the inert generic harness', () => {
  for (const kind of ['omp', 'pi', 'codex', '', null, undefined]) {
    assert.equal(harnessFor(kind), generic, `${String(kind)} must not borrow another vocabulary`);
  }
});

test('the generic harness has no controls, so every key declines', () => {
  assert.deepEqual(generic.controls, []);
});

test('claude carries its own ring colour and the generic harness does not', () => {
  assert.match(claude.ring ?? '', /^#[0-9A-Fa-f]{6}$/);
  assert.equal(generic.ring, undefined);
});
