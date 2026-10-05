import { listSnapshots } from '../background/db.js';
import { groupByWindow } from '../lib/grouping.js';
import { getSettings } from '../lib/settings.js';
import {
  busy,
  describeCounts,
  formatDateTime,
  formatRelative,
  formatTime,
  h,
  icon,
  kindBadge,
  openExtensionPage,
  plural,
  send,
  toast,
} from './common.js';

const RECENT_COUNT = 6; // time windows shown
const RECENT_SCAN = 200; // snapshots read to build them
const $ = (id) => document.getElementById(id);

async function restore(id, button) {
  await busy(button, async () => {
    const result = await send('restore', { id });
    // Usually the popup has already closed because a new window took focus.
    toast(`Restored ${plural(result.tabs, 'tab')}${result.failed ? `, ${result.failed} failed` : ''}`);
  });
}

async function renderLiveCount() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const tabs = windows.reduce((sum, win) => sum + (win.tabs?.length ?? 0), 0);
  $('live-count').textContent = `${plural(tabs, 'tab')} in ${plural(windows.length, 'window')} open now`;
}

async function renderLastSession() {
  const info = await send('lastSession');
  const section = $('last-session');
  section.hidden = !info || info.matchesCurrent;
  if (section.hidden) return;
  const s = info.snapshot;
  $('last-session-meta').textContent = `${formatDateTime(s.updatedAt ?? s.createdAt)} · ${describeCounts(s)}`;
  $('restore-last-session').onclick = (event) => restore(s.id, event.currentTarget);
}

/** One row per time window, grouped like the main page. Single snapshots can be restored right here. */
async function renderRecent() {
  const [{ items }, settings] = await Promise.all([listSnapshots({ limit: RECENT_SCAN }), getSettings()]);
  const groups = groupByWindow(items, settings.groupMinutes).slice(0, RECENT_COUNT);
  $('recent-empty').hidden = groups.length > 0;
  $('recent').classList.add('fade-in');
  $('recent').replaceChildren(
    ...groups.map((group) => {
      const s = group.items[0]; // newest in the window
      const single = group.items.length === 1;
      const labels = group.items.filter((x) => x.kind === 'manual' && x.label).map((x) => x.label);
      const time = single ? s.createdAt : group.mark;
      return h(
        'li',
        {},
        h(
          'div',
          { class: 'recent-info' },
          h(
            'div',
            { class: 'recent-line' },
            h('span', { class: 'recent-time', title: formatDateTime(time) }, formatTime(time)),
            single ? kindBadge(s.kind) : h('span', { class: 'kind kind-group' }, `${group.items.length} snapshots`),
            labels.length ? h('span', { class: 'recent-label', title: labels.join(', ') }, labels[0]) : null,
          ),
          h('div', { class: 'recent-counts muted' }, `${describeCounts(s)} · ${formatRelative(s.updatedAt ?? s.createdAt)}`),
        ),
        // A window is never restored as a whole: "Show" opens it on the main page, unfolded.
        single
          ? h(
              'button',
              { type: 'button', class: 'small', title: 'Restore into new windows', onclick: (event) => restore(s.id, event.currentTarget) },
              'Restore',
            )
          : h(
              'button',
              { type: 'button', class: 'small', title: 'See the snapshots in this window', onclick: () => openPage(`window-${group.mark}`) },
              'Show',
            ),
      );
    }),
  );
}

async function openPage(hash) {
  await openExtensionPage(`src/ui/browser.html#${hash}`);
  window.close();
}

// Both land on the Snapshots tab with the newest snapshot unfolded; Settings is the tab next to it.
$('open-settings').append(icon('settings'));
$('open-settings').addEventListener('click', () => openPage('latest'));
$('open-browser').addEventListener('click', () => openPage('latest'));

$('save-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('label');
  const button = event.submitter ?? event.currentTarget.querySelector('button');
  await busy(button, async () => {
    await send('save', { label: input.value });
    input.value = '';
    toast('Snapshot saved');
    await renderRecent();
  });
});

for (const task of [renderLiveCount, renderLastSession, renderRecent]) {
  task().catch((error) => {
    console.error(error);
    toast(error?.message ?? String(error), { error: true });
  });
}
