import type { Snapshot, Task } from '@shared/types.ts'
import { taskCounts } from '@core/task-counts.js'

/** All spaces and machines, including tasks whose space is no longer open. */
export function globalTaskCounts(snap: Snapshot) {
  return taskCounts(
    snap.needs.map((n) => ({ key: JSON.stringify([n.id, n.chat, n.task, n.place]) })),
    snap.tasks.map((t) => ({ key: t.id, status: t.status, archived: t.archived })),
  )
}

/** What waits on you at these places, each number what its own list shows: need is the Needs you view's cards here,
 *  ready the Ready tasks of Tasks. */
export function attentionCounts(snap: Snapshot, places: string[]) {
  const ids = new Set(places)
  return { need: snap.needs.filter((n) => ids.has(n.place)).length, ready: snap.tasks.filter((t) => ids.has(t.place) && !t.archived && t.status === 'ready').length }
}

export const actionable = (t: Task) => t.status === 'need' || t.status === 'ready'
