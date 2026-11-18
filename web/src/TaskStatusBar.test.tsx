import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskStatusBar } from './TaskStatusBar.tsx'
import { attentionCounts, globalTaskCounts } from './attention.ts'
import type { Snapshot, Task } from '@shared/types.ts'
import { readFileSync } from 'node:fs'

const task = (id: string, status: Task['status'], place = 'open', more = {}) => ({ id, status, place, ...more }) as Task
const snap = (tasks: Task[] = []) => ({ tasks, needs: [{ id: 'ask', chat: 'a', place: 'open' }, { id: 'attention', chat: 'b', place: 'closed' }] }) as Snapshot

test('global totals include unopened spaces and deduplicate task/agent representations', () => {
  const working = task('work', 'work', 'remote', { agent: { status: 'work' }, subagents: [{ status: 'work' }] })
  const s = snap([task('ready', 'ready', 'closed'), working, working, task('archived', 'ready', 'open', { archived: 1 }), task('queued', 'queued')])
  expect(globalTaskCounts(s)).toEqual({ need: 2, ready: 1, working: 1 })
  expect(attentionCounts(s, ['open'])).toEqual({ need: 1, ready: 0 })
  const html = renderToStaticMarkup(<TaskStatusBar snap={s} />)
  expect(html).toContain('all spaces and machines')
  expect(html).toContain('text-ready-fg')
  expect(html).toContain('1</span> Ready')
  expect(html).toContain('1</span> Working')
})

test('Needs you is the Tasks panel rule: a working task with a standing alert counts there, not as Working', () => {
  const at = Date.now()
  const s = { ...snap([task('t1', 'work', 'open'), task('t2', 'ready', 'open')]), needs: [],
    alerts: [{ id: 'a1', chat: 't1/claude', notify: true, at }] } as unknown as Snapshot
  expect(globalTaskCounts(s)).toEqual({ need: 1, ready: 1, working: 0 })
})

test('zero totals keep explicit labels and change when a fresh snapshot arrives', () => {
  const s = { ...snap(), needs: [] }
  const html = renderToStaticMarkup(<TaskStatusBar snap={s} />)
  expect(html).toContain('0</span> Needs you')
  expect(html).toContain('0</span> Ready')
  expect(html).toContain('0</span> Working')
  expect(globalTaskCounts({ ...s, tasks: [task('one', 'work')] }).working).toBe(1)
  expect(globalTaskCounts({ ...s, tasks: [task('one', 'ready')] })).toEqual({ need: 0, ready: 1, working: 0 })
})

test('top-right Tasks panel button keeps navigation without a badge', () => {
  const source = readFileSync(new URL('../plugins/coordinators/client.tsx', import.meta.url), 'utf8')
  const button = source.split('\n').find((s) => s.includes('<PanelButton') && s.includes('id="tasks"'))!
  expect(button).not.toContain('badge=')
  expect(source).toContain('setUI(on ? { sideShut: true } : { side: id, sideShut: false })')
})
