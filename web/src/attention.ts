import { needsYou, waitingTasks } from '@shared/needs-you.ts'
import type { Snapshot, Task } from '@shared/types.ts'

/** All spaces and machines, including tasks whose space is no longer open: the bottom bar (SHEP-68/79). Needs you is
 *  upstream's one rule (web/shared/needs-you.ts, SHEP-250/253), so it matches the Tasks panel and the sidebar; a task in
 *  it counts there only, never also as Ready or Working. */
export function globalTaskCounts(snap: Snapshot) {
  const ws = needsYou(snap)
  const held = waitingTasks(ws)
  const seen = new Set<string>()
  let ready = 0, working = 0
  for (const t of snap.tasks) {
    if (t.archived || held.has(t.id) || seen.has(t.id)) continue
    seen.add(t.id)
    if (t.status === 'ready') ready++
    if (t.status === 'work') working++
  }
  return { need: ws.length, ready, working }
}

/** What waits on you at these places, each number what its own list shows: need is Needs you's items here (one rule for
 *  every view, web/shared/needs-you.ts), ready the Ready tasks of Tasks not in it. */
export function attentionCounts(snap: Snapshot, places: string[]) {
  const ids = new Set(places)
  const ws = needsYou(snap)
  const held = waitingTasks(ws)
  return { need: ws.filter((w) => w.place && ids.has(w.place)).length, ready: snap.tasks.filter((t) => ids.has(t.place) && !t.archived && t.status === 'ready' && !held.has(t.id)).length }
}

export const actionable = (t: Task) => t.status === 'need' || t.status === 'ready'
