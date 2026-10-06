// Small user settings, stored in chrome.storage.local under a single key.
// Snapshots themselves live in IndexedDB (see background/db.js).

import { ruleKey } from './ignore.js';

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  // Wait this long after the last tab change before writing a snapshot. No upper limit in the UI.
  debounceMs: 1500,
  // How automatic snapshots are retired. Manual snapshots are never deleted automatically.
  //   'thin'        keep everything, then one per hour, then one per day (the tiers below)
  //   'everything'  keep every snapshot for everythingDays, at most everythingMax of them
  retentionMode: 'thin',
  keepAllHours: 24,
  hourlyDays: 7,
  dailyDays: 90,
  everythingDays: 30,
  everythingMax: 2000,
  // Safety net on the number of automatic snapshots in 'thin' mode (not shown in the UI).
  maxSnapshots: 5000,
  // One rule per entry. `*` is a wildcard over the whole URL, anything else matches as a substring.
  ignoreRules: Object.freeze(['chrome://newtab/', 'about:blank']),
  // Only load the active tab of each restored window; the rest stay unloaded until clicked.
  lazyRestore: true,
  // The snapshot list folds snapshots into windows of this many minutes (display only).
  groupMinutes: 5,
});

function clampInt(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const RETENTION_MODES = Object.freeze(['thin', 'everything']);

// The debounce has no real maximum; this only keeps absurd values inside what timers and dates can hold.
export const MIN_DEBOUNCE_MS = 250;
export const MAX_DEBOUNCE_MS = 365 * 24 * 60 * 60 * 1000;

/** Trimmed, non-empty, without duplicates (rules match case-insensitively), oldest first. */
function normalizeRules(rules) {
  const seen = new Set();
  const out = [];
  for (const rule of rules) {
    if (typeof rule !== 'string') continue;
    const text = rule.trim();
    if (!text || seen.has(ruleKey(text))) continue;
    seen.add(ruleKey(text));
    out.push(text);
  }
  return out.slice(0, 500);
}

export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  const hourlyDays = clampInt(input.hourlyDays, 0, 365, d.hourlyDays);
  return {
    debounceMs: clampInt(input.debounceMs, MIN_DEBOUNCE_MS, MAX_DEBOUNCE_MS, d.debounceMs),
    retentionMode: RETENTION_MODES.includes(input.retentionMode) ? input.retentionMode : d.retentionMode,
    keepAllHours: clampInt(input.keepAllHours, 1, 24 * 30, d.keepAllHours),
    hourlyDays,
    dailyDays: Math.max(hourlyDays, clampInt(input.dailyDays, 1, 3650, d.dailyDays)),
    everythingDays: clampInt(input.everythingDays, 1, 3650, d.everythingDays),
    everythingMax: clampInt(input.everythingMax, 10, 100_000, d.everythingMax),
    maxSnapshots: clampInt(input.maxSnapshots, 100, 100_000, d.maxSnapshots),
    ignoreRules: Array.isArray(input.ignoreRules) ? normalizeRules(input.ignoreRules) : [...d.ignoreRules],
    lazyRestore: typeof input.lazyRestore === 'boolean' ? input.lazyRestore : d.lazyRestore,
    groupMinutes: clampInt(input.groupMinutes, 1, 60, d.groupMinutes),
  };
}

export async function getSettings() {
  const { [SETTINGS_KEY]: stored } = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored);
}

export async function saveSettings(partial) {
  const next = normalizeSettings({ ...(await getSettings()), ...partial });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.remove(SETTINGS_KEY);
  return normalizeSettings(null);
}
