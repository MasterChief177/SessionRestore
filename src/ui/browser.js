import {
  addSnapshotsIfNew,
  countSnapshots,
  deleteSnapshots,
  getAllSnapshots,
  listSnapshots,
  notifySnapshotsChanged,
  updateSnapshot,
} from '../background/db.js';
import { prepareImport, snapshotsToJson } from '../lib/backup.js';
import { snapshotToMarkdown, snapshotsToMarkdown } from '../lib/markdown.js';
import {
  busy,
  confirmClick,
  describeCounts,
  downloadFile,
  fileStamp,
  formatBytes,
  formatDateTime,
  formatDay,
  formatTime,
  h,
  hostOf,
  icon,
  kindBadge,
  plural,
  send,
  toast,
} from './common.js';

const PAGE_SIZE = 50;
const FILTERS = {
  all: null,
  manual: ['manual'],
  auto: ['auto', 'startup'],
};

const state = {
  filter: 'all',
  items: [],
  hasMore: false,
  expanded: new Set(),
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Loading

async function load({ append = false } = {}) {
  const last = state.items.at(-1);
  const { items, hasMore } = await listSnapshots({
    kinds: FILTERS[state.filter],
    limit: append ? PAGE_SIZE : Math.max(PAGE_SIZE, state.items.length),
    before: append && last ? { createdAt: last.createdAt, id: last.id } : null,
  });
  state.items = append ? [...state.items, ...items] : items;
  state.hasMore = hasMore;
  render();
}

async function renderStats() {
  const [count, estimate] = await Promise.all([
    countSnapshots(),
    navigator.storage?.estimate?.().catch(() => null) ?? null,
  ]);
  const size = estimate?.usage != null ? ` · ${formatBytes(estimate.usage)} used` : '';
  $('stats').textContent = `${plural(count, 'snapshot')}${size}`;
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    load().catch(console.error);
    renderStats().catch(console.error);
  }, 400);
}

function changed() {
  notifySnapshotsChanged();
  refreshSoon();
}

// ---------------------------------------------------------------------------
// Actions

async function restore(id, target = {}, button = null) {
  await busy(button, async () => {
    const result = await send('restore', { id, ...target });
    if (target.tabIndex != null) return;
    const failed = result.failed ? ` (${result.failed} could not be opened)` : '';
    toast(`Restored ${plural(result.tabs, 'tab')} in ${plural(result.windows, 'window')}${failed}`);
  });
}

function exportMarkdown(snapshot) {
  downloadFile(`sessionrestore-${fileStamp(snapshot.createdAt)}.md`, snapshotToMarkdown(snapshot), 'text/markdown');
}

function exportJson(snapshot) {
  downloadFile(`sessionrestore-${fileStamp(snapshot.createdAt)}.json`, snapshotsToJson([snapshot]), 'application/json');
}

async function copyMarkdown(snapshot, button) {
  await busy(button, async () => {
    await navigator.clipboard.writeText(snapshotToMarkdown(snapshot));
    toast('Copied as Markdown');
  });
}

async function editLabel(snapshot) {
  const keep = snapshot.kind !== 'manual';
  const message = keep
    ? 'Keep this snapshot forever? It becomes a manual snapshot, which is never deleted automatically.\n\nLabel (optional):'
    : 'Label:';
  const answer = prompt(message, snapshot.label ?? '');
  if (answer === null) return;
  const patch = { label: answer.trim() || null };
  if (keep) patch.kind = 'manual';
  await busy(null, async () => {
    await updateSnapshot(snapshot.id, patch);
    toast(keep ? 'Snapshot kept as manual' : 'Label updated');
    changed();
  });
}

async function remove(snapshot) {
  await busy(null, async () => {
    await deleteSnapshots([snapshot.id]);
    state.expanded.delete(snapshot.id);
    toast('Snapshot deleted');
    changed();
  });
}

async function exportAllMarkdown(button) {
  await busy(button, async () => {
    const kinds = FILTERS[state.filter];
    const all = (await getAllSnapshots()).filter((s) => !kinds || kinds.includes(s.kind)).reverse();
    if (!all.length) return toast('Nothing to export');
    const name = state.filter === 'all' ? 'all' : state.filter;
    downloadFile(`sessionrestore-${name}-${fileStamp(Date.now())}.md`, snapshotsToMarkdown(all), 'text/markdown');
  });
}

async function exportBackup(button) {
  await busy(button, async () => {
    const all = await getAllSnapshots();
    if (!all.length) return toast('Nothing to back up');
    downloadFile(`sessionrestore-backup-${fileStamp(Date.now())}.json`, snapshotsToJson(all), 'application/json');
  });
}

async function importFiles(files) {
  let added = 0;
  let skipped = 0;
  const empty = [];
  for (const file of files) {
    const { snapshots } = await prepareImport(file.name, await file.text());
    if (!snapshots.length) {
      empty.push(file.name);
      continue;
    }
    const result = await addSnapshotsIfNew(snapshots);
    added += result.added;
    skipped += result.skipped;
  }
  if (added) changed();
  if (empty.length && !added && !skipped) {
    toast(`No tabs found in ${empty.join(', ')}`, { error: true });
    return;
  }
  const parts = [`Imported ${plural(added, 'snapshot')}`];
  if (skipped) parts.push(`${skipped} already existed`);
  if (empty.length) parts.push(`nothing found in ${empty.join(', ')}`);
  toast(parts.join(' · '));
}

// ---------------------------------------------------------------------------
// Rendering

const SAFE_LINK = /^(https?|ftp|file):/i;

function renderTabs(snapshot, win, windowIndex) {
  const groups = new Map((win.groups ?? []).map((g) => [g.id, g]));
  const rows = [];
  let current = null;
  win.tabs.forEach((tab, tabIndex) => {
    const groupId = tab.groupId ?? null;
    const group = groupId != null ? groups.get(groupId) : null;
    if (groupId != null && groupId !== current) {
      rows.push(
        h(
          'li',
          { class: 'group-row' },
          h('span', { class: `group-dot group-${group?.color ?? 'grey'}` }),
          h('span', {}, group?.title || 'Unnamed group'),
          group?.collapsed ? h('span', { class: 'muted' }, 'collapsed') : null,
        ),
      );
    }
    current = groupId;
    rows.push(
      h(
        'li',
        { class: `tab-row${group ? ' in-group' : ''}`, dataset: group ? { color: group.color } : {} },
        tab.pinned ? h('span', { class: 'pin', title: 'Pinned' }, icon('pin')) : null,
        h(
          'a',
          {
            class: 'tab-title',
            href: SAFE_LINK.test(tab.url) ? tab.url : null,
            tabindex: '0',
            title: `${tab.title || tab.url}\n${tab.url}\n\nClick to open in the current window`,
            onclick: (event) => {
              event.preventDefault();
              restore(snapshot.id, { windowIndex, tabIndex });
            },
          },
          tab.title || tab.url,
        ),
        h('span', { class: 'tab-host muted' }, hostOf(tab.url)),
      ),
    );
  });
  return rows;
}

function renderDetails(snapshot) {
  const deleteButton = confirmClick(
    h('button', { type: 'button', class: 'small danger' }, 'Delete'),
    'Click again to delete',
    () => remove(snapshot),
  );
  const actions = h(
    'div',
    { class: 'detail-actions' },
    h('button', { type: 'button', class: 'small', onclick: () => exportMarkdown(snapshot) }, 'Export .md'),
    h('button', { type: 'button', class: 'small', onclick: () => exportJson(snapshot) }, 'Export .json'),
    h('button', { type: 'button', class: 'small', onclick: (e) => copyMarkdown(snapshot, e.currentTarget) }, 'Copy as Markdown'),
    h(
      'button',
      { type: 'button', class: 'small', onclick: () => editLabel(snapshot) },
      snapshot.kind === 'manual' ? (snapshot.label ? 'Rename' : 'Add label') : 'Keep forever',
    ),
    deleteButton,
  );

  const windows = snapshot.windows.map((win, windowIndex) =>
    h(
      'section',
      { class: 'window' },
      h(
        'header',
        { class: 'window-head' },
        h('h3', {}, `Window ${windowIndex + 1}`),
        h('span', { class: 'muted' }, `${plural(win.tabs.length, 'tab')}${win.focused ? ' · focused' : ''}`),
        h('span', { class: 'spacer' }),
        snapshot.windows.length > 1
          ? h(
              'button',
              {
                type: 'button',
                class: 'small ghost',
                onclick: (e) => restore(snapshot.id, { windowIndex }, e.currentTarget),
              },
              icon('restore'),
              'Restore window',
            )
          : null,
      ),
      h('ul', { class: 'tab-list' }, renderTabs(snapshot, win, windowIndex)),
    ),
  );

  return h('div', { class: 'snap-details' }, actions, windows);
}

function toggle(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  render();
}

function renderItem(snapshot) {
  const expanded = state.expanded.has(snapshot.id);
  const updated =
    snapshot.updatedAt && snapshot.updatedAt - snapshot.createdAt >= 60_000
      ? h('span', { class: 'snap-updated muted' }, `to ${formatTime(snapshot.updatedAt)}`)
      : null;

  const head = h(
    'div',
    {
      class: 'snap-head',
      onclick: (event) => {
        if (!event.target.closest('button, a')) toggle(snapshot.id);
      },
    },
    h(
      'div',
      { class: 'snap-when', title: formatDateTime(snapshot.createdAt) },
      h('span', { class: 'snap-time' }, formatTime(snapshot.createdAt)),
      updated,
    ),
    kindBadge(snapshot.kind),
    h(
      'div',
      { class: 'snap-summary' },
      snapshot.label ? h('span', { class: 'snap-label', title: snapshot.label }, snapshot.label) : null,
      h('span', { class: 'muted' }, describeCounts(snapshot)),
    ),
    h(
      'div',
      { class: 'snap-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'small',
          title: 'Restore into new windows',
          onclick: (e) => restore(snapshot.id, {}, e.currentTarget),
        },
        icon('restore'),
        'Restore',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'small ghost toggle',
          'aria-expanded': String(expanded),
          onclick: () => toggle(snapshot.id),
        },
        icon('chevron'),
        'Details',
      ),
    ),
  );

  return h('article', { class: 'snap', dataset: { id: snapshot.id } }, head, expanded ? renderDetails(snapshot) : null);
}

function render() {
  const days = [];
  for (const snapshot of state.items) {
    const label = formatDay(snapshot.createdAt);
    if (days.at(-1)?.label !== label) days.push({ label, items: [] });
    days.at(-1).items.push(snapshot);
  }
  $('list').replaceChildren(
    ...days.flatMap((day) => [
      h('h2', { class: 'day-heading' }, day.label),
      h('div', { class: 'day-group' }, day.items.map(renderItem)),
    ]),
  );
  $('empty').hidden = state.items.length > 0;
  $('load-more').hidden = !state.hasMore;
}

// ---------------------------------------------------------------------------
// Wiring

for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    for (const other of document.querySelectorAll('[data-filter]')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
    state.items = [];
    load().catch(console.error);
  });
}

$('load-more').addEventListener('click', (e) => busy(e.currentTarget, () => load({ append: true })));

$('save-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('label');
  const button = event.submitter ?? event.currentTarget.querySelector('button');
  await busy(button, async () => {
    await send('save', { label: input.value });
    input.value = '';
    toast('Snapshot saved');
    refreshSoon();
  });
});

$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) await busy($('import'), () => importFiles(files));
});

$('export-md').addEventListener('click', (e) => exportAllMarkdown(e.currentTarget));
$('export-json').addEventListener('click', (e) => exportBackup(e.currentTarget));
$('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'snapshots-changed') refreshSoon();
});

load().catch((error) => {
  console.error(error);
  toast(error?.message ?? String(error), { error: true });
});
renderStats().catch(console.error);
