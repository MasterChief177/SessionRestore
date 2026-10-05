// Restore a snapshot (all windows, one window, or one tab).
//
// - Never touches existing tabs: windows are restored into new windows.
// - Tabs are created in small batches so huge sessions don't freeze the browser.
// - With lazy loading, every tab except the active one is discarded as soon as its navigation
//   has committed. A discarded tab keeps its URL and loads when you click it.

import { GROUP_COLORS } from './model.js';

const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 50;
const COMMIT_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve once the tab has a committed URL (or after a timeout, or if it disappears). */
function waitForCommit(tabId) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    };
    const committed = (tab) => !!tab?.url && !tab.pendingUrl;
    const onUpdated = (id, _changeInfo, tab) => {
      if (id === tabId && committed(tab)) finish();
    };
    const onRemoved = (id) => {
      if (id === tabId) finish();
    };
    const timer = setTimeout(finish, COMMIT_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((tab) => committed(tab) && finish(), finish);
  });
}

/** Discard a freshly created tab. Returns its (possibly new) id. */
async function discardWhenReady(tabId) {
  await waitForCommit(tabId);
  try {
    const discarded = await chrome.tabs.discard(tabId);
    return discarded?.id ?? tabId;
  } catch {
    // Some URLs (chrome://, errors, already-closed tabs) can't be discarded. Leave them loaded.
    return tabId;
  }
}

async function createWindow(win) {
  // Start with a blank placeholder tab that we remove at the end, so every real tab is created
  // the same way (in order, in the background) and the active one is picked at the end.
  const createData = { url: 'about:blank', focused: true };
  if (win.state === 'maximized' || win.state === 'fullscreen') {
    createData.state = 'maximized';
  } else {
    for (const key of ['left', 'top', 'width', 'height']) {
      if (Number.isFinite(win[key])) createData[key] = win[key];
    }
  }
  try {
    return await chrome.windows.create(createData);
  } catch {
    // Saved bounds can be invalid on a different monitor setup.
    return chrome.windows.create({ url: 'about:blank', focused: true });
  }
}

async function restoreWindow(win, { lazy }) {
  const created = await createWindow(win);
  const windowId = created.id;
  const placeholderId = created.tabs?.[0]?.id ?? null;

  const activeIndex = Math.max(0, win.tabs.findIndex((tab) => tab.active));
  const tabIds = new Array(win.tabs.length).fill(null);
  let failed = 0;

  for (let start = 0; start < win.tabs.length; start += BATCH_SIZE) {
    const toDiscard = [];
    const end = Math.min(start + BATCH_SIZE, win.tabs.length);
    for (let i = start; i < end; i++) {
      const tab = win.tabs[i];
      try {
        const createdTab = await chrome.tabs.create({ windowId, url: tab.url, pinned: !!tab.pinned, active: false });
        tabIds[i] = createdTab.id;
        if (lazy && i !== activeIndex) toDiscard.push(i);
      } catch (error) {
        // e.g. file:// without file access, or a URL Chrome refuses to open from an extension.
        console.warn('Could not restore tab', tab.url, error);
        failed++;
      }
    }
    await Promise.all(
      toDiscard.map(async (i) => {
        tabIds[i] = await discardWhenReady(tabIds[i]);
      }),
    );
    if (end < win.tabs.length) await sleep(BATCH_PAUSE_MS);
  }

  if (chrome.tabGroups) {
    for (const group of win.groups ?? []) {
      const ids = win.tabs
        .map((tab, i) => (tab.groupId === group.id ? tabIds[i] : null))
        .filter((id) => id != null);
      if (!ids.length) continue;
      try {
        const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, {
          title: group.title ?? '',
          color: GROUP_COLORS.includes(group.color) ? group.color : 'grey',
          collapsed: !!group.collapsed,
        });
      } catch (error) {
        console.warn('Could not recreate tab group', group, error);
      }
    }
  }

  const restoredIds = tabIds.filter((id) => id != null);
  const activeId = tabIds[activeIndex] ?? restoredIds[0];
  if (activeId != null) await chrome.tabs.update(activeId, { active: true }).catch(() => {});

  if (restoredIds.length) {
    if (placeholderId != null) await chrome.tabs.remove(placeholderId).catch(() => {});
  } else {
    // Nothing could be opened; don't leave an empty window behind.
    await chrome.windows.remove(windowId).catch(() => {});
  }

  return { windowCreated: restoredIds.length > 0, tabs: restoredIds.length, failed };
}

async function restoreSingleTab(tab) {
  const target = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (target) {
    await chrome.tabs.create({ windowId: target.id, url: tab.url, active: true });
    await chrome.windows.update(target.id, { focused: true });
  } else {
    await chrome.windows.create({ url: tab.url, focused: true });
  }
  return { windows: 0, tabs: 1, failed: 0 };
}

/**
 * @param snapshot   a snapshot record
 * @param options    { windowIndex, tabIndex, lazy }. Give windowIndex to restore one window,
 *                   windowIndex + tabIndex to open one tab in the current window.
 */
export async function restoreSnapshot(snapshot, { windowIndex = null, tabIndex = null, lazy = true } = {}) {
  if (windowIndex != null && tabIndex != null) {
    const tab = snapshot.windows[windowIndex]?.tabs[tabIndex];
    if (!tab) throw new Error('That tab is not in the snapshot.');
    return restoreSingleTab(tab);
  }

  const windows = windowIndex != null ? [snapshot.windows[windowIndex]].filter(Boolean) : snapshot.windows;
  if (!windows.length) throw new Error('Nothing to restore.');

  // Restore the window that had focus last so it ends up in front.
  const ordered = [...windows].sort((a, b) => Number(!!a.focused) - Number(!!b.focused));
  const result = { windows: 0, tabs: 0, failed: 0 };
  for (const win of ordered) {
    const r = await restoreWindow(win, { lazy });
    if (r.windowCreated) result.windows++;
    result.tabs += r.tabs;
    result.failed += r.failed;
  }
  return result;
}
