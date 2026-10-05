# Privacy policy

*Last updated: 5 October 2026*

SessionRestore is a browser extension that keeps a history of your open tabs so you can restore them after a crash.

## What it records

While the browser is running, the extension continuously records:

- the URL and title of each open tab
- whether a tab is pinned or active, and which tab group it's in
- tab group names, colors and whether they are collapsed
- the position, size and state of each browser window
- the time each snapshot was taken, plus any label you give it

It does **not** record incognito windows, page contents, form data, passwords, cookies or browsing history beyond the tabs that are open. URLs matching your ignore rules (Settings) are not recorded.

## Where it's stored

Everything is stored locally in your browser profile (IndexedDB and `chrome.storage`). Nothing ever leaves your device: the extension makes no network requests, has no servers, no accounts, no analytics and no tracking. Nothing is sold or shared with anyone.

Files you export (Markdown or JSON) are saved wherever you choose. What happens to them after that is up to you.

## Deleting your data

- Delete individual snapshots in the snapshot browser.
- Old automatic snapshots are deleted automatically according to the retention settings.
- Removing the extension deletes all of its data.

## Contact

Questions? Open an issue on the project's GitHub repository.
