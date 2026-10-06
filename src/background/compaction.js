// Retention rules for automatic snapshots. There are two modes.
//
// Smart thinning ('thin'):
//   younger than keepAllHours    keep everything
//   younger than hourlyDays      keep the newest snapshot of each hour
//   younger than dailyDays       keep the newest snapshot of each day
//   older                        delete
// Within dailyDays the last snapshot of each browser session is kept too, because that is
// exactly the state you want after a crash. maxSnapshots caps the total as a safety net.
//
// Keep everything ('everything'):
//   younger than everythingDays  keep everything, but at most everythingMax (the oldest go first)
//   older                        delete
//
// In both modes, manual snapshots and the newest snapshot overall are never deleted.

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
  const { keepAllHours, hourlyDays, dailyDays, everythingDays } = settings;
  const everything = settings.retentionMode === 'everything';
  const cap = everything ? settings.everythingMax : settings.maxSnapshots;
  const newestFirst = [...entries].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const latestId = newestFirst[0]?.id;

  const doomed = [];
  const kept = []; // automatic snapshots we keep, newest first (for the cap)
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
    if (everything) {
      keep = age < everythingDays * DAY;
    } else if (age < keepAllHours * HOUR) {
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

  if (kept.length > cap) {
    doomed.push(...kept.slice(cap).map((entry) => entry.id));
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
