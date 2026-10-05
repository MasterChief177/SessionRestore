// A "session" is one run of the browser. chrome.storage.session is wiped when the browser
// exits (or crashes), so finding no id there means a new session has started.
//
// When a session id is created we also remember the newest snapshot that existed at that
// moment: that's the final state of the previous session, i.e. what "Restore last session"
// should bring back after a crash.

import { findLatestSnapshot } from './db.js';

const KEY = 'session';

let cached = null;

async function loadOrCreate() {
  const { [KEY]: existing } = await chrome.storage.session.get(KEY);
  if (existing?.id) return existing;

  const previous = await findLatestSnapshot((s) => s.session != null);
  const info = { id: crypto.randomUUID(), previousSnapshotId: previous?.id ?? null, startedAt: Date.now() };
  await chrome.storage.session.set({ [KEY]: info });
  return info;
}

/** { id, previousSnapshotId, startedAt } for the current browser session. */
export function getSessionInfo() {
  cached ??= loadOrCreate().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}
