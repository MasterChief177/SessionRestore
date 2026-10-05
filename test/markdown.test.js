import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatStamp, parseMarkdown, parseStamp, snapshotToMarkdown, snapshotsToMarkdown } from '../src/lib/markdown.js';
import { makeSnapshot } from '../src/lib/model.js';

const createdAt = new Date(2026, 9, 5, 14, 32).getTime();

function sampleWindows() {
  return [
    {
      focused: true,
      tabs: [
        { index: 0, url: 'https://mail.google.com/', title: 'Gmail', pinned: true, active: false, groupId: null },
        { index: 1, url: 'https://developer.chrome.com/docs/extensions/reference/api/tabs', title: 'Chrome tabs API', pinned: false, active: true, groupId: 0 },
        { index: 2, url: 'https://developer.chrome.com/docs/extensions/develop/concepts/service-workers', title: 'MV3 service workers', pinned: false, active: false, groupId: 0 },
        { index: 3, url: 'https://example.com/', title: 'Some page title', pinned: false, active: false, groupId: null },
        { index: 4, url: 'https://news.example/', title: 'News', pinned: false, active: false, groupId: 1 },
      ],
      groups: [
        { id: 0, title: 'Docs', color: 'blue', collapsed: false },
        { id: 1, title: '', color: 'red', collapsed: true },
      ],
    },
    {
      focused: false,
      tabs: [{ index: 0, url: 'https://en.wikipedia.org/wiki/Foo_(bar)', title: 'Foo [bar] <b>*x*</b> \\ `y`', pinned: false, active: true, groupId: null }],
      groups: [],
    },
  ];
}

test('formatStamp / parseStamp round trip at minute precision', () => {
  assert.equal(formatStamp(createdAt), '2026-10-05 14:32');
  assert.equal(parseStamp('SessionRestore: 2026-10-05 14:32'), createdAt);
  assert.equal(parseStamp('no date here'), null);
  // Exports made under the old working title still carry their time.
  assert.equal(parseStamp('Tab Snapshot: 2026-10-05 14:32'), createdAt);
});

test('export matches the documented format', async () => {
  const snap = await makeSnapshot({ windows: sampleWindows(), kind: 'manual', label: 'Research session', createdAt });
  const md = snapshotToMarkdown(snap);
  const lines = md.split('\n');
  assert.equal(lines[0], '# SessionRestore: 2026-10-05 14:32');
  assert.equal(lines[2], 'Kind: manual | Label: Research session | Tabs: 6 | Windows: 2');
  assert.ok(md.includes('## Window 1 (focused)\n\n### Ungrouped\n- 📌 [Gmail](https://mail.google.com/)\n\n### Group: Docs (blue)\n'));
  assert.ok(md.includes('- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)'));
  assert.ok(md.includes('### Group (red, collapsed)\n- [News](https://news.example/)'));
  // Second window has no groups, so no ### headings.
  assert.ok(md.includes('## Window 2\n\n- [Foo \\[bar\\] \\<b\\>\\*x\\*\\</b\\> \\\\ \\`y\\`](<https://en.wikipedia.org/wiki/Foo_(bar)>)'));
});

test('import parses an export back into the same tabs, order, pins and groups', async () => {
  const windows = sampleWindows();
  const snap = await makeSnapshot({ windows, kind: 'manual', label: 'Research | with pipe', createdAt });
  const [parsed] = parseMarkdown(snapshotToMarkdown(snap));

  assert.equal(parsed.createdAt, createdAt);
  assert.equal(parsed.kind, 'manual');
  assert.equal(parsed.label, 'Research | with pipe');
  assert.equal(parsed.windows.length, 2);
  assert.equal(parsed.windows[0].focused, true);
  assert.equal(parsed.windows[1].focused, false);

  for (const [wi, win] of windows.entries()) {
    const got = parsed.windows[wi];
    assert.deepEqual(
      got.tabs.map((t) => [t.url, t.title, t.pinned]),
      win.tabs.map((t) => [t.url, t.title, t.pinned]),
    );
    // Group membership survives (group ids are positional on both sides).
    assert.deepEqual(
      got.tabs.map((t) => t.groupId),
      win.tabs.map((t) => t.groupId),
    );
    assert.deepEqual(
      got.groups.map(({ title, color, collapsed }) => ({ title, color, collapsed })),
      win.groups.map(({ title, color, collapsed }) => ({ title, color, collapsed })),
    );
  }
});

test('multiple snapshots in one file', async () => {
  const a = await makeSnapshot({ windows: sampleWindows(), kind: 'auto', createdAt });
  const b = await makeSnapshot({ windows: sampleWindows().slice(1), kind: 'manual', label: 'B', createdAt: createdAt + 60_000 });
  const parsed = parseMarkdown(snapshotsToMarkdown([b, a]));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].label, 'B');
  assert.equal(parsed[0].windows.length, 1);
  assert.equal(parsed[1].kind, 'auto');
  assert.equal(parsed[1].windows.length, 2);
});

test('lenient import: plain lists, autolinks, bare URLs and OneTab lines', () => {
  const text = [
    'Some notes about my reading list.',
    '',
    '* [Example](https://example.com/a "with a title")',
    '1. <https://example.com/b>',
    'https://example.com/c | Example C',
    'https://example.com/d',
    'See [this link](https://example.com/inline) for more.',
    '- [relative](docs/readme.md)',
    '- [ ] [Task item](https://example.com/task)',
  ].join('\n');
  const [snap] = parseMarkdown(text);
  assert.equal(snap.createdAt, null);
  assert.equal(snap.windows.length, 1);
  assert.deepEqual(
    snap.windows[0].tabs.map((t) => [t.url, t.title]),
    [
      ['https://example.com/a', 'Example'],
      ['https://example.com/b', ''],
      ['https://example.com/c', 'Example C'],
      ['https://example.com/d', ''],
      ['https://example.com/task', 'Task item'],
    ],
  );
});

test('text without any links yields nothing', () => {
  assert.deepEqual(parseMarkdown('# Just a heading\n\nAnd a paragraph.'), []);
});

test('group heading titles with parentheses and empty groups', () => {
  const md = ['## Window 1', '### Group: Work (2024) (green)', '- [A](https://a.example/)', '### Group: Empty (blue)', '### Ungrouped', '- [B](https://b.example/)'].join('\n');
  const [snap] = parseMarkdown(md);
  const win = snap.windows[0];
  assert.deepEqual(win.groups, [{ id: 0, title: 'Work (2024)', color: 'green', collapsed: false }]);
  assert.deepEqual(
    win.tabs.map((t) => t.groupId),
    [0, null],
  );
});
