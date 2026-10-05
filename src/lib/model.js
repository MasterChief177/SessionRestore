// Snapshot data model helpers shared by the service worker, import/export and the UI.
// Nothing in here touches chrome.* so it can be unit tested in Node.

export const APP_NAME = 'Tab Snapshot';

export const KINDS = ['auto', 'manual', 'startup'];

// Colors chrome.tabGroups accepts.
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

const WINDOW_STATES = ['normal', 'minimized', 'maximized', 'fullscreen'];
const BOUNDS = ['left', 'top', 'width', 'height'];

export function countTabs(windows) {
  return windows.reduce((sum, win) => sum + win.tabs.length, 0);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Two hashes per snapshot:
 * - structureHash: which URLs are open where (order, pinning, grouping). A change here is a new snapshot.
 * - hash: everything we restore (titles, active tab, focus, group names). If only this changes we
 *   update the latest automatic snapshot in place instead of writing a new one, so pages that keep
 *   changing their title (unread counters etc.) don't flood the history.
 * Window bounds are deliberately left out of both.
 */
export async function computeHashes(windows) {
  const structure = windows.map((win) => ({
    t: win.tabs.map((tab) => [tab.url, tab.pinned ? 1 : 0, tab.groupId ?? -1]),
    g: win.groups.length,
  }));
  const content = windows.map((win) => ({
    f: win.focused ? 1 : 0,
    t: win.tabs.map((tab) => [tab.url, tab.title, tab.pinned ? 1 : 0, tab.active ? 1 : 0, tab.groupId ?? -1]),
    g: win.groups.map((group) => [group.id, group.title, group.color, group.collapsed ? 1 : 0]),
  }));
  const [structureHash, hash] = await Promise.all([
    sha256Hex(JSON.stringify(structure)),
    sha256Hex(JSON.stringify(content)),
  ]);
  return { hash, structureHash };
}

/** Build a snapshot record (without `id`, which IndexedDB assigns). */
export async function makeSnapshot({ windows, kind, label = null, createdAt = Date.now(), session = null }) {
  const { hash, structureHash } = await computeHashes(windows);
  return {
    createdAt,
    kind,
    label: label || null,
    session,
    hash,
    structureHash,
    tabCount: countTabs(windows),
    windowCount: windows.length,
    windows,
  };
}

/** The lightweight fields the UI needs for lists. */
export function summarize(snapshot) {
  if (!snapshot) return null;
  const { id, createdAt, updatedAt, kind, label, tabCount, windowCount } = snapshot;
  return { id, createdAt, updatedAt: updatedAt ?? null, kind, label, tabCount, windowCount };
}

const asString = (value) => (typeof value === 'string' ? value : '');

/**
 * Validate and normalize windows coming from an untrusted source (an imported file).
 * Drops anything malformed, renumbers indexes and group ids, and never throws.
 */
export function sanitizeWindows(input) {
  if (!Array.isArray(input)) return [];
  const windows = [];
  for (const rawWin of input) {
    if (!rawWin || !Array.isArray(rawWin.tabs)) continue;

    const groups = [];
    const groupIds = new Map();
    for (const rawGroup of Array.isArray(rawWin.groups) ? rawWin.groups : []) {
      if (!rawGroup || groupIds.has(rawGroup.id)) continue;
      groupIds.set(rawGroup.id, groups.length);
      groups.push({
        id: groups.length,
        title: asString(rawGroup.title),
        color: GROUP_COLORS.includes(rawGroup.color) ? rawGroup.color : 'grey',
        collapsed: !!rawGroup.collapsed,
      });
    }

    const tabs = [];
    for (const rawTab of rawWin.tabs) {
      if (!rawTab || typeof rawTab.url !== 'string' || !rawTab.url) continue;
      const pinned = !!rawTab.pinned;
      // Chrome doesn't allow pinned tabs inside groups.
      const groupId = !pinned && groupIds.has(rawTab.groupId) ? groupIds.get(rawTab.groupId) : null;
      tabs.push({
        index: tabs.length,
        url: rawTab.url,
        title: asString(rawTab.title),
        pinned,
        active: !!rawTab.active,
        groupId,
      });
    }
    if (!tabs.length) continue;

    const win = { focused: !!rawWin.focused, tabs, groups };
    if (WINDOW_STATES.includes(rawWin.state)) win.state = rawWin.state;
    for (const key of BOUNDS) {
      if (Number.isFinite(rawWin[key])) win[key] = Math.round(rawWin[key]);
    }
    windows.push(win);
  }
  return windows;
}
