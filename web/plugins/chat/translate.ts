// Translate (SHEP-102, core/translate.js): what this page shows translated, a message's or an artifact version's, and
// its translation as the service made it (service/translate.ts, which keeps it for the window and every other screen).
// A press on the Translate icon shows it (asking the service the first time), the next one hides it again. Nothing
// is asked while the agent still writes a message: its band, and with it the icon, only shows once it is complete.
import { useSyncExternalStore } from 'react'
import { act, useSnap } from '@client/kernel.ts'

export type Shown = {
  shown: boolean
  state: 'loading' | 'done' | 'error'
  /** a message's translations by block (core/translate.js mdBlocks), null where a block has none */
  blocks?: (string | null)[]
  /** an artifact's, by its texts' places (core/translate.js recipeUnits) */
  units?: Record<string, string>
  /** the blocks (or places) that couldn't be translated: a line with Retry under each */
  failed?: (number | string)[]
  error?: string
}

const all = new Map<string, Shown>()
const listeners = new Set<() => void>()
const put = (key: string, s: Shown) => { all.set(key, s); listeners.forEach((l) => l()) }
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

/** a message's or an artifact's translation as shown now, or undefined (never translated here) */
export const useShown = (key: string) => useSyncExternalStore(subscribe, () => all.get(key))

export const messageKey = (chat: string, id: string) => `m:${chat}|${id}`
export const artifactKey = (art: { id: string; machine?: string | null }, v: number) => `a:${art.machine ?? ''}|${art.id}|${v}`

type Ask = { text: string } | { artifact: string; v: number; on: string | null }

async function ask(key: string, body: Ask) {
  const was = all.get(key)
  put(key, { ...was, shown: true, state: 'loading', error: undefined })
  try {
    const r = (await act({ type: 'translate', ...body } as never)) as { ok: boolean; error?: string; blocks?: (string | null)[]; units?: Record<string, string>; failed?: (number | string)[] }
    if (!r?.ok) return put(key, { ...was, shown: true, state: 'error', error: r?.error ?? "Couldn't translate" })
    put(key, { shown: all.get(key)?.shown ?? true, state: 'done', blocks: r.blocks, units: r.units, failed: r.failed ?? [] })
  } catch (e) {
    put(key, { ...was, shown: true, state: 'error', error: `Couldn't translate: ${e instanceof Error ? e.message.slice(0, 160) : 'try again'}` })
  }
}

/** The Translate icon: shows the translation (asking for it once), or hides it when it shows */
export function toggle(key: string, body: Ask) {
  const s = all.get(key)
  if (s?.shown && s.state !== 'loading') return put(key, { ...s, shown: false })
  if (s?.state === 'done' && !s.failed?.length) return put(key, { ...s, shown: true })
  if (s?.state !== 'loading') void ask(key, body)
}

/** Retry, under a failure: asks again (only what failed is sent; the rest comes from the service's copy) */
export const retry = (key: string, body: Ask) => void ask(key, body)

/** Settings › Translation is on (the Translate icon shows only then) */
export function useTranslateOn() {
  const snap = useSnap()
  return !!snap?.settings?.some((s) => s.name === 'Translation' && s.rows.some((r) => r.key === 'translation.on' && r.value === 'on'))
}
