import { listSnapshots } from '../background/db.js';
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

const RECENT_COUNT = 6;
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

async function renderRecent() {
  const { items } = await listSnapshots({ limit: RECENT_COUNT });
  $('recent-empty').hidden = items.length > 0;
  $('recent').replaceChildren(
    ...items.map((s) => {
      const seen = s.updatedAt ?? s.createdAt;
      return h(
        'li',
        {},
        h(
          'div',
          { class: 'recent-info' },
          h(
            'div',
            { class: 'recent-line' },
            h('span', { class: 'recent-time', title: formatDateTime(s.createdAt) }, formatTime(s.createdAt)),
            kindBadge(s.kind),
            s.label ? h('span', { class: 'recent-label', title: s.label }, s.label) : null,
          ),
          h('div', { class: 'recent-counts muted' }, `${describeCounts(s)} · ${formatRelative(seen)}`),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'small',
            title: 'Restore into new windows',
            onclick: (event) => restore(s.id, event.currentTarget),
          },
          'Restore',
        ),
      );
    }),
  );
}

$('open-settings').append(icon('settings'));
$('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('open-browser').addEventListener('click', async () => {
  await openExtensionPage('src/ui/browser.html');
  window.close();
});

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
