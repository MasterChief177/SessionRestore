// When the next automatic snapshot gets written.

// If events never stop (a page retitling itself every second), still write a snapshot at least
// this often, or every two debounce periods when the debounce is longer than half of it.
export const MAX_WAIT_MS = 10_000;

/**
 * Milliseconds from `now` until the pending snapshot is due: `debounceMs` after the latest event,
 * but no later than the max wait after the first event of the burst.
 */
export function snapshotDelay(debounceMs, firstEventAt, now) {
  const maxWait = Math.max(MAX_WAIT_MS, 2 * debounceMs);
  return Math.max(0, Math.min(debounceMs, firstEventAt + maxWait - now));
}
