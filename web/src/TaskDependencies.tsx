import { openTask } from './kernel.ts'
import { TaskDot } from './ui.tsx'
import type { Task, TaskRelation } from '../shared/types.ts'

export function TaskDependencies({ relations }: { relations: NonNullable<Task['dependencies']> }) {
  const content = (d: TaskRelation) => <>
    {d.status ? <span className="flex shrink-0"><TaskDot s={d.status} /></span> : null}
    <span className="max-w-1/2 shrink-0 truncate font-mono text-[0.6875rem] phone:text-[0.75rem]">{d.ref}</span>
    {d.title ? <span className="min-w-0 truncate">{d.title}</span> : null}
    {d.external ? <span className="max-w-24 shrink-0 truncate text-fg3">· {d.state}</span> : null}
  </>
  return <div className="task-dependencies pointer-events-auto min-w-0 text-[0.75rem]/5 phone:text-[0.8125rem]/6">
    {relations.waitsFor.map((d, i) => <div key={`${d.ref}:${i}`} className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-fg2">↳ Waits for</span>
      {d.task ? <button type="button" onClick={(e) => { e.stopPropagation(); openTask(d.task!) }}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded bg-bubble px-1.5 text-fg hover:bg-sel keys:focus-visible:outline-2 keys:focus-visible:outline-focus">
        <span className="sr-only">Open </span>
        {content(d)}
      </button> : <span className="flex h-6 min-w-0 items-center gap-1.5 rounded bg-bubble px-1.5 text-fg2">{content(d)}</span>}
    </div>)}
    {relations.unblocks.length ? <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-fg3">
      <span>↳ Unblocks</span>
      {relations.unblocks.map((d, i) => d.task ? <button key={`${d.ref}:${i}`} type="button"
        onClick={(e) => { e.stopPropagation(); openTask(d.task!) }} aria-label={`Open ${d.ref} ${d.title ?? ''}`}
        className="h-6 rounded font-mono text-[0.6875rem] underline decoration-fg3/40 underline-offset-2 hover:text-fg keys:focus-visible:outline-2 keys:focus-visible:outline-focus phone:text-[0.75rem]">{d.ref}</button>
        : <span key={`${d.ref}:${i}`}>{d.ref}</span>)}
    </div> : null}
  </div>
}
