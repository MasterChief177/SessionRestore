import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_WAIT_MS, snapshotDelay } from '../src/lib/debounce.js';

test('waits the debounce after the latest event', () => {
  assert.equal(snapshotDelay(1500, 0, 0), 1500);
  assert.equal(snapshotDelay(1500, 0, 4000), 1500);
  assert.equal(snapshotDelay(90_000, 0, 30_000), 90_000);
});

test('busy tabs still get a snapshot every 10 seconds with a short debounce', () => {
  assert.equal(snapshotDelay(1500, 0, MAX_WAIT_MS - 500), 500);
  assert.equal(snapshotDelay(1500, 0, MAX_WAIT_MS + 3000), 0);
});

test('a long debounce stretches the max wait to two debounce periods', () => {
  // With a 60 s debounce, a burst that keeps going is written 2 minutes after it started,
  // not cut short at 10 seconds.
  assert.equal(snapshotDelay(60_000, 0, 9_000), 60_000);
  assert.equal(snapshotDelay(60_000, 0, 100_000), 20_000);
  assert.equal(snapshotDelay(60_000, 0, 130_000), 0);
});
