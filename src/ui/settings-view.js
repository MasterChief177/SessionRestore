// The Settings tab of the main page.

import { countSnapshots, getSnapshotIndex } from '../background/db.js';
import { getSettings, resetSettings, saveSettings } from '../lib/settings.js';
import { busy, formatBytes, plural, send, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const modes = () => document.querySelectorAll('.mode');
const sentenceInputs = () => document.querySelectorAll('.sentence .num');

function setMode(mode) {
  for (const el of modes()) {
    const active = el.dataset.mode === mode;
    el.classList.toggle('active', active);
    el.querySelector('input[type=radio]').checked = active;
  }
}

// Numbers inside a sentence grow with their content, and the unit after them follows (1 day, 2 days).
function fitSentenceInput(input) {
  input.style.setProperty('--digits', Math.max(input.value.length, 1));
  const unit = input.nextElementSibling;
  if (unit?.classList.contains('unit')) unit.textContent = input.value === '1' ? unit.dataset.one : unit.dataset.many;
}

function fill(settings) {
  $('debounce').value = settings.debounceMs / 1000;
  $('ignore-rules').value = settings.ignoreRules.join('\n');
  $('keep-all-hours').value = settings.keepAllHours;
  $('hourly-days').value = settings.hourlyDays;
  $('daily-days').value = settings.dailyDays;
  $('everything-days').value = settings.everythingDays;
  $('everything-max').value = settings.everythingMax;
  setMode(settings.retentionMode);
  sentenceInputs().forEach(fitSentenceInput);
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
    retentionMode: document.querySelector('input[name=retention-mode]:checked')?.value,
    everythingDays: $('everything-days').value,
    everythingMax: $('everything-max').value,
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
  // Clicking anywhere in a mode (its sentence and numbers included) selects it; keyboard users
  // move between the radios with the arrow keys.
  for (const el of modes()) {
    el.addEventListener('click', () => setMode(el.dataset.mode));
    el.querySelector('input[type=radio]').addEventListener('change', () => setMode(el.dataset.mode));
  }
  for (const input of sentenceInputs()) input.addEventListener('input', () => fitSentenceInput(input));

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
