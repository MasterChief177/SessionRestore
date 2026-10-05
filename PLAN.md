# Tab Snapshot Extension: Plan

Working title: `tab-snapshot` (final name TBD, must NOT resemble "Session Buddy")

## 1. Goal

A Chrome extension that continuously records the state of my tabs so I can restore them after a crash, and exports any snapshot as a human-readable Markdown file.

Built for me and a few friends. Open source (GPL-3.0). Published on the Chrome Web Store as **Unlisted**.

## 2. Non-goals (v1)

- No cloud sync, accounts, or analytics. Everything stays local.
- No Firefox support (maybe later).
- No tab suspender / RAM saving features.
- No fancy tagging or search. Keep it simple.
- No incognito recording.

## 3. Core features

| # | Feature | Notes |
|---|---------|-------|
| 1 | Automatic snapshots on change | Event-driven, debounced, deduplicated by hash |
| 2 | Crash recovery | Fresh snapshot on startup, "restore last session" button |
| 3 | Manual named snapshots | "Save now" with optional label, never auto-deleted |
| 4 | Snapshot browser | Popup/page listing snapshots by time, with tab counts |
| 5 | Restore | Whole snapshot, one window, or a single tab. Lazy loading |
| 6 | Markdown export | One snapshot (or all) to a readable `.md` file |
| 7 | Import | Re-read an exported `.md` or JSON file and restore from it |
| 8 | Settings | Retention, debounce delay, ignore rules |

## 4. Architecture

- **Manifest V3**, service worker as the background script.
- **Storage:** IndexedDB for snapshots (can grow, fast writes). `chrome.storage.local` only for small settings.
- **UI:** a popup for quick actions, plus a full-page "snapshot browser" opened in a tab.
- **Language:** plain JavaScript or TypeScript with no framework. Keep dependencies at zero if possible (easier GPL compliance, easier store review).

### Folder layout

```
tab-snapshot/
├── manifest.json
├── src/
│   ├── background/
│   │   ├── service-worker.js    # event listeners, debounce, snapshot trigger
│   │   ├── snapshot.js          # build snapshot from chrome.tabs/windows
│   │   ├── db.js                # IndexedDB wrapper
│   │   └── compaction.js        # retention rules
│   ├── ui/
│   │   ├── popup.html/js/css
│   │   └── browser.html/js/css  # full snapshot list + restore
│   └── lib/
│       ├── markdown.js          # export / import
│       └── restore.js           # lazy restore logic
├── icons/                       # 16, 48, 128 px
├── LICENSE                      # GPL-3.0
├── README.md
├── PRIVACY.md                   # also hosted for the store listing
└── PLAN.md
```

## 5. How automatic snapshots work

**Triggers** (all in the service worker):

- `chrome.tabs.onCreated`, `onRemoved`, `onMoved`, `onAttached`, `onDetached`
- `chrome.tabs.onUpdated`, but **only** when `changeInfo.url` or `changeInfo.title` is present (it fires constantly otherwise)
- `chrome.windows.onCreated`, `onRemoved`
- `chrome.runtime.onStartup` and `onInstalled` for a baseline snapshot

**Flow:**

1. Event fires, so reset a short debounce timer (~1.5 s).
2. Timer expires, so query all windows and tabs (`chrome.windows.getAll({ populate: true })`).
3. Filter out ignored URLs and incognito.
4. Build a normalized snapshot and compute a hash.
5. Hash equals the previous snapshot's hash? Skip. Otherwise write to IndexedDB.
6. Run compaction occasionally (not on every write).

**MV3 rules to respect:**

- The service worker can be killed any time, so keep no state in memory that matters.
- A very short `setTimeout` is fine because events keep the worker alive. Do not use `chrome.alarms` for the debounce (30 s minimum).
- Register all listeners synchronously at the top level of the worker.

**Worst case after a crash:** lose roughly the last 1-2 seconds of changes.

## 6. Data model

```
Snapshot {
  id:        auto-increment
  createdAt: timestamp
  kind:      "auto" | "manual" | "startup"
  label:     string | null        // manual snapshots only
  hash:      string
  windows: [
    {
      focused: boolean,
      tabs: [
        { index, url, title, pinned, active, groupId | null }
      ],
      groups: [ { id, title, color, collapsed } ]
    }
  ]
}
```

- Do not store tab IDs or window IDs as identity. They reset on browser restart. Use position only.
- Index on `createdAt` and `kind`.

## 7. Retention and compaction

Defaults (all configurable):

- Last 24 h: keep every snapshot
- 1-7 days: keep one per hour
- 7-90 days: keep one per day
- Older: delete
- **Manual snapshots are never auto-deleted**
- Hard cap on total snapshots as a safety net

Run compaction on startup and at most once per hour.

## 8. Restore

- Restore a whole snapshot, a single window, or a single tab.
- Large sessions (50+ tabs) must not choke the browser:
  - Open tabs in small batches (for example 10 at a time).
  - Prefer loading only the active tab per window and leaving the rest unloaded. Verify the best approach during implementation (`chrome.tabs.discard` after creation is one option).
- Recreate pinned state, window grouping, and tab groups where the API allows.
- Never close existing tabs. Restore opens into new windows by default.

## 9. Markdown export format

Human-readable first, machine-parsable second.

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

- Import parses the same structure back (links + headings + pin marker).
- Also offer JSON export for lossless backup.

## 10. Permissions (keep minimal)

| Permission | Why |
|------------|-----|
| `tabs` | Read tab URLs and titles |
| `storage` | Settings |
| `unlimitedStorage` | Optional, only if IndexedDB quota becomes a problem |
| `downloads` | Export the Markdown file (can be avoided with a Blob + anchor download from an extension page) |

No host permissions, no remote code, no network requests.

## 11. Milestones

**M0: Skeleton (1 evening)**
- Manifest, service worker, icons, popup that shows the current tab count

**M1: Manual snapshot + restore**
- Save now, list snapshots, restore a snapshot
- IndexedDB wrapper

**M2: Markdown export/import**
- Export one snapshot, import it back

**M3: Automatic incremental snapshots**
- Event listeners, debounce, hash dedupe, startup snapshot
- Crash test: kill Chrome, relaunch, confirm recovery

**M4: Retention and settings**
- Compaction, settings page, ignore rules

**M5: Polish and release prep**
- Restore batching, tab groups, error handling
- README, PRIVACY, LICENSE, screenshots

**M6: Chrome Web Store**
- Developer account ($5 one-time), zip, listing, privacy policy, submit as Unlisted

## 12. Testing checklist

- [ ] Open or close 40 tabs quickly: only a few snapshots written (debounce works)
- [ ] Reload one page repeatedly: no snapshot spam (hash dedupe works)
- [ ] Kill Chrome via task manager, relaunch: last state is recoverable
- [ ] Multiple windows, pinned tabs, tab groups survive a restore
- [ ] Restore 100+ tabs: browser stays responsive
- [ ] Service worker killed and woken: nothing lost
- [ ] Compaction removes old autos, keeps manual ones
- [ ] Export, wipe the DB, import: state matches
- [ ] Incognito windows are never recorded
- [ ] Storage size stays reasonable after a week of normal use

## 13. Release and legal

- **License:** GPL-3.0. Check any third-party library for compatibility (MIT is fine, keep their notices).
- **Naming:** pick an original name and icon. Do not copy Session Buddy's name, assets, or code.
- **README note** (draft):
  > **Note:** This project was written with AI and built for a small group of friends. It was never intended for wide adoption. I may not maintain it if it takes up too much of my time. Issues and PRs are welcome, but there's no guarantee I'll respond. Feel free to fork it.
- **Privacy policy:** state plainly that the extension records tab URLs and titles continuously, all data stays on the device, nothing is collected or sent anywhere.
- **Store listing:** short description, single-purpose statement, justification for each permission, screenshots (1280x800), 128x128 icon.
- Store rules and fees can change, so re-check the Chrome Web Store developer docs before submitting.

## 14. Risks

| Risk | Mitigation |
|------|------------|
| Event noise causes constant writes | Filter `onUpdated`, debounce, hash dedupe |
| DB grows too large | Compaction, hard cap, show size in settings |
| Restore of huge sessions freezes Chrome | Batching, lazy loading |
| MV3 or store policy changes | Minimal permissions, keep code simple |
| Store review rejection | Clear single purpose, minimal permissions, privacy policy |
| I stop maintaining it | README note, GPL, fork-friendly |

## 15. Open questions

- Final project name
- Chrome only, or Firefox later?
- Is a simple retention preset enough, or do I want per-tier settings in the UI?
- Should import accept only my own Markdown format, or also OneTab / Session Buddy exports?
- Include a keyboard shortcut for "save now"?
