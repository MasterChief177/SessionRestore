// Background service worker: listens for tab changes, debounces them into snapshots, and
// answers requests from the popup and the snapshot browser.
//
// MV3 rules this follows:
// - The worker can be killed at any time, so nothing important lives in memory. The debounce
//   timer is the only in-memory state, and long waits back it up with an alarm (see below).
// - A short setTimeout is fine because the triggering events keep the worker alive.
// - Every listener is registered synchronously at the top level.

import { DEFAULT_SETTINGS, SETTINGS_KEY, getSettings, normalizeSettings } from '../lib/settings.js';
import { snapshotDelay } from '../lib/debounce.js';
import { makeSnapshot, summarize } from '../lib/model.js';
import { restoreSnapshot } from '../lib/restore.js';
import { captureWindows } from './snapshot.js';
import { maybeCompact } from './compaction.js';
import { getSessionInfo } from './session.js';
import * as db from './db.js';

// ---------------------------------------------------------------------------
// Serialized work queue: snapshot writes and compaction never overlap, so the
// "compare with the latest snapshot, then write" step can't race with itself.

let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Debounce
//
// Chrome stops a worker after about 30 idle seconds and its timers go with it, so with a debounce
// longer than ALARM_AFTER_MS every wait also arms an alarm that wakes the worker up to write the
// snapshot. The alarm name carries the snapshot kind, because pendingKind doesn't survive the worker.

const ALARMS = { auto: 'snapshot', startup: 'startup-snapshot' };
const ALARM_AFTER_MS = 20_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout fires at once for anything longer

let debounceMs = DEFAULT_SETTINGS.debounceMs;
let pending = false;
let timer = null;
let firstEventAt = 0;
let pendingKind = 'auto';

// A freshly woken worker must not debounce its first event with the default delay.
const settingsLoaded = getSettings().then(
  (settings) => {
    debounceMs = settings.debounceMs;
  },
  () => {},
);

function scheduleSnapshot(kind = 'auto') {
  settingsLoaded.then(() => {
    if (kind === 'startup') pendingKind = 'startup';
    const now = Date.now();
    if (!pending) firstEventAt = now;
    pending = true;
    clearTimeout(timer);
    const delay = snapshotDelay(debounceMs, firstEventAt, now);
    timer = delay <= MAX_TIMEOUT_MS ? setTimeout(flush, delay) : null;
    if (debounceMs > ALARM_AFTER_MS) {
      if (pendingKind === 'startup') chrome.alarms.clear(ALARMS.auto);
      chrome.alarms.create(ALARMS[pendingKind], { when: now + delay });
    }
  });
}

function flush(kind = pendingKind) {
  clearTimeout(timer);
  timer = null;
  pending = false;
  pendingKind = 'auto';
  chrome.alarms.clearAll();
  enqueue(() => recordSnapshot({ kind })).catch((error) => console.error('Snapshot failed', error));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.startup) flush('startup');
  else if (alarm.name === ALARMS.auto) flush();
});

// ---------------------------------------------------------------------------
// Recording

/**
 * Capture the current state and store it.
 * - manual: always written.
 * - auto/startup: skipped if identical to the latest snapshot; if only titles/active tab/group
 *   names changed and the latest snapshot is an automatic one from this session, that one is
 *   updated in place instead of adding a near-duplicate.
 */
async function recordSnapshot({ kind, label = null }) {
  const [settings, session] = await Promise.all([getSettings(), getSessionInfo()]);
  const windows = await captureWindows(settings);
  const now = Date.now();
  const snapshot = await makeSnapshot({ windows, kind, label, session: session.id, createdAt: now });

  if (kind !== 'manual') {
    // All windows closed (or everything ignored): nothing worth recovering.
    if (!snapshot.tabCount) return { skipped: 'empty' };

    const latest = await db.getLatestSnapshot();
    if (latest) {
      const sameSession = latest.session === session.id;
      if (latest.hash === snapshot.hash && (kind === 'auto' || sameSession)) {
        return { skipped: 'unchanged', id: latest.id };
      }
      if (sameSession && latest.kind !== 'manual' && latest.structureHash === snapshot.structureHash) {
        await db.putSnapshot({
          ...snapshot,
          id: latest.id,
          kind: latest.kind,
          label: latest.label,
          createdAt: latest.createdAt,
          updatedAt: now,
        });
        db.notifySnapshotsChanged();
        return { id: latest.id, updated: true };
      }
    }
  }

  const id = await db.addSnapshot(snapshot);
  db.notifySnapshotsChanged();
  enqueue(() => maybeCompact()).catch((error) => console.error('Compaction failed', error));
  return { id, created: true };
}

// ---------------------------------------------------------------------------
// Event listeners (top level, synchronous)

const onStructureChange = () => scheduleSnapshot();

chrome.tabs.onCreated.addListener(onStructureChange);
chrome.tabs.onRemoved.addListener(onStructureChange);
chrome.tabs.onMoved.addListener(onStructureChange);
chrome.tabs.onAttached.addListener(onStructureChange);
chrome.tabs.onDetached.addListener(onStructureChange);
chrome.tabs.onReplaced.addListener(onStructureChange);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  // onUpdated fires constantly (loading status, favicons, audio...). Only react to what we store.
  if ('url' in changeInfo || 'title' in changeInfo || 'pinned' in changeInfo || 'groupId' in changeInfo) {
    scheduleSnapshot();
  }
});

chrome.windows.onCreated.addListener(onStructureChange);
chrome.windows.onRemoved.addListener(onStructureChange);

if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(onStructureChange);
  chrome.tabGroups.onUpdated.addListener(onStructureChange);
  chrome.tabGroups.onRemoved.addListener(onStructureChange);
  chrome.tabGroups.onMoved.addListener(onStructureChange);
}

function onBrowserStart() {
  scheduleSnapshot('startup');
  enqueue(() => maybeCompact({ force: true })).catch((error) => console.error('Compaction failed', error));
}
chrome.runtime.onStartup.addListener(onBrowserStart);
chrome.runtime.onInstalled.addListener(onBrowserStart);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    debounceMs = normalizeSettings(changes[SETTINGS_KEY].newValue).debounceMs;
  }
});

// ---------------------------------------------------------------------------
// Messages from the popup / snapshot browser / settings page

const handlers = {
  async save({ label }) {
    const trimmed = typeof label === 'string' ? label.trim() : '';
    return enqueue(() => recordSnapshot({ kind: 'manual', label: trimmed || null }));
  },

  async restore({ id, windowIndex = null, tabIndex = null }) {
    const [snapshot, settings] = await Promise.all([db.getSnapshot(id), getSettings()]);
    if (!snapshot) throw new Error('That snapshot no longer exists.');
    return restoreSnapshot(snapshot, { windowIndex, tabIndex, lazy: settings.lazyRestore });
  },

  /** The final snapshot of the previous browser session, for "Restore last session". */
  async lastSession() {
    const session = await getSessionInfo();
    if (session.previousSnapshotId == null) return null;
    const [previous, current] = await Promise.all([
      db.getSnapshot(session.previousSnapshotId),
      db.findLatestSnapshot((s) => s.session === session.id),
    ]);
    if (!previous) return null;
    return {
      snapshot: summarize(previous),
      // True when the browser already brought everything back by itself.
      matchesCurrent: !!current && current.structureHash === previous.structureHash,
    };
  },

  async compact() {
    return enqueue(() => maybeCompact({ force: true }));
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = message && Object.hasOwn(handlers, message.type) ? handlers[message.type] : null;
  if (!handler) return false;
  handler(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error?.message ?? String(error) }),
  );
  return true; // keep the channel open for the async response
});
