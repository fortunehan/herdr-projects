import { isWorkingTask, taskInSpace } from "./spaces.js";

const empty = () => ({ need: 0, ready: 0, working: 0 });
const identity = (item) => item.key ?? JSON.stringify([item.machine ?? null, item.folder, item.ref]);

// A space counts once even when Pinned and a section both name it. Unplaced items never enter its totals.
export function spaceTaskCounts({ spaces = [], needs = [], ready = [], running = [], tabOf = (item) => item.tab,
  red = true, green = true } = {}) {
  const unique = [...new Map(spaces.map((s) => [s.id, s])).values()];
  const bySpace = new Map(unique.map((s) => [s.id, empty()]));
  const byTab = new Map(unique.flatMap((s) => (s.tabs ?? []).map((tab) => [tab.id, s.id])));
  const elsewhere = { ...empty(), count: 0, reasons: [] };
  const reasons = new Map();
  const count = (items, kind, place) => {
    const seen = new Set();
    for (const item of items) {
      const key = identity(item);
      if (item.archived || seen.has(key)) continue;
      seen.add(key);
      const { space, reason } = place(item);
      if (space) bySpace.get(space)[kind]++;
      else {
        elsewhere[kind]++;
        elsewhere.count++;
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
  };
  const byItemTab = (item) => {
    const tab = tabOf(item), space = byTab.get(tab);
    return { space, reason: tab ? "Tab is no longer in a space" : item.space && !bySpace.has(item.space)
      ? "Space is unavailable" : "No tab in a space" };
  };
  if (red) count(needs, "need", byItemTab);
  if (green) count(ready, "ready", byItemTab);
  count(running.filter(isWorkingTask), "working", (item) => ({
    space: unique.find((s) => taskInSpace(item, s))?.id,
    reason: item.space ? "Space is unavailable" : "No space matches the task folder",
  }));
  const total = empty();
  for (const counts of bySpace.values()) for (const kind of Object.keys(total)) total[kind] += counts[kind];
  elsewhere.reasons = [...reasons].map(([reason, count]) => ({ reason, count }));
  return { bySpace, total, elsewhere };
}
