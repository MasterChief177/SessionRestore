// The Settings tab of the main page.

import { countSnapshots, getSnapshotIndex } from '../background/db.js';
import { ruleKey, ruleKind } from '../lib/ignore.js';
import { getSettings, resetSettings, saveSettings } from '../lib/settings.js';
import { busy, formatBytes, h, icon, plural, send, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const modes = () => document.querySelectorAll('.mode');
const sentenceInputs = () => document.querySelectorAll('.sentence .num');
const ruleInputs = () => [...document.querySelectorAll('#ignore-list .rule-text')];

// ---------------------------------------------------------------------------
// "Never record these URLs": one editable row per rule, saved with the rest of the form.

const RULE_KINDS = {
  contains: { label: 'contains', title: 'Skips every address that contains this text' },
  wildcard: { label: 'pattern', title: '* stands for anything; the whole address has to fit the pattern' },
  comment: { label: 'note', title: "A note, not a rule: it doesn't skip anything" },
};

function showRuleKind(row) {
  const kind = ruleKind(row.querySelector('.rule-text').value);
  const badge = row.querySelector('.rule-kind');
  badge.hidden = !kind;
  badge.textContent = kind ? RULE_KINDS[kind].label : '';
  badge.title = kind ? RULE_KINDS[kind].title : '';
  badge.classList.toggle('kind-pattern', kind === 'wildcard');
  row.classList.toggle('comment', kind === 'comment');
}

function ruleRow(rule) {
  const row = h(
    'li',
    { class: 'rule' },
    h('input', {
      class: 'rule-text',
      type: 'text',
      value: rule,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'URL to never record',
    }),
    h('span', { class: 'kind rule-kind' }),
    h('button', { class: 'icon rule-remove', type: 'button', title: 'Remove', 'aria-label': 'Remove this URL' }, icon('close')),
  );
  showRuleKind(row);
  return row;
}

function showRulesEmpty() {
  const empty = !$('ignore-list').children.length;
  $('ignore-list').hidden = empty;
  $('ignore-empty').hidden = !empty;
}

function renderRules(rules) {
  $('ignore-list').replaceChildren(...rules.map(ruleRow));
  showRulesEmpty();
}

function addRule() {
  const input = $('ignore-new');
  const text = input.value.trim();
  input.focus();
  if (!text) return;
  const existing = ruleInputs().find((el) => ruleKey(el.value) === ruleKey(text));
  if (existing) {
    const match = existing.closest('.rule');
    match.classList.remove('flash');
    void match.offsetWidth; // restart the highlight on repeated tries
    match.classList.add('flash');
    toast('That one is already on the list');
    return;
  }
  const row = ruleRow(text);
  row.classList.add('fade-in');
  $('ignore-list').append(row);
  showRulesEmpty();
  input.value = '';
}

function removeRule(row) {
  // Keep keyboard focus in the list: the next row, else the previous one, else the add box.
  const next = row.nextElementSibling ?? row.previousElementSibling;
  row.remove();
  (next?.querySelector('.rule-remove') ?? $('ignore-new')).focus();
  showRulesEmpty();
}

function initRules() {
  $('ignore-add').prepend(icon('plus'));
  $('ignore-add').addEventListener('click', addRule);
  $('ignore-new').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault(); // add the rule instead of submitting the form
    addRule();
  });
  $('ignore-list').addEventListener('input', (event) => {
    const row = event.target.closest('.rule');
    if (row) showRuleKind(row);
  });
  $('ignore-list').addEventListener('click', (event) => {
    const button = event.target.closest('.rule-remove');
    if (button) removeRule(button.closest('.rule'));
  });
}

// ---------------------------------------------------------------------------

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
  renderRules(settings.ignoreRules);
  $('ignore-new').value = '';
  $('keep-all-hours').value = settings.keepAllHours;
  $('hourly-days').value = settings.hourlyDays;
  $('daily-days').value = settings.dailyDays;
  $('everything-days').value = settings.everythingDays;
  $('everything-max').value = settings.everythingMax;
  setMode(settings.retentionMode);
  $('lazy-restore').checked = settings.lazyRestore;
  $('group-minutes').value = settings.groupMinutes;
  sentenceInputs().forEach(fitSentenceInput);
}

function read() {
  return {
    debounceMs: $('debounce').value === '' ? '' : Number($('debounce').value) * 1000,
    // Text typed into the add box but not added yet counts too.
    ignoreRules: [...ruleInputs().map((el) => el.value), $('ignore-new').value],
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
  initRules();

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
