// IndexedDB wrapper for snapshots. Works from the service worker and from extension pages
// (they share the extension origin, so they see the same database).

const DB_NAME = 'sessionrestore';
const DB_VERSION = 1;
const STORE = 'snapshots';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('kind', 'kind');
        // Records with a null session (Markdown imports) are simply left out of this index.
        store.createIndex('session', 'session');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const forget = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

/**
 * Run `body(store, done)` inside one transaction. `body` must only use IndexedDB request
 * callbacks (no awaiting other promises), and calls `done(value)` to set the result, which
 * resolves once the transaction has committed.
 */
async function run(mode, body) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    try {
      body(tx.objectStore(STORE), (value) => {
        result = value;
      });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

export function addSnapshot(record) {
  return run('readwrite', (store, done) => {
    store.add(record).onsuccess = (e) => done(e.target.result);
  });
}

export function putSnapshot(record) {
  return run('readwrite', (store, done) => {
    store.put(record).onsuccess = (e) => done(e.target.result);
  });
}

export function getSnapshot(id) {
  return run('readonly', (store, done) => {
    store.get(id).onsuccess = (e) => done(e.target.result ?? null);
  });
}

export function updateSnapshot(id, patch) {
  return run('readwrite', (store, done) => {
    store.get(id).onsuccess = (e) => {
      const record = e.target.result;
      if (!record) return done(null);
      const next = { ...record, ...patch, id };
      store.put(next);
      done(next);
    };
  });
}

export function deleteSnapshots(ids) {
  return run('readwrite', (store, done) => {
    for (const id of ids) store.delete(id);
    done(ids.length);
  });
}

export function countSnapshots() {
  return run('readonly', (store, done) => {
    store.count().onsuccess = (e) => done(e.target.result);
  });
}

/** Every snapshot, oldest first. Only for exports; this reads everything into memory. */
export function getAllSnapshots() {
  return run('readonly', (store, done) => {
    store.index('createdAt').getAll().onsuccess = (e) => done(e.target.result);
  });
}

/** Newest snapshot matching `predicate`, walking backwards in time. */
export function findLatestSnapshot(predicate = () => true) {
  return run('readonly', (store, done) => {
    const request = store.index('createdAt').openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return done(null);
      if (predicate(cursor.value)) return done(cursor.value);
      cursor.continue();
    };
  });
}

export function getLatestSnapshot() {
  return findLatestSnapshot();
}

/**
 * Newest first, `limit` at a time. Pass the last item of the previous page as `before`
 * ({ createdAt, id }) to get the next page. `kinds` optionally filters by kind.
 */
export function listSnapshots({ limit = 50, before = null, kinds = null } = {}) {
  return run('readonly', (store, done) => {
    const range = before ? IDBKeyRange.upperBound(before.createdAt) : null;
    const items = [];
    const request = store.index('createdAt').openCursor(range, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || items.length >= limit) return done({ items, hasMore: !!cursor });
      const value = cursor.value;
      const seen = before && value.createdAt === before.createdAt && value.id >= before.id;
      if (!seen && (!kinds || kinds.includes(value.kind))) items.push(value);
      cursor.continue();
    };
  });
}

/**
 * { id, createdAt, kind, session } for every snapshot, read from the indexes only so the
 * (potentially large) snapshot bodies are never loaded. Used by compaction.
 */
export function getSnapshotIndex() {
  return run('readonly', (store, done) => {
    const entries = new Map();
    const walk = (indexName, visit, next) => {
      const request = store.index(indexName).openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return next();
        visit(cursor.primaryKey, cursor.key);
        cursor.continue();
      };
    };
    walk(
      'createdAt',
      (id, createdAt) => entries.set(id, { id, createdAt, kind: null, session: null }),
      () =>
        walk(
          'kind',
          (id, kind) => {
            const entry = entries.get(id);
            if (entry) entry.kind = kind;
          },
          () =>
            walk(
              'session',
              (id, session) => {
                const entry = entries.get(id);
                if (entry) entry.session = session;
              },
              () => done([...entries.values()]),
            ),
        ),
    );
  });
}

/** Add imported records, skipping any that already exist (same time and same content). */
export function addSnapshotsIfNew(records) {
  return run('readwrite', (store, done) => {
    const byTime = store.index('createdAt');
    let added = 0;
    let skipped = 0;
    let i = 0;
    const next = () => {
      if (i >= records.length) return done({ added, skipped });
      const record = records[i++];
      byTime.getAll(record.createdAt).onsuccess = (e) => {
        if (e.target.result.some((existing) => existing.hash === record.hash)) {
          skipped++;
          next();
        } else {
          store.add(record).onsuccess = () => {
            added++;
            next();
          };
        }
      };
    };
    next();
  });
}

/** Let open extension pages know the snapshot list changed. */
export function notifySnapshotsChanged() {
  chrome.runtime.sendMessage({ type: 'snapshots-changed' }).catch(() => {
    // Nobody listening (no extension page open). That's fine.
  });
}
