// Group snapshots into time windows for display. Recording is unaffected: every snapshot is
// still stored; the list just folds the ones that belong to the same window into one row.
//
// Windows are centred on "marks" every N minutes from local midnight (with N = 5: 3:40, 3:45,
// 3:50, ...). Each snapshot joins the mark closest to it, seconds included, so 3:42:29 belongs
// to 3:40 and 3:42:31 to 3:45. An exact tie goes to the later mark.

const MINUTE = 60 * 1000;

export function nearestMark(ts, minutes) {
  const d = new Date(ts);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const step = minutes * MINUTE;
  return midnight + Math.round((ts - midnight) / step) * step;
}

/**
 * @param snapshots  newest first (as listSnapshots returns them)
 * @returns          [{ mark, items }] newest first; `items` keeps the input order
 */
export function groupByWindow(snapshots, minutes) {
  const groups = [];
  for (const snapshot of snapshots) {
    const mark = nearestMark(snapshot.createdAt, minutes);
    const last = groups.at(-1);
    if (last && last.mark === mark) last.items.push(snapshot);
    else groups.push({ mark, items: [snapshot] });
  }
  return groups;
}
