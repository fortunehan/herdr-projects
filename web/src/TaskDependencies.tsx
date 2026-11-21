import clsx from 'clsx'
import type { ReactNode } from 'react'
import { openTask } from './kernel.ts'
import { Dot } from './ui.tsx'
import type { Task, TaskRelation } from '../shared/types.ts'

const open = (d: TaskRelation) => (e: { stopPropagation: () => void }) => { e.stopPropagation(); openTask(d.task!) }

/**
 * B of SHEP-100's mock-up (SHEP-103), as the window's (mods/tasks relationLine): a waiting task says "↑ after SHEP-12" over
 * its title, the task it waits for "↓ then SHEP-13 SHEP-15" under its id line. A prerequisite whose row is in sight
 * (`shown`: the list's rows on screen) is just its id; one out of sight or another folder's or machine's carries its dot
 * and status ("SHEP-12 · Working 40%", "WEB-2 · web · Working"). Each id opens its task.
 */
export function RelationLine({ kind, items, shown }: { kind: 'after' | 'then'; items: TaskRelation[]; shown?: ReadonlySet<string> }) {
  const after = kind === 'after'
  return (
    // ids that don't fit (long machine names on a phone) scroll sideways: the row keeps its height
    <span className={clsx('pointer-events-auto relative z-1 flex h-4 min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden text-[0.75rem]/4 whitespace-nowrap [scrollbar-width:none] phone:h-6 phone:text-[0.8125rem]/5', after ? 'text-fg2' : 'text-fg3')}>
      <span className="shrink-0 text-fg3">{after ? '↑ after' : '↓ then'}</span>
      {items.map((d, i) => {
        const away = after && (d.external || !d.task || !shown?.has(d.task))
        const body = (
          <>
            {away ? <Dot s={d.status ?? 'todo'} p={d.status === 'work' ? d.pct : undefined} className="size-3" /> : null}
            <span className="font-mono text-[0.6875rem] phone:text-[0.75rem]">{d.where ? `${d.ref} · ${d.where}` : d.ref}</span>
            {away ? <span className="text-fg3">· {d.word ?? d.state}</span> : null}
          </>
        )
        return d.task ? (
          <button key={`${d.ref}:${i}`} type="button" onClick={open(d)} aria-label={`Open ${d.ref}${d.where ? ` in ${d.where}` : ''}${d.title ? ` ${d.title}` : ''}${away ? `, ${d.word ?? d.state}` : ''}`}
            className="pointer-events-auto relative z-1 flex shrink-0 items-center gap-1 rounded text-fg2 hover:text-fg keys:focus-visible:outline-2 keys:focus-visible:outline-focus">{body}</button>
        ) : <span key={`${d.ref}:${i}`} className="flex shrink-0 items-center gap-1 text-fg2">{body}</span>
      })}
    </span>
  )
}

const PILL = 'flex min-h-[22px] max-w-full min-w-0 items-center gap-x-1.5 overflow-hidden rounded-md bg-bubble px-[7px] text-fg'

/** One prerequisite or dependent in a task's header: a button when its task can be opened. At module scope, so a
 *  snapshot that changes nothing keeps its button (and the keyboard's focus on it). */
function Pill({ r, children }: { r: TaskRelation; children: ReactNode }) {
  return r.task
    ? <button type="button" onClick={open(r)} className={clsx(PILL, 'text-left hover:bg-sel keys:focus-visible:outline-2 keys:focus-visible:outline-focus')}><span className="sr-only">Open </span>{children}</button>
    : <span className={PILL}>{children}</span>
}

/** Its id: a long one (a machine's long name) breaks onto a second line in its pill rather than being cut. */
const Ref = ({ r, solo }: { r: TaskRelation; solo?: boolean }) => <span className={clsx(solo ? "min-w-0" : "max-w-[calc(100%-1.25rem)] shrink-0", "font-mono text-[0.6875rem] break-all whitespace-normal text-fg phone:text-[0.75rem]")}>{r.ref}</span>

/** A task's own "↑ after" and "↓ then" under its header (SHEP-103): what it waits for, each with its dot, id, title and %
 *  done; what waits for it, by id. Each opens its task. */
export function TaskDepsHead({ task }: { task: Task }) {
  const d = task.dependencies
  if (!d || (!d.waitsFor.length && !d.unblocks.length)) return null
  return (
    <div data-task-deps className="flex shrink-0 flex-col border-b border-line px-4 py-2 text-[0.75rem] phone:px-5 phone:text-[0.8125rem]">
      {d.waitsFor.length ? (
        // its pills wrap, each at most the line's width: its title gives way, its id and status stay whole
        <div className="flex min-h-[26px] min-w-0 items-start gap-1.5 whitespace-nowrap text-fg2">
          <span className="flex h-[26px] shrink-0 items-center text-fg3">↑ after</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-0.5">
            {d.waitsFor.map((r, i) => (
              <Pill key={`${r.ref}:${i}`} r={r}>
                <Dot s={r.status ?? 'todo'} p={r.status === 'work' ? r.pct : undefined} className="size-3 shrink-0" />
                <Ref r={r} />
                {r.where ? <span className="shrink-0 text-fg3">· {r.where}</span> : null}
                {r.title ? <span className="min-w-0 truncate text-fg2">{r.title}</span> : null}
                {r.status === 'work' && r.pct !== undefined ? <span className="shrink-0 text-work-fg">{Math.round(r.pct)}%</span>
                  : r.external ? <span className="shrink-0 text-fg3">· {r.word ?? r.state}</span> : null}
              </Pill>
            ))}
          </span>
        </div>
      ) : null}
      {d.unblocks.length ? (
        <div className="flex min-h-[26px] min-w-0 items-start gap-1.5 whitespace-nowrap text-fg3">
          <span className="flex h-[26px] shrink-0 items-center">↓ then</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-0.5">
            {d.unblocks.map((r, i) => <Pill key={`${r.ref}:${i}`} r={r}><Ref r={r} solo /></Pill>)}
          </span>
        </div>
      ) : null}
    </div>
  )
}
