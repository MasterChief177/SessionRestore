// Build a snapshot from the live browser state.

import { compileIgnoreRules } from '../lib/ignore.js';

const BOUNDS = ['left', 'top', 'width', 'height'];

/**
 * Pure: turn chrome.windows.getAll({ populate: true }) output into snapshot windows.
 * Tab and group ids are runtime-only, so they are replaced by positions: tabs get their
 * index in the snapshot, groups get a per-window number in order of first appearance.
 */
export function normalizeChromeWindows(chromeWindows, chromeGroups = [], { focusedWindowId = null, isIgnored = () => false } = {}) {
  const groupsById = new Map(chromeGroups.map((group) => [group.id, group]));
  const windows = [];

  for (const win of chromeWindows) {
    if (win.incognito || (win.type && win.type !== 'normal')) continue;

    const groups = [];
    const localGroupIds = new Map();
    const tabs = [];
    const chromeTabs = [...(win.tabs ?? [])].sort((a, b) => a.index - b.index);

    for (const tab of chromeTabs) {
      if (tab.incognito) continue;
      // A tab that is mid-navigation reports where it is going in pendingUrl.
      const url = tab.pendingUrl || tab.url || '';
      if (!url || isIgnored(url)) continue;

      let groupId = null;
      if (tab.groupId != null && tab.groupId !== -1) {
        if (!localGroupIds.has(tab.groupId)) {
          const group = groupsById.get(tab.groupId);
          localGroupIds.set(tab.groupId, groups.length);
          groups.push({
            id: groups.length,
            title: group?.title ?? '',
            color: group?.color ?? 'grey',
            collapsed: !!group?.collapsed,
          });
        }
        groupId = localGroupIds.get(tab.groupId);
      }

      tabs.push({
        index: tabs.length,
        url,
        title: tab.title ?? '',
        pinned: !!tab.pinned,
        active: !!tab.active,
        groupId,
      });
    }

    if (!tabs.length) continue;
    const snapWin = {
      focused: focusedWindowId != null ? win.id === focusedWindowId : !!win.focused,
      state: win.state ?? 'normal',
      tabs,
      groups,
    };
    for (const key of BOUNDS) {
      if (Number.isFinite(win[key])) snapWin[key] = win[key];
    }
    windows.push(snapWin);
  }
  return windows;
}

/** Query Chrome for all normal windows, tabs and groups and normalize them. */
export async function captureWindows(settings) {
  const [chromeWindows, chromeGroups, lastFocused] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    chrome.tabGroups ? chrome.tabGroups.query({}) : Promise.resolve([]),
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null),
  ]);

  const ownPages = chrome.runtime.getURL('');
  const matchesRule = compileIgnoreRules(settings.ignoreRules);

  return normalizeChromeWindows(chromeWindows, chromeGroups, {
    focusedWindowId: lastFocused?.id ?? null,
    isIgnored: (url) => url.startsWith(ownPages) || matchesRule(url),
  });
}
