import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeChromeWindows } from '../src/background/snapshot.js';
import { compileIgnoreRules } from '../src/lib/ignore.js';
import { computeHashes, makeSnapshot, sanitizeWindows } from '../src/lib/model.js';
import { normalizeSettings, DEFAULT_SETTINGS } from '../src/lib/settings.js';

const chromeTab = (props) => ({ incognito: false, pinned: false, active: false, groupId: -1, title: '', ...props });

test('normalizes chrome windows: order, ignore rules, incognito, groups by position', () => {
  const chromeWindows = [
    {
      id: 10,
      type: 'normal',
      incognito: false,
      state: 'maximized',
      tabs: [
        chromeTab({ index: 2, url: 'https://b.example/', title: 'B', groupId: 777 }),
        chromeTab({ index: 0, url: 'https://a.example/', title: 'A', pinned: true }),
        chromeTab({ index: 1, url: 'chrome://newtab/', title: 'New Tab', active: true }),
        chromeTab({ index: 3, url: '', pendingUrl: 'https://c.example/', title: '', groupId: 777 }),
      ],
    },
    { id: 11, type: 'normal', incognito: true, tabs: [chromeTab({ index: 0, url: 'https://secret.example/' })] },
    { id: 12, type: 'popup', incognito: false, tabs: [chromeTab({ index: 0, url: 'https://popup.example/' })] },
    { id: 13, type: 'normal', incognito: false, tabs: [chromeTab({ index: 0, url: 'about:blank' })] },
  ];
  const groups = [{ id: 777, title: 'Work', color: 'green', collapsed: true, windowId: 10 }];
  const isIgnored = compileIgnoreRules(DEFAULT_SETTINGS.ignoreRules);

  const windows = normalizeChromeWindows(chromeWindows, groups, { focusedWindowId: 10, isIgnored });
  assert.equal(windows.length, 1);
  const [win] = windows;
  assert.equal(win.focused, true);
  assert.equal(win.state, 'maximized');
  assert.deepEqual(
    win.tabs.map((t) => [t.index, t.url, t.pinned, t.groupId]),
    [
      [0, 'https://a.example/', true, null],
      [1, 'https://b.example/', false, 0],
      [2, 'https://c.example/', false, 0],
    ],
  );
  assert.deepEqual(win.groups, [{ id: 0, title: 'Work', color: 'green', collapsed: true }]);
});

test('ignore rules: substring, wildcard, comments', () => {
  const ignored = compileIgnoreRules(['# comment', 'mail.google.com', 'https://*.bank.example/*', '  ']);
  assert.equal(ignored('https://mail.google.com/mail/u/0/#inbox'), true);
  assert.equal(ignored('https://online.bank.example/accounts'), true);
  assert.equal(ignored('https://bank.example.evil/'), false);
  assert.equal(ignored('https://example.com/'), false);
  assert.equal(ignored('# comment'), false);
});

test('hashes: titles change only the content hash, URLs change both', async () => {
  const base = [{ focused: true, tabs: [{ index: 0, url: 'https://a/', title: 'A', pinned: false, active: true, groupId: null }], groups: [] }];
  const retitled = structuredClone(base);
  retitled[0].tabs[0].title = '(1) A';
  const moved = structuredClone(base);
  moved[0].tabs[0].url = 'https://b/';
  const resized = structuredClone(base);
  resized[0].width = 1234;

  const [h0, h1, h2, h3] = await Promise.all([base, retitled, moved, resized].map(computeHashes));
  assert.equal(h0.structureHash, h1.structureHash);
  assert.notEqual(h0.hash, h1.hash);
  assert.notEqual(h0.structureHash, h2.structureHash);
  assert.deepEqual(h0, h3);
});

test('makeSnapshot fills counts and hashes', async () => {
  const windows = sanitizeWindows([{ tabs: [{ url: 'https://a/' }, { url: 'https://b/' }] }, { tabs: [{ url: 'https://c/' }] }]);
  const snap = await makeSnapshot({ windows, kind: 'manual', label: '', createdAt: 5 });
  assert.equal(snap.tabCount, 3);
  assert.equal(snap.windowCount, 2);
  assert.equal(snap.label, null);
  assert.match(snap.hash, /^[0-9a-f]{64}$/);
});

test('sanitizeWindows drops junk and fixes references', () => {
  const windows = sanitizeWindows([
    null,
    { tabs: 'nope' },
    { tabs: [] },
    {
      focused: 1,
      state: 'weird',
      left: 10.4,
      tabs: [{ url: 'https://a/', groupId: 5 }, { url: 42 }, { url: 'https://b/', groupId: 9, pinned: true }, { url: 'https://c/', groupId: 'x' }],
      groups: [{ id: 5, title: 'G', color: 'magenta' }, { id: 5, title: 'dupe' }],
    },
  ]);
  assert.equal(windows.length, 1);
  const [win] = windows;
  assert.equal(win.focused, true);
  assert.equal(win.state, undefined);
  assert.equal(win.left, 10);
  assert.deepEqual(
    win.tabs.map((t) => [t.index, t.url, t.groupId, t.pinned]),
    [
      [0, 'https://a/', 0, false],
      [1, 'https://b/', null, true],
      [2, 'https://c/', null, false],
    ],
  );
  assert.deepEqual(win.groups, [{ id: 0, title: 'G', color: 'grey', collapsed: false }]);
});

test('settings are clamped and defaulted', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS, ignoreRules: [...DEFAULT_SETTINGS.ignoreRules] });
  const s = normalizeSettings({ debounceMs: 5, keepAllHours: 'abc', hourlyDays: 30, dailyDays: 10, ignoreRules: [' a ', '', 3] });
  assert.equal(s.debounceMs, 250);
  assert.equal(s.keepAllHours, DEFAULT_SETTINGS.keepAllHours);
  assert.equal(s.dailyDays, 30); // never shorter than the hourly tier
  assert.deepEqual(s.ignoreRules, ['a']);
  // An emptied form field means "use the default", not "use the minimum".
  assert.equal(normalizeSettings({ debounceMs: '', maxSnapshots: '' }).debounceMs, DEFAULT_SETTINGS.debounceMs);
});

test('retention mode falls back to smart thinning and its numbers are clamped', () => {
  assert.equal(normalizeSettings({ retentionMode: 'bogus' }).retentionMode, 'thin');
  const s = normalizeSettings({ retentionMode: 'everything', everythingDays: 0, everythingMax: 1e9 });
  assert.equal(s.retentionMode, 'everything');
  assert.equal(s.everythingDays, 1);
  assert.equal(s.everythingMax, 100_000);
  assert.equal(normalizeSettings({ everythingMax: '' }).everythingMax, DEFAULT_SETTINGS.everythingMax);
});
