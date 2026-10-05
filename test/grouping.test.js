import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupByWindow, nearestMark } from '../src/lib/grouping.js';
import { normalizeSettings } from '../src/lib/settings.js';

const at = (h, m, s = 0) => new Date(2026, 9, 5, h, m, s).getTime();

test('snapshots join the closest mark, decided by the seconds', () => {
  assert.equal(nearestMark(at(15, 42, 29), 5), at(15, 40));
  assert.equal(nearestMark(at(15, 42, 31), 5), at(15, 45));
  assert.equal(nearestMark(at(15, 42, 30), 5), at(15, 45)); // exact tie goes to the later mark
  assert.equal(nearestMark(at(15, 44, 59), 10), at(15, 40));
  assert.equal(nearestMark(at(15, 45, 0), 10), at(15, 50));
  assert.equal(nearestMark(at(15, 40, 0), 5), at(15, 40));
});

test('1-minute windows round to the nearest minute', () => {
  assert.equal(nearestMark(at(9, 7, 29), 1), at(9, 7));
  assert.equal(nearestMark(at(9, 7, 31), 1), at(9, 8));
});

test('marks are counted from local midnight, so they line up with the clock', () => {
  assert.equal(nearestMark(at(0, 3, 0), 7), at(0, 0));
  assert.equal(nearestMark(at(0, 4, 0), 7), at(0, 7));
  assert.equal(nearestMark(at(23, 58, 0), 5), at(24, 0)); // closest mark is midnight
});

test('groups newest-first snapshots into windows, keeping order', () => {
  let id = 0;
  const snap = (h, m, s) => ({ id: ++id, createdAt: at(h, m, s) });
  // The list arrives newest first, like the database returns it.
  const list = [snap(15, 47, 10), snap(15, 45, 30), snap(15, 44, 0), snap(15, 42, 40), snap(15, 42, 20), snap(15, 38, 0)];
  const groups = groupByWindow(list, 5);
  assert.deepEqual(
    groups.map((g) => [new Date(g.mark).getMinutes(), g.items.map((s) => s.id)]),
    [
      [45, [1, 2, 3, 4]], // 15:47:10, 15:45:30, 15:44:00, 15:42:40
      [40, [5, 6]], // 15:42:20, 15:38:00
    ],
  );
  // 10-minute marks: 15:47:10 and 15:45:30 are closer to 15:50; 15:44:00 is 4 min from 15:40.
  assert.deepEqual(groupByWindow(list, 10).map((g) => g.items.length), [2, 4]);
  assert.deepEqual(groupByWindow([], 5), []);
});

test('the window size setting defaults to 5 and never goes below 1 minute', () => {
  assert.equal(normalizeSettings({}).groupMinutes, 5);
  assert.equal(normalizeSettings({ groupMinutes: 0 }).groupMinutes, 1);
  assert.equal(normalizeSettings({ groupMinutes: 10 }).groupMinutes, 10);
  assert.equal(normalizeSettings({ groupMinutes: 500 }).groupMinutes, 60);
});
