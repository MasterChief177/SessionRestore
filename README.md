# Tab Snapshot

A Chrome extension that keeps a running history of your open tabs, so you can get them back after a crash, and exports any snapshot as a readable Markdown file.

> **Note:** This project was written with AI and built for a small group of friends. It was never intended for wide adoption. I may not maintain it if it takes up too much of my time. Issues and PRs are welcome, but there's no guarantee I'll respond. Feel free to fork it.

*Tab Snapshot is a working title.*

## What it does

- **Automatic snapshots.** Every time you open, close, move, pin or group tabs, a snapshot of all your windows is saved a moment later. Identical states are never saved twice, and pages that keep changing their title (unread counters and the like) don't flood the history.
- **Crash recovery.** When the browser starts, the popup offers **Restore last session**: the final state from before the restart or crash.
- **Manual snapshots.** Hit **Save now** (optionally with a label). Manual snapshots are never deleted automatically. Any automatic snapshot can be promoted with **Keep forever**.
- **Restore** a whole snapshot, a single window, or a single tab. Restores always open in new windows and never close anything. Pinned tabs, tab groups (name, color, collapsed) and window size are recreated. By default only the active tab of each window loads; the rest load when you click them, so restoring 100+ tabs doesn't bog the browser down.
- **Markdown export** of one snapshot or all of them, plus a lossless **JSON backup**.
- **Import** an exported Markdown or JSON file. The importer also accepts plain lists of links, bare URLs, and OneTab-style `URL | Title` lines.
- **Settings** for the debounce delay, URLs to ignore, retention, and lazy restore.

Everything stays on your computer. No accounts, no sync, no analytics, no network requests. Incognito windows are never recorded.

## Install

Until it's on the Chrome Web Store:

1. Download or clone this repository.
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
4. Pin the extension from the puzzle-piece menu so the popup is one click away.

Works in Chrome 110+ and other Chromium browsers (Edge, Brave, Vivaldi).

## Using it

- **Popup:** current tab count, **Save now**, **Restore last session** (only shown after a restart, and only when something is missing), and the most recent snapshots.
- **Snapshot browser** (via the popup link): every snapshot by day, with filters for manual and automatic ones. Click a row to see its windows and tabs; click a tab to open just that one.
- **Settings:** right-click the toolbar icon → *Options*, or the gear in the popup.

## How it works

**Recording.** The service worker listens to tab, window and tab group events. Each event resets a 1.5 second timer; when it fires, the extension reads all windows and tabs, drops ignored URLs and incognito windows, and computes two hashes:

- a *structure* hash (which URLs are open, in which order, pinned or grouped)
- a *content* hash (also titles, the active tab, focus, group names)

If the content hash matches the latest snapshot, nothing is written. If only the content changed and the latest snapshot is an automatic one from this browser session, it's updated in place. Otherwise a new snapshot is added. If events never stop, a snapshot is still written at least every 10 seconds. Worst case after a crash, you lose the last couple of seconds.

**Sessions.** Each browser run gets an id, kept in `chrome.storage.session`, which Chrome clears when it exits or crashes. When a new id is created, the newest snapshot from before is remembered as the "last session".

**Retention** (automatic snapshots only, all configurable):

| Age | Kept |
|-----|------|
| under 24 hours | everything |
| 1 to 7 days | the newest per hour |
| 7 to 90 days | the newest per day |
| older | nothing |

Manual snapshots, the newest snapshot, and the final snapshot of each browser session (up to 90 days) are always kept. A hard cap (5000 automatic snapshots by default) is the safety net. Cleanup runs at startup and at most once an hour.

**Storage.** Snapshots live in IndexedDB; settings in `chrome.storage.local`.

## Markdown format

```markdown
# Tab Snapshot: 2026-10-05 14:32

Kind: manual | Label: Research session | Tabs: 42 | Windows: 2

## Window 1 (focused)

### Group: Docs (blue)
- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [MV3 service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers)

### Ungrouped
- 📌 [Gmail](https://mail.google.com)
- [Some page title](https://example.com)
```

Windows without groups skip the `###` headings. Ungrouped tabs are listed in tab order, so a window can have several "Ungrouped" sections. Imported Markdown snapshots become manual snapshots. Markdown doesn't keep the active tab or window sizes; use the JSON backup if you need everything.

## Permissions

| Permission | Why |
|------------|-----|
| `tabs` | Read the URL and title of open tabs |
| `tabGroups` | Read and recreate tab group names and colors |
| `storage` | Settings and the current session id |

No host permissions, no remote code, no network requests. Exports are downloaded straight from the extension page, so the `downloads` permission isn't needed either.

## Development

No build step and no runtime dependencies: plain JavaScript modules, loaded directly by Chrome.

```sh
npm test          # unit tests (Node 20+, built-in test runner)
npm run package   # dist/tab-snapshot-<version>.zip for the Chrome Web Store
```

```
manifest.json
src/
├── background/
│   ├── service-worker.js   event listeners, debounce, messages
│   ├── snapshot.js         read windows/tabs/groups from Chrome
│   ├── session.js          browser-session id, "last session"
│   ├── db.js               IndexedDB wrapper (also used by the pages)
│   └── compaction.js       retention rules
├── lib/
│   ├── model.js            snapshot shape, hashing, validation
│   ├── markdown.js         Markdown export/import
│   ├── backup.js           JSON backup, import entry point
│   ├── restore.js          batched, lazy restore
│   ├── settings.js         defaults and validation
│   └── ignore.js           URL ignore rules
└── ui/                     popup, snapshot browser, settings page
icons/                      icon.svg is the source for the PNGs
test/                       unit tests for the pure modules
```

See [PLAN.md](PLAN.md) for the original plan and [PRIVACY.md](PRIVACY.md) for the privacy policy.

## License

[GPL-3.0](LICENSE).
