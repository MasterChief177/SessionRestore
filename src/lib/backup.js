// JSON backup (lossless) and the import entry point for both JSON and Markdown files.

import { KINDS, makeSnapshot, sanitizeWindows } from './model.js';
import { parseMarkdown } from './markdown.js';

export const BACKUP_FORMAT = 'sessionrestore';
export const BACKUP_VERSION = 1;

export function snapshotsToJson(snapshots, now = Date.now()) {
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date(now).toISOString(),
      // Hashes and counts are derived data; they get recomputed on import.
      snapshots: snapshots.map(({ id, hash, structureHash, tabCount, windowCount, ...rest }) => rest),
    },
    null,
    2,
  );
}

export function parseJsonBackup(text) {
  const data = JSON.parse(text);
  let list = null;
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data?.snapshots)) list = data.snapshots;
  else if (Array.isArray(data?.windows)) list = [data];
  if (!list) throw new Error('This JSON file is not a SessionRestore backup.');

  return list
    .map((raw) => ({
      createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : null,
      updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : null,
      kind: KINDS.includes(raw?.kind) ? raw.kind : 'manual',
      label: typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim() : null,
      session: typeof raw?.session === 'string' && raw.session ? raw.session : null,
      windows: sanitizeWindows(raw?.windows),
    }))
    .filter((s) => s.windows.length);
}

function looksLikeJson(fileName, text) {
  if (/\.json$/i.test(fileName)) return true;
  const start = text.trimStart()[0];
  return start === '{' || start === '[';
}

/**
 * Turn an imported file into snapshot records ready for the database.
 * - JSON backups are restored as they were (kind, label, time, session).
 * - Markdown imports become manual snapshots, so retention never deletes them.
 */
export async function prepareImport(fileName, text, now = Date.now()) {
  if (looksLikeJson(fileName, text)) {
    let parsed = null;
    try {
      parsed = parseJsonBackup(text);
    } catch (error) {
      // A Markdown file can legitimately start with "[" (a link). Only give up for real .json files.
      if (/\.json$/i.test(fileName)) throw error;
    }
    if (parsed) {
      const snapshots = await Promise.all(
        parsed.map(async (s) => {
          const record = await makeSnapshot({
            windows: s.windows,
            kind: s.kind,
            label: s.label,
            createdAt: s.createdAt ?? now,
            session: s.session,
          });
          if (s.updatedAt) record.updatedAt = s.updatedAt;
          return record;
        }),
      );
      return { format: 'json', snapshots };
    }
  }

  const parsed = parseMarkdown(text);
  const snapshots = await Promise.all(
    parsed.map((s) =>
      makeSnapshot({
        windows: sanitizeWindows(s.windows),
        kind: 'manual',
        label: s.label ?? `Imported from ${fileName}`,
        createdAt: s.createdAt ?? now,
        session: null,
      }),
    ),
  );
  return { format: 'markdown', snapshots };
}
