// Helpers shared by the popup, the snapshot browser and the settings page.

/** Ask the service worker to do something. Throws if it reports an error. */
export async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('The background worker did not answer.');
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

/**
 * Tiny DOM builder. Text is always inserted as text nodes, never as HTML, because tab titles
 * and URLs come from arbitrary web pages.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  restore: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  chevron: 'M9 6l6 6-6 6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  pin: 'M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z',
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon-svg', `icon-${name}`);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------------------
// Formatting

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const dayWithYearFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export const formatTime = (ts) => timeFormat.format(ts);
export const formatDateTime = (ts) => dateTimeFormat.format(ts);

const startOfDay = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function formatDay(ts, now = Date.now()) {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day === today) return 'Today';
  if (day === startOfDay(today - 12 * 3600 * 1000)) return 'Yesterday';
  return new Date(ts).getFullYear() === new Date(now).getFullYear() ? dayFormat.format(ts) : dayWithYearFormat.format(ts);
}

export function formatRelative(ts, now = Date.now()) {
  const seconds = Math.round((now - ts) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDateTime(ts);
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const describeCounts = (s) => `${plural(s.tabCount, 'tab')} · ${plural(s.windowCount, 'window')}`;

export const KIND_LABELS = { auto: 'Auto', manual: 'Manual', startup: 'Startup' };

export function kindBadge(kind) {
  return h('span', { class: `kind kind-${kind}` }, KIND_LABELS[kind] ?? kind);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

/** File-name friendly local timestamp: 2026-10-05-1432 */
export function fileStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// UI bits

/** Save text as a file via a Blob URL. No `downloads` permission needed. */
export function downloadFile(fileName, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = h('a', { href: url, download: fileName, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

let toastTimer = null;
export function toast(message, { error = false, duration = 3200 } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), duration);
}

/** Two-step button for destructive actions: first click arms it, second click runs it. */
export function confirmClick(button, confirmLabel, action) {
  const original = button.textContent;
  let armedTimer = null;
  button.addEventListener('click', async () => {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = confirmLabel;
      armedTimer = setTimeout(() => {
        button.classList.remove('armed');
        button.textContent = original;
      }, 3000);
      return;
    }
    clearTimeout(armedTimer);
    button.classList.remove('armed');
    button.textContent = original;
    await action();
  });
  return button;
}

/** Run an async action with the button disabled; report errors as a toast. */
export async function busy(button, action) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (error) {
    console.error(error);
    toast(error?.message ?? String(error), { error: true });
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Open one of the extension's own pages, or focus it if it's already open. A `#hash` in `path`
 * picks the tab on the main page; an open copy just gets its hash changed instead of reloading.
 */
export async function openExtensionPage(path) {
  const url = chrome.runtime.getURL(path);
  const page = url.split('#')[0];
  // chrome-extension:// isn't a valid match pattern for tabs.query({ url }), so filter by hand.
  const existing = (await chrome.tabs.query({})).find((tab) => tab.url?.split('#')[0] === page);
  if (existing) {
    await chrome.tabs.update(existing.id, existing.url === url ? { active: true } : { active: true, url });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}
