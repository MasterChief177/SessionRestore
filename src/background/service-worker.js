// Background service worker: listens for tab changes, debounces them into snapshots, and
// answers requests from the popup and the snapshot browser.
//
// MV3 rules this follows:
// - The worker can be killed at any time, so nothing important lives in memory. The debounce
//   timer is the only in-memory state; losing it just means the next event re-arms it.
// - A short setTimeout is fine because the triggering events keep the worker alive.
// - Every listener is registered synchronously at the top level.

import { DEFAULT_SETTINGS, SETTINGS_KEY, getSettings, normalizeSettings } from '../lib/settings.js';
import { makeSnapshot, summarize } from '../lib/model.js';
import { restoreSnapshot } from '../lib/restore.js';
import { captureWindows } from './snapshot.js';
import { maybeCompact } from './compaction.js';
import { getSessionInfo } from './session.js';
import * as db from './db.js';

// If events never stop (a page retitling itself every second), still write at least this often.
const MAX_WAIT_MS = 10_000;

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

let debounceMs = DEFAULT_SETTINGS.debounceMs;
let timer = null;
let firstEventAt = 0;
let pendingKind = 'auto';

getSettings().then(
  (settings) => {
    debounceMs = settings.debounceMs;
  },
  () => {},
);

function scheduleSnapshot(kind = 'auto') {
  if (kind === 'startup') pendingKind = 'startup';
  const now = Date.now();
  if (timer === null) firstEventAt = now;
  else clearTimeout(timer);
  const delay = Math.max(0, Math.min(debounceMs, firstEventAt + MAX_WAIT_MS - now));
  timer = setTimeout(flush, delay);
}

function flush() {
  const kind = pendingKind;
  timer = null;
  pendingKind = 'auto';
  enqueue(() => recordSnapshot({ kind })).catch((error) => console.error('Snapshot failed', error));
}

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
