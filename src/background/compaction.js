// Retention rules for automatic snapshots.
//
//   younger than keepAllHours    keep everything
//   younger than hourlyDays      keep the newest snapshot of each hour
//   younger than dailyDays       keep the newest snapshot of each day
//   older                        delete
//
// Never deleted: manual snapshots, the newest snapshot overall, and (within dailyDays) the last
// snapshot of each browser session, because that is exactly the state you want after a crash.
// On top of that, maxSnapshots caps the number of automatic snapshots as a safety net.

import { deleteSnapshots, getSnapshotIndex } from './db.js';
import { getSettings } from '../lib/settings.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LAST_RUN_KEY = 'lastCompactionAt';

const hourKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
};
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * Pure planning step: given { id, createdAt, kind, session } entries, return the ids to delete.
 */
export function planCompaction(entries, settings, now = Date.now()) {
  const { keepAllHours, hourlyDays, dailyDays, maxSnapshots } = settings;
  const newestFirst = [...entries].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const latestId = newestFirst[0]?.id;

  const doomed = [];
  const kept = []; // automatic snapshots we keep, newest first (for the hard cap)
  const seenHours = new Set();
  const seenDays = new Set();
  const seenSessions = new Set();

  for (const entry of newestFirst) {
    const sessionFinal = entry.session != null && !seenSessions.has(entry.session);
    if (entry.session != null) seenSessions.add(entry.session);

    if (entry.kind === 'manual') continue;
    if (entry.id === latestId) {
      kept.push(entry);
      continue;
    }

    const age = now - entry.createdAt;
    let keep;
    if (age < keepAllHours * HOUR) {
      keep = true;
    } else if (age < hourlyDays * DAY) {
      const key = hourKey(entry.createdAt);
      keep = sessionFinal || !seenHours.has(key);
      seenHours.add(key);
    } else if (age < dailyDays * DAY) {
      const key = dayKey(entry.createdAt);
      keep = sessionFinal || !seenDays.has(key);
      seenDays.add(key);
    } else {
      keep = false;
    }

    if (keep) kept.push(entry);
    else doomed.push(entry.id);
  }

  if (kept.length > maxSnapshots) {
    doomed.push(...kept.slice(maxSnapshots).map((entry) => entry.id));
  }
  return doomed;
}

/** Run compaction if it hasn't run in the last hour (or always, with force). */
export async function maybeCompact({ force = false } = {}) {
  const now = Date.now();
  const { [LAST_RUN_KEY]: lastRun = 0 } = await chrome.storage.local.get(LAST_RUN_KEY);
  if (!force && now - lastRun < HOUR && lastRun <= now) return null;
  await chrome.storage.local.set({ [LAST_RUN_KEY]: now });

  const [settings, entries] = await Promise.all([getSettings(), getSnapshotIndex()]);
  const ids = planCompaction(entries, settings, now);
  if (ids.length) await deleteSnapshots(ids);
  return { deleted: ids.length, remaining: entries.length - ids.length };
}
