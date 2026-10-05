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
import { groupByWindow } from '../lib/grouping.js';
import { snapshotToMarkdown, snapshotsToMarkdown } from '../lib/markdown.js';
import { DEFAULT_SETTINGS, SETTINGS_KEY, getSettings, normalizeSettings } from '../lib/settings.js';
import { initSettingsView, renderStorage } from './settings-view.js';
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
  formatTimeRange,
  h,
  hostOf,
  icon,
  kindBadge,
  plural,
  send,
  toast,
} from './common.js';

// Generous, because the list folds snapshots into time windows.
const PAGE_SIZE = 200;
const FILTERS = {
  all: null,
  manual: ['manual'],
  auto: ['auto', 'startup'],
};

const state = {
  filter: 'all',
  items: [],
  hasMore: false,
  expanded: new Set(), // snapshot ids with details open
  openGroups: new Set(), // window marks that are unfolded
  groupMinutes: DEFAULT_SETTINGS.groupMinutes,
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
    if (!$('view-settings').hidden) renderStorage().catch(console.error);
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

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Restart the soft fade-in on an element. */
function fadeIn(el) {
  el.classList.remove('fade-in');
  void el.offsetWidth; // force a reflow so the animation runs again
  el.classList.add('fade-in');
}

/**
 * Open or close the panel (`className`) inside `host` in place, with a soft slide, so nothing
 * else on the page jumps or re-renders.
 */
function setPanel(host, className, open, build) {
  host.classList.toggle('expanded', open);
  host.querySelector(':scope > .snap-head .toggle')?.setAttribute('aria-expanded', String(open));
  const current = [...host.children].find((el) => el.classList.contains(className));
  // Nested panels animate too and their events bubble, so only react to our own.
  const onEnd = (panel, fn) =>
    panel.addEventListener('animationend', function handler(event) {
      if (event.target !== panel) return;
      panel.removeEventListener('animationend', handler);
      fn();
    });
  if (open) {
    current?.remove();
    const panel = build();
    panel.classList.add('entering');
    onEnd(panel, () => panel.classList.remove('entering'));
    host.append(panel);
  } else if (current) {
    if (reducedMotion.matches) {
      current.remove();
      return;
    }
    current.classList.add('leaving');
    onEnd(current, () => current.remove());
  }
}

/** Expand or collapse one snapshot's details. */
function toggle(id) {
  const article = $('list').querySelector(`.snap[data-id="${id}"]`);
  const snapshot = state.items.find((s) => s.id === id);
  if (!article || !snapshot) return;
  const open = !state.expanded.has(id);
  if (open) state.expanded.add(id);
  else state.expanded.delete(id);
  setPanel(article, 'snap-details', open, () => renderDetails(snapshot));
}

/** Unfold or fold a time window to show the snapshots inside it. */
function toggleGroup(mark) {
  const article = $('list').querySelector(`.snap-group[data-mark="${mark}"]`);
  const group = groupByWindow(state.items, state.groupMinutes).find((g) => g.mark === mark);
  if (!article || !group) return;
  const open = !state.openGroups.has(mark);
  if (open) state.openGroups.add(mark);
  else state.openGroups.delete(mark);
  setPanel(article, 'group-items', open, () => h('div', { class: 'group-items' }, group.items.map(renderItem)));
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

  return h(
    'article',
    { class: expanded ? 'snap expanded' : 'snap', dataset: { id: snapshot.id } },
    head,
    expanded ? renderDetails(snapshot) : null,
  );
}

/** One row for a time window holding several snapshots; unfold it to restore one of them. */
function renderGroup(group) {
  const open = state.openGroups.has(group.mark);
  const latest = group.items[0];
  const oldest = group.items.at(-1);
  const labels = group.items.filter((s) => s.kind === 'manual' && s.label).map((s) => s.label);

  const head = h(
    'div',
    {
      class: 'snap-head',
      onclick: (event) => {
        if (!event.target.closest('button, a')) toggleGroup(group.mark);
      },
    },
    h(
      'div',
      { class: 'snap-when', title: `Snapshots closest to ${formatTime(group.mark)}` },
      h('span', { class: 'snap-time' }, formatTime(group.mark)),
    ),
    h('span', { class: 'kind kind-group' }, `${group.items.length} snapshots`),
    h(
      'div',
      { class: 'snap-summary' },
      labels.length
        ? h('span', { class: 'snap-label', title: labels.join(', ') }, labels.length > 1 ? `${labels[0]} +${labels.length - 1}` : labels[0])
        : null,
      h('span', { class: 'muted' }, `${formatTimeRange(oldest.createdAt, latest.createdAt)} · last: ${describeCounts(latest)}`),
    ),
    // No Restore here on purpose: you restore one of the snapshots inside, never the window.
    h(
      'div',
      { class: 'snap-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'small ghost toggle',
          'aria-expanded': String(open),
          onclick: () => toggleGroup(group.mark),
        },
        icon('chevron'),
        'Show',
      ),
    ),
  );

  return h(
    'article',
    { class: open ? 'snap-group expanded' : 'snap-group', dataset: { mark: group.mark } },
    head,
    open ? h('div', { class: 'group-items' }, group.items.map(renderItem)) : null,
  );
}

function render() {
  const days = [];
  for (const group of groupByWindow(state.items, state.groupMinutes)) {
    const label = formatDay(group.mark);
    if (days.at(-1)?.label !== label) days.push({ label, groups: [] });
    days.at(-1).groups.push(group);
  }
  $('list').replaceChildren(
    ...days.flatMap((day) => [
      h('h2', { class: 'day-heading' }, day.label),
      h(
        'div',
        { class: 'day-group' },
        day.groups.map((group) => (group.items.length === 1 ? renderItem(group.items[0]) : renderGroup(group))),
      ),
    ]),
  );
  $('empty').hidden = state.items.length > 0;
  $('load-more').hidden = !state.hasMore;
}

// ---------------------------------------------------------------------------
// Tabs and links into the page, all through the URL hash:
//   #snapshots, #settings   pick a tab
//   #latest                 Snapshots tab with the newest snapshot unfolded and its tabs listed
//   #window-<mark>          Snapshots tab with that time window unfolded
// With no hash at all (Chrome's own "Extension options" menu opens the page that way) the
// settings tab is shown.

const VIEWS = ['snapshots', 'settings'];
const VIEW_TITLES = { snapshots: 'Snapshots', settings: 'Settings' };

function parseHash() {
  const raw = location.hash.slice(1);
  if (!raw || raw === 'settings') return { view: 'settings' };
  if (raw === 'latest') return { view: 'snapshots', reveal: 'latest' };
  const windowLink = /^window-(\d+)$/.exec(raw);
  if (windowLink) return { view: 'snapshots', reveal: Number(windowLink[1]) };
  return { view: 'snapshots' };
}

function setFilter(name) {
  state.filter = name;
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === name));
  }
  state.items = [];
}

/** Unfold and scroll to the newest snapshot ('latest') or a time window (its mark). */
async function reveal(target) {
  if (state.filter !== 'all') setFilter('all');
  await load();
  const groups = groupByWindow(state.items, state.groupMinutes);
  const group = target === 'latest' ? groups[0] : groups.find((g) => g.mark === target);
  if (!group) return;
  if (group.items.length > 1 && !state.openGroups.has(group.mark)) toggleGroup(group.mark);
  let el;
  if (target === 'latest') {
    const latest = group.items[0];
    if (!state.expanded.has(latest.id)) toggle(latest.id);
    el = $('list').querySelector(`.snap[data-id="${latest.id}"]`);
  } else {
    el = $('list').querySelector(`.snap-group[data-mark="${group.mark}"]`);
  }
  el?.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

function showView(view, { animate = true } = {}) {
  for (const name of VIEWS) {
    const active = name === view;
    $(`view-${name}`).hidden = !active;
    $(`tab-${name}`).setAttribute('aria-selected', String(active));
    $(`tab-${name}`).tabIndex = active ? 0 : -1;
  }
  document.title = `${VIEW_TITLES[view]} · SessionRestore`;
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (animate) fadeIn($(`view-${view}`));
  if (view === 'settings') renderStorage().catch(console.error);
}

for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    const next = VIEWS[(VIEWS.indexOf(tab.dataset.view) + step + VIEWS.length) % VIEWS.length];
    showView(next);
    $(`tab-${next}`).focus();
  });
}

// The popup's links reuse an open tab by changing just the hash. `ready` is set below, once the
// first load has finished.
let ready = Promise.resolve();
window.addEventListener('hashchange', () => {
  const { view, reveal: target } = parseHash();
  showView(view);
  if (target != null) ready.then(() => reveal(target)).catch(console.error);
});

// ---------------------------------------------------------------------------
// Wiring

for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    setFilter(button.dataset.filter);
    load()
      .then(() => fadeIn($('list')))
      .catch(console.error);
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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'snapshots-changed') refreshSoon();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const minutes = normalizeSettings(changes[SETTINGS_KEY].newValue).groupMinutes;
  if (minutes === state.groupMinutes) return;
  state.groupMinutes = minutes;
  state.openGroups.clear();
  render();
});

const initial = parseHash();
showView(initial.view, { animate: false });
initSettingsView({ onCleanup: refreshSoon });

ready = getSettings()
  .then((settings) => {
    state.groupMinutes = settings.groupMinutes;
  })
  .catch(console.error)
  .then(() => load())
  .then(() => fadeIn($('list')));
ready
  .then(() => initial.reveal != null && reveal(initial.reveal))
  .catch((error) => {
    console.error(error);
    toast(error?.message ?? String(error), { error: true });
  });
renderStats().catch(console.error);
