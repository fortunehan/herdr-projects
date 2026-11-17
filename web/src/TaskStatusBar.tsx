import type { Snapshot } from '@shared/types.ts'
import { globalTaskCounts } from './attention.ts'

export function TaskStatusBar({ snap }: { snap: Snapshot }) {
  const c = globalTaskCounts(snap)
  return (
    <div role="status" aria-label="Tasks across all spaces and machines" data-task-status className="flex shrink-0 items-center justify-center gap-4 border-t border-line bg-well px-3 py-1 text-xs text-fg2 tabular-nums phone:gap-3 phone:text-[0.6875rem]">
      <span className="hidden text-fg3 tablet:inline desktop:inline">All spaces</span>
      <span className="whitespace-nowrap"><span className={c.need ? 'font-semibold text-need-fg' : 'text-fg3'}>{c.need}</span> Needs you</span>
      <span className="whitespace-nowrap text-ready-fg"><span className="font-semibold">{c.ready}</span> Ready</span>
      <span className="whitespace-nowrap"><span className={c.working ? 'font-semibold text-work' : 'text-fg3'}>{c.working}</span> Working</span>
    </div>
  )
}
