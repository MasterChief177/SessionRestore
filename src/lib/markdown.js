// Markdown export and import.
//
// Export format (human-readable first, machine-parsable second):
//
//   # Tab Snapshot: 2026-10-05 14:32
//
//   Kind: manual | Label: Research session | Tabs: 42 | Windows: 2
//
//   ## Window 1 (focused)
//
//   ### Group: Docs (blue)
//   - [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
//
//   ### Ungrouped
//   - 📌 [Gmail](https://mail.google.com)
//
// Windows without groups skip the `###` headings. Ungrouped runs are emitted in tab order, so
// a window can have more than one "Ungrouped" section and the import still restores tab order.
//
// Import accepts that format back, and is lenient about anything else: any line that is just a
// link, an <autolink>, a bare URL, or a OneTab-style "URL | Title" line becomes a tab.

import { APP_NAME, GROUP_COLORS, KINDS, countTabs } from './model.js';

const PIN = '📌';
const SEPARATOR = '\n---\n\n';

const pad = (n) => String(n).padStart(2, '0');

/** Local time, minute precision: 2026-10-05 14:32 */
export function formatStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseStamp(text) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text ?? '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

const isPunct = (ch) => /^[!-/:-@[-`{-~]$/.test(ch);

/** Escape the characters that would break link text or render as markup. */
export function escapeText(text) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\[\]<>*`]/g, '\\$&');
}

/** CommonMark backslash escapes: `\` before ASCII punctuation is dropped. */
export function unescapeText(text) {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

function formatUrl(url) {
  // Angle brackets keep URLs with spaces, parentheses or backslashes intact.
  return /[\s()<>\\]/.test(url) ? `<${url.replace(/[\\<>]/g, '\\$&')}>` : url;
}

function tabLine(tab) {
  const pin = tab.pinned ? `${PIN} ` : '';
  return `- ${pin}[${escapeText(tab.title || tab.url)}](${formatUrl(tab.url)})`;
}

function groupHeading(group) {
  const title = group?.title ? `: ${escapeText(group.title)}` : '';
  const collapsed = group?.collapsed ? ', collapsed' : '';
  return `### Group${title} (${group?.color ?? 'grey'}${collapsed})`;
}

export function snapshotToMarkdown(snapshot) {
  const lines = [`# ${APP_NAME}: ${formatStamp(snapshot.createdAt)}`, ''];

  const meta = [`Kind: ${snapshot.kind}`];
  if (snapshot.label) meta.push(`Label: ${escapeText(snapshot.label)}`);
  meta.push(`Tabs: ${countTabs(snapshot.windows)}`, `Windows: ${snapshot.windows.length}`);
  lines.push(meta.join(' | '), '');

  snapshot.windows.forEach((win, i) => {
    lines.push(`## Window ${i + 1}${win.focused ? ' (focused)' : ''}`, '');
    const groups = new Map((win.groups ?? []).map((g) => [g.id, g]));
    const hasGroups = win.tabs.some((tab) => tab.groupId != null);
    let section; // undefined until the first heading is written
    for (const tab of win.tabs) {
      const groupId = tab.groupId ?? null;
      if (hasGroups && groupId !== section) {
        if (section !== undefined) lines.push('');
        lines.push(groupId == null ? '### Ungrouped' : groupHeading(groups.get(groupId)));
        section = groupId;
      }
      lines.push(tabLine(tab));
    }
    lines.push('');
  });

  return lines.join('\n');
}

export function snapshotsToMarkdown(snapshots) {
  return snapshots.map(snapshotToMarkdown).join(SEPARATOR);
}

// ---------------------------------------------------------------------------
// Import

/** Parse `[text](destination "optional title")` when it is the whole string. */
function parseLink(s) {
  if (s[0] !== '[') return null;
  let i = 1;
  let depth = 0;
  let text = '';
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      text += ch + s[++i];
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      if (depth === 0) break;
      depth--;
    }
    text += ch;
  }
  if (s[i] !== ']' || s[i + 1] !== '(') return null;
  i += 2;

  let url = '';
  if (s[i] === '<') {
    for (i++; i < s.length && s[i] !== '>'; i++) {
      if (s[i] === '\\' && isPunct(s[i + 1] ?? '')) url += s[++i];
      else if (s[i] === '<') return null;
      else url += s[i];
    }
    if (s[i] !== '>') return null;
    i++;
  } else {
    let parens = 0;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && isPunct(s[i + 1] ?? '')) {
        url += s[++i];
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') parens++;
      else if (ch === ')') {
        if (parens === 0) break;
        parens--;
      }
      url += ch;
    }
  }

  const tail = s.slice(i);
  if (!/^(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?\s*\)$/.test(tail)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  return { url, title: unescapeText(text).trim() };
}

function parseTabLine(line) {
  let rest = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '');
  let pinned = false;
  const pin = /^\u{1F4CC}\uFE0F?\s*/u.exec(rest);
  if (pin) {
    pinned = true;
    rest = rest.slice(pin[0].length);
  }

  const link = parseLink(rest);
  if (link) return { ...link, pinned };

  let m = /^<([a-z][a-z0-9+.-]*:[^\s<>]*)>$/i.exec(rest);
  if (m) return { url: m[1], title: '', pinned };

  m = /^([a-z][a-z0-9+.-]*:\/\/\S+)(?:\s+\|\s+(.*))?$/i.exec(rest);
  if (m) return { url: m[1], title: (m[2] ?? '').trim(), pinned };

  return null;
}

function parseGroupHeading(text) {
  const m = /^Group(?::\s*(.*?))?\s*(?:\((\w+)(\s*,\s*collapsed)?\))?\s*$/i.exec(text);
  if (!m) return null;
  const color = (m[2] ?? '').toLowerCase();
  return {
    title: unescapeText(m[1] ?? ''),
    color: GROUP_COLORS.includes(color) ? color : 'grey',
    collapsed: !!m[3],
  };
}

function parseMeta(line) {
  const m =
    /^Kind:\s*([\w-]+)\s*(?:\|\s*Label:\s*(.*?)\s*)?(?:\|\s*Tabs:\s*\d+\s*)?(?:\|\s*Windows:\s*\d+\s*)?$/i.exec(line);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const label = m[2] ? unescapeText(m[2]).trim() : '';
  return { kind: KINDS.includes(kind) ? kind : null, label: label || null };
}

/**
 * Parse Markdown into snapshot-like objects: { createdAt, kind, label, windows }.
 * `createdAt`, `kind` and `label` are null when the file doesn't say.
 */
export function parseMarkdown(text) {
  const snapshots = [];
  let snap = null;
  let win = null;
  let groupId = null;

  const startSnapshot = (createdAt) => {
    snap = { createdAt, kind: null, label: null, windows: [] };
    snapshots.push(snap);
    win = null;
    groupId = null;
  };
  const startWindow = (focused) => {
    if (!snap) startSnapshot(null);
    win = { focused, tabs: [], groups: [] };
    snap.windows.push(win);
    groupId = null;
  };

  for (const rawLine of String(text ?? '').split(/\r\n?|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const body = heading[2].trim();
      if (level === 1) {
        startSnapshot(parseStamp(body));
      } else if (level === 2) {
        startWindow(/\(focused\)$/i.test(body));
      } else {
        if (!win) startWindow(false);
        const group = parseGroupHeading(body);
        if (group) {
          group.id = win.groups.length;
          win.groups.push(group);
          groupId = group.id;
        } else {
          groupId = null;
        }
      }
      continue;
    }

    if (snap && !win) {
      const meta = parseMeta(line);
      if (meta) {
        snap.kind = meta.kind;
        snap.label = meta.label;
        continue;
      }
    }

    const tab = parseTabLine(line);
    if (!tab) continue;
    if (!win) startWindow(false);
    win.tabs.push({
      index: win.tabs.length,
      url: tab.url,
      title: tab.title,
      pinned: tab.pinned,
      active: false,
      groupId: tab.pinned ? null : groupId,
    });
  }

  for (const s of snapshots) {
    s.windows = s.windows.filter((w) => w.tabs.length);
    for (const w of s.windows) {
      // Drop group headings that ended up with no tabs and renumber the rest.
      const used = w.groups.filter((g) => w.tabs.some((t) => t.groupId === g.id));
      const remap = new Map(used.map((g, i) => [g.id, i]));
      w.groups = used.map((g, i) => ({ ...g, id: i }));
      for (const t of w.tabs) t.groupId = t.groupId == null ? null : remap.get(t.groupId);
    }
  }
  return snapshots.filter((s) => s.windows.length);
}
