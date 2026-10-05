// The Settings tab of the main page.

import { countSnapshots, getSnapshotIndex } from '../background/db.js';
import { getSettings, resetSettings, saveSettings } from '../lib/settings.js';
import { busy, formatBytes, plural, send, toast } from './common.js';

const $ = (id) => document.getElementById(id);

function fill(settings) {
  $('debounce').value = settings.debounceMs / 1000;
  $('ignore-rules').value = settings.ignoreRules.join('\n');
  $('keep-all-hours').value = settings.keepAllHours;
  $('hourly-days').value = settings.hourlyDays;
  $('daily-days').value = settings.dailyDays;
  $('max-snapshots').value = settings.maxSnapshots;
  $('lazy-restore').checked = settings.lazyRestore;
  $('group-minutes').value = settings.groupMinutes;
}

function read() {
  return {
    debounceMs: $('debounce').value === '' ? '' : Number($('debounce').value) * 1000,
    ignoreRules: $('ignore-rules').value.split('\n'),
    keepAllHours: $('keep-all-hours').value,
    hourlyDays: $('hourly-days').value,
    dailyDays: $('daily-days').value,
    maxSnapshots: $('max-snapshots').value,
    lazyRestore: $('lazy-restore').checked,
    groupMinutes: $('group-minutes').value,
  };
}

let savedTimer = null;
function flashSaved() {
  $('saved').hidden = false;
  $('saved').classList.remove('fade-in');
  void $('saved').offsetWidth; // restart the fade on repeated saves
  $('saved').classList.add('fade-in');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    $('saved').hidden = true;
  }, 2000);
}

export async function renderStorage() {
  const [entries, total, estimate] = await Promise.all([
    getSnapshotIndex(),
    countSnapshots(),
    navigator.storage?.estimate?.().catch(() => null) ?? null,
  ]);
  const manual = entries.filter((e) => e.kind === 'manual').length;
  const size = estimate?.usage != null ? ` · ${formatBytes(estimate.usage)} on disk` : '';
  $('storage-stats').textContent = `${plural(total, 'snapshot')} (${manual} manual)${size}`;
}

/** Wire up the form once. `onCleanup` runs after "Clean up now" deleted something. */
export function initSettingsView({ onCleanup = () => {} } = {}) {
  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter ?? event.currentTarget.querySelector('button[type=submit]');
    await busy(button, async () => {
      // normalizeSettings clamps anything out of range; show the values that were actually saved.
      fill(await saveSettings(read()));
      flashSaved();
    });
  });

  $('reset').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      fill(await resetSettings());
      flashSaved();
    }),
  );

  $('compact').addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const result = await send('compact');
      toast(result?.deleted ? `Deleted ${plural(result.deleted, 'old snapshot')}` : 'Nothing to clean up');
      await renderStorage();
      if (result?.deleted) onCleanup();
    }),
  );

  getSettings().then(fill, (error) => toast(error.message, { error: true }));
  renderStorage().catch(console.error);
}
