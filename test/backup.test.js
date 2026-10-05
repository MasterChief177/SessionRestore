import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonBackup, prepareImport, snapshotsToJson } from '../src/lib/backup.js';
import { snapshotToMarkdown } from '../src/lib/markdown.js';
import { makeSnapshot } from '../src/lib/model.js';

const windows = [
  {
    focused: true,
    state: 'normal',
    left: 0,
    top: 0,
    width: 1200,
    height: 800,
    tabs: [
      { index: 0, url: 'https://a.example/', title: 'A', pinned: true, active: false, groupId: null },
      { index: 1, url: 'https://b.example/', title: 'B', pinned: false, active: true, groupId: 0 },
    ],
    groups: [{ id: 0, title: 'G', color: 'purple', collapsed: false }],
  },
];

test('JSON backup round trip is lossless', async () => {
  const original = await makeSnapshot({ windows, kind: 'auto', createdAt: 1_700_000_000_000, session: 'abc' });
  original.id = 42;
  original.updatedAt = 1_700_000_100_000;

  const { format, snapshots } = await prepareImport('backup.json', snapshotsToJson([original]));
  assert.equal(format, 'json');
  assert.equal(snapshots.length, 1);
  const [restored] = snapshots;
  assert.equal(restored.id, undefined);
  for (const key of ['createdAt', 'updatedAt', 'kind', 'label', 'session', 'hash', 'structureHash', 'tabCount', 'windowCount']) {
    assert.deepEqual(restored[key], original[key], key);
  }
  assert.deepEqual(restored.windows, original.windows);
});

test('Markdown import becomes a manual snapshot with the original label or the file name', async () => {
  const auto = await makeSnapshot({ windows, kind: 'auto', createdAt: new Date(2026, 0, 2, 3, 4).getTime() });
  const labelled = await makeSnapshot({ windows, kind: 'manual', label: 'Mine', createdAt: 0 });

  const fromAuto = await prepareImport('export.md', snapshotToMarkdown(auto), 99);
  assert.equal(fromAuto.format, 'markdown');
  assert.equal(fromAuto.snapshots[0].kind, 'manual');
  assert.equal(fromAuto.snapshots[0].label, 'Imported from export.md');
  assert.equal(fromAuto.snapshots[0].createdAt, auto.createdAt);
  assert.equal(fromAuto.snapshots[0].session, null);
  assert.equal(fromAuto.snapshots[0].structureHash, auto.structureHash);

  const fromLabelled = await prepareImport('x.md', snapshotToMarkdown(labelled));
  assert.equal(fromLabelled.snapshots[0].label, 'Mine');
});

test('a Markdown file that starts with a link is not mistaken for JSON', async () => {
  const { format, snapshots } = await prepareImport('links.md', '[A](https://a.example/)\n[B](https://b.example/)', 7);
  assert.equal(format, 'markdown');
  assert.equal(snapshots[0].tabCount, 2);
  assert.equal(snapshots[0].createdAt, 7);
});

test('invalid JSON backups are rejected', () => {
  assert.throws(() => parseJsonBackup('{"hello": 1}'), /not a SessionRestore backup/);
});
