import assert from 'node:assert/strict';
import { test } from 'vitest';

import { asArray, isArray, isOneOf, isRecord, str } from './json.js';

test('a table is told apart from an array and from null', () => {
  // The array case is the one that matters: `typeof [] === 'object'`, so the
  // obvious check admits an array everywhere a TOML table or a JSON object is
  // expected, and every field read off it then comes back undefined.
  assert.ok(isRecord({ a: 1 }));
  assert.ok(!isRecord([]));
  assert.ok(!isRecord(null));
  assert.ok(!isRecord('table'));
});

test('an array narrows to unknown elements rather than to any', () => {
  assert.ok(isArray([1, 'two']));
  assert.ok(!isArray({ length: 2 }));

  // Absent becomes empty so callers can iterate without branching first.
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray({}), []);
  assert.deepEqual(asArray([1]), [1]);
});

test('membership holds for the allowed strings and nothing else', () => {
  const allowed = ['up', 'down'] as const;
  assert.ok(isOneOf(allowed, 'up'));
  assert.ok(!isOneOf(allowed, 'sideways'));
  // Not a string at all: the guard must not reach `includes` and match a
  // coerced value.
  assert.ok(!isOneOf(allowed, 0));
  assert.ok(!isOneOf(allowed, null));
});

test('a non-string field reads back as absent, never as an empty string', () => {
  assert.equal(str('w1'), 'w1');
  assert.equal(str(7), undefined);
  assert.equal(str(undefined), undefined);
});
