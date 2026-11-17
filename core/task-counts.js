// Global status totals use task rows, never the agents attached to those rows.
export function taskCounts(needs = [], tasks = []) {
  const seen = new Set();
  let ready = 0, working = 0;
  for (const task of tasks) {
    if (task.archived || seen.has(task.key)) continue;
    seen.add(task.key);
    if (task.status === "ready") ready++;
    if (task.status === "working" || task.status === "work") working++;
  }
  return { need: new Set(needs.map((n) => n.key)).size, ready, working };
}
