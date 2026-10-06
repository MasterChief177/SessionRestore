import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planCompaction } from '../src/background/compaction.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Midday, so hour/day buckets in the tests don't straddle midnight in any timezone offset.
const now = new Date(2026, 9, 5, 12, 0).getTime();

let nextId = 1;
const entry = (ageMs, kind = 'auto', session = 's-current') => ({ id: nextId++, createdAt: now - ageMs, kind, session });

test('keeps everything younger than keepAllHours', () => {
  const entries = [entry(1 * MIN), entry(2 * MIN), entry(3 * MIN), entry(23 * HOUR)];
  assert.deepEqual(planCompaction(entries, DEFAULT_SETTINGS, now), []);
});

test('keeps the newest snapshot per hour between 1 and 7 days', () => {
  const base = 2 * DAY + 30 * MIN; // inside a single clock hour two days ago
  const newest = entry(base);
  const older = entry(base + 5 * MIN);
  const oldest = entry(base + 10 * MIN);
  const latest = entry(1 * MIN);
  const doomed = planCompaction([oldest, newest, latest, older], DEFAULT_SETTINGS, now);
  assert.deepEqual(doomed.sort(), [older.id, oldest.id].sort());
});

test('keeps the newest snapshot per day between 7 and 90 days, deletes older', () => {
  const dayAgo10Late = entry(10 * DAY - 2 * HOUR);
  const dayAgo10Early = entry(10 * DAY + 1 * HOUR);
  const ancient = entry(120 * DAY);
  const latest = entry(1 * MIN);
  const doomed = planCompaction([dayAgo10Early, dayAgo10Late, ancient, latest], DEFAULT_SETTINGS, now);
  assert.deepEqual(doomed.sort(), [dayAgo10Early.id, ancient.id].sort());
});

test('never deletes manual snapshots or the latest snapshot, even when ancient', () => {
  const manual = entry(500 * DAY, 'manual');
  const latest = entry(300 * DAY); // nothing newer exists, e.g. the extension sat unused for months
  const older = entry(350 * DAY);
  const doomed = planCompaction([manual, latest, older], DEFAULT_SETTINGS, now);
  assert.deepEqual(doomed, [older.id]);
});

test('keeps the final snapshot of each browser session within the daily tier', () => {
  // Two sessions within the same clock hour three days ago: normally only the newest survives.
  const base = 3 * DAY + 20 * MIN;
  const crashedSessionFinal = entry(base + 10 * MIN, 'auto', 's-old');
  const crashedSessionEarlier = entry(base + 15 * MIN, 'auto', 's-old');
  const nextSession = entry(base, 'auto', 's-next');
  const latest = entry(1 * MIN, 'auto', 's-current');
  const doomed = planCompaction([crashedSessionFinal, crashedSessionEarlier, nextSession, latest], DEFAULT_SETTINGS, now);
  assert.deepEqual(doomed, [crashedSessionEarlier.id]);
});

test('hard cap trims the oldest automatic snapshots only', () => {
  const settings = { ...DEFAULT_SETTINGS, maxSnapshots: 3 };
  const autos = Array.from({ length: 6 }, (_, i) => entry((i + 1) * MIN));
  const manual = entry(30 * MIN, 'manual');
  const doomed = planCompaction([...autos, manual], settings, now);
  assert.deepEqual(doomed.sort(), autos.slice(3).map((e) => e.id).sort());
});

test('keep-everything mode keeps every automatic snapshot younger than everythingDays', () => {
  const settings = { ...DEFAULT_SETTINGS, retentionMode: 'everything', everythingDays: 30 };
  // Same clock hour five days ago: smart thinning would keep only one of these.
  const sameHour = [entry(5 * DAY + 10 * MIN), entry(5 * DAY + 20 * MIN), entry(5 * DAY + 30 * MIN)];
  const tooOld = entry(31 * DAY);
  const manual = entry(400 * DAY, 'manual');
  const latest = entry(1 * MIN);
  const doomed = planCompaction([...sameHour, tooOld, manual, latest], settings, now);
  assert.deepEqual(doomed, [tooOld.id]);
});

test('keep-everything mode drops the oldest once the limit is reached', () => {
  const settings = { ...DEFAULT_SETTINGS, retentionMode: 'everything', everythingMax: 3 };
  const autos = Array.from({ length: 5 }, (_, i) => entry((i + 1) * HOUR));
  const manual = entry(10 * HOUR, 'manual');
  const doomed = planCompaction([...autos, manual], settings, now);
  assert.deepEqual(doomed.sort(), autos.slice(3).map((e) => e.id).sort());
});

test('keep-everything mode never deletes the latest snapshot, even when ancient', () => {
  const settings = { ...DEFAULT_SETTINGS, retentionMode: 'everything', everythingDays: 30 };
  const latest = entry(200 * DAY);
  const older = entry(201 * DAY);
  assert.deepEqual(planCompaction([older, latest], settings, now), [older.id]);
});
