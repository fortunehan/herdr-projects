// Artifacts any agent makes (shepherdr artifact): a card in the chat where it was made, in a sealed frame; full screen
// on a tap, with its versions, Mark up and a box to write to its keeper, so you change it by chatting beside it; and a
// list per place, and one per chat (its ⋯ → Artifacts). A newer version swaps in live: only its data changed, the page takes the new data without a reload.
// Shown in the side panel, it fills a place's Artifacts list (or a task's Artifacts tab) beside the chat.
import clsx from 'clsx'
import { Recipe, UNREADABLE, type Answers } from '@client/screens/Recipe.tsx'
import { enterHint, sendsNow } from '@client/enter.ts'
import * as R from '@core/recipe.js'
import * as M from '@core/markup.js'
import { contentView, keepRecipe, keptSpot, noteAction, noteOnPage, pictureSeed, picturesOnPage, quoteSeed, recipeKey, shownRecipe, tagBox, type Anchor, type On, type PicEl, type Picture, type Scroller, type Seed } from './spots.ts'
import * as CV from '@core/chat-view.js'
import { Markdown } from '@plugins/chat/markdown.tsx'
import { artifactKey, retry as retryTranslate, toggle as toggleTranslate, useShown as useTranslation, useTranslateOn } from '@plugins/chat/translate.ts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  act,
  closeArtifact,
  definePlugin,
  filterOf,
  getState,
  listView,
  matches,
  openArtifact,
  openSplit,
  panesHere,
  placeOf,
  setFilter,
  setUI,
  splitClick,
  taskInMiddle,
  useSnap,
  useStore,
  useUI,
} from '@client/kernel.ts'
import { useDialogFocus } from '@client/focus.ts'
import { useFullscreen } from '@client/fullscreen.ts'
import { useMotion } from '@client/motion.ts'
import { isDark, useDark } from '@client/theme.ts'
import {
  BackIcon,
  ChatIcon,
  CheckIcon,
  DownIcon,
  FitIcon,
  NextIcon,
  dimmed,
  FilterBox,
  ic,
  IconButton,
  List,
  MarkBadge,
  MarkUpIcon,
  PageIcon,
  PanelIcon,
  Row,
  RowText,
  TextBox,
  TranslateIcon,
  UnfitIcon,
  UpIcon,
  XIcon,
} from '@client/ui.tsx'
import type { Action, Artifact, ArtifactVersion, Chat, Message, Task } from '@shared/types.ts'
import { titleInTask } from '@core/task-artifacts.js'

const { withIds, preview } = R as any
const { WORDS, artifactLine } = CV as any
const { MARKUP, NOTES_MAX, markupHint, markupSent, markupCount, draftKey, draftText, readDraft, outgoing, pictureUnder, placeNote } = M as any

export type Pick = { text: string; selector: string; component?: string; x: number; y: number }

const frameUrl = (id: string, v: number, full: boolean, device: string, part = '', theme = '') =>
  `api/artifacts/${encodeURIComponent(id)}${part}?v=${v}${full ? '&full=1' : ''}&device=${device}${theme ? `&theme=${theme}` : ''}`

/** how long ago, as the window says it: "just now", "5m ago", "2h ago", "3d ago" */
export function ago(ms: number) {
  const m = Math.floor((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`
}

/** which version, who made it and when: "v3 · Claude Code · 2h ago" (the window's) */
const detailOf = (a: Artifact) => [`v${a.v}`, a.by, a.at ? ago(a.at) : null].filter(Boolean).join(' · ')

/** the version stepper the window's artifact bars have: ‹ v2 of 5 ›, then "· Latest ›" while an older one shows; one
 *  version only: "v3" in the sidebar's head, "v3 · 2h ago" in the viewer's bar */
function Stepper({ art, shown, onStep, bar }: { art: Artifact; shown: number; onStep: (n: number | undefined) => void; bar: 'sidebar' | 'viewer' }) {
  const kept = [...art.versions.map((x) => x.n)].sort((a, b) => a - b)
  const latest = art.v
  const older = shown < latest
  const prev = kept.filter((n) => n < shown).pop()
  const next = kept.find((n) => n > shown)
  const me = art.versions.find((x) => x.n === shown)
  const when = me?.at ? ago(me.at) : undefined
  if (kept.length <= 1 && !older)
    return <div className="shrink-0 text-xs text-fg2 tabular-nums phone:text-[0.8125rem]">v{shown}{bar === 'viewer' && when ? ` · ${when}` : ''}</div>
  return (
    <div className="flex shrink-0 items-center text-xs tabular-nums phone:text-[0.8125rem]">
      <IconButton label={prev ? `v${prev}` : `v${shown}`} disabled={!prev} className="rounded-full! disabled:opacity-40" onClick={() => prev && onStep(prev)}>
        <BackIcon className={ic} />
      </IconButton>
      <span className={clsx('px-0.5', older ? 'text-fg' : 'text-fg2')}>v{shown} of {latest}</span>
      <IconButton label={next ? `v${next}` : `v${shown}`} disabled={!next} className="rounded-full! disabled:opacity-40" onClick={() => next && onStep(next === latest ? undefined : next)}>
        <NextIcon className={ic} />
      </IconButton>
      {older ? (
        <>
          <span className="px-1 text-fg3">·</span>
          <button type="button" className="press-dim rounded-full px-1.5 py-1 font-medium text-focus hover:bg-hover" onClick={() => onStep(undefined)}>Latest ›</button>
        </>
      ) : null}
    </div>
  )
}

type Spot = { x: number; y: number; w: number; h: number }
/** a numbered note: its spot as fractions of the whole content and of the tag it starts on (anchor, SHEP-115), its
 *  words and, on a recipe, the blocks it is on (SHEP-113); on selected words their quote and the boxes they are
 *  highlighted in, on a picture the picture and the spot in it (SHEP-114), as fractions too */
type Note = Spot & { text: string; on?: On; anchor?: Anchor; quote?: { text: string; before: string; after: string; rects: Spot[] }; picture?: Picture & { spot?: Spot } }

/** the notes that went this session, by artifact version: they stay drawn, faded, on what they marked (SHEP-115) */
const sentNotes = new Map<string, Note[]>()

/** what a note is about, in the notes list: the quoted words or the picture's name; none for a spot */
const aboutOf = (n: Note) => (n.quote ? `“${n.quote.text}”` : n.picture ? `Picture ${n.picture.file}` : '')

const loadDraft = (id: string, v: number): { notes: Note[]; general: string } => {
  try { return readDraft(localStorage.getItem(draftKey(id, v))) } catch { return { notes: [], general: '' } }
}
const keepDraft = (id: string, v: number, notes: Note[], general: string) => {
  try {
    const t = draftText(notes, general)
    if (t) localStorage.setItem(draftKey(id, v), t)
    else localStorage.removeItem(draftKey(id, v))
  } catch { /* a private window: the draft lasts while Mark up is open */ }
}

/** Mark up, as the window's (mods/artifacts/markup.js): a dashed edge over the artifact; click or tap spots, or drag
 *  over areas, each a numbered note with its own words (the list beside them edits or deletes each one), plus words
 *  about all of it, and Send all gives them to the agent that keeps it as one message, each spot in words (SHEP-88).
 *  The notes are kept on this device per version until they went. Esc closes a note, then ends. Laid over the artifact
 *  in the viewer and in the sidebar. */
function MarkupLayer({ art, v, onEnd, seed, onSeeded }: { art: Artifact; v: number; onEnd: () => void; seed?: Seed | null; onSeeded?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const generalRef = useRef<HTMLTextAreaElement>(null)
  const device = useUI((u) => u.device)
  const [draft] = useState(() => loadDraft(art.id, v))
  const [notes, setNotes] = useState<Note[]>(draft.notes)
  const [general, setGeneral] = useState(draft.general)
  const [sel, setSel] = useState<number | null>(null)
  const [open, setOpen] = useState(true)
  // the content moves under the layer (scrolled, reflowed): each move draws the notes again where it is now
  const [, moved] = useState(0)
  const [press, setPress] = useState<{ x0: number; y0: number; x1: number; y1: number; moved: boolean } | null>(null)
  const [said, setSaid] = useState('')
  const [failed, setFailed] = useState(false)
  const [sending, setSending] = useState(false)
  const keeper = art.keeper || 'the agent'
  const phone = device === 'phone'
  const sentKey = recipeKey(art.id, v, art.machine)
  const sent = sentNotes.get(sentKey) ?? []
  const page = () => ref.current?.parentElement ?? null
  const scroller = () => page()?.querySelector<HTMLElement>('[data-recipe-scroll]') ?? null
  const origin = () => ref.current!.getBoundingClientRect()
  useEffect(() => {
    const el = ref.current, host = el?.parentElement
    if (!el || !host) return
    const again = () => moved((n) => n + 1)
    const o = new ResizeObserver(again)
    o.observe(el)
    // the recipe's content may come after the layer (Loading…) and changes height as pictures load
    const m = new MutationObserver(() => {
      const c = scroller()?.firstElementChild
      if (c) o.observe(c)
      again()
    })
    m.observe(host, { childList: true, subtree: true })
    const c = scroller()?.firstElementChild
    if (c) o.observe(c)
    host.addEventListener('scroll', again, true)
    again()
    return () => { o.disconnect(); m.disconnect(); host.removeEventListener('scroll', again, true) }
  }, [])
  useEffect(() => { keepDraft(art.id, v, notes, general) }, [art.id, v, notes, general])
  // Comment on selected words or a picture (SHEP-114): Mark up opens with that note started
  useEffect(() => {
    const el = ref.current
    if (!seed || !el) return
    onSeeded?.()
    if (notes.length >= NOTES_MAX) {
      setFailed(true)
      return setSaid(`At most ${NOTES_MAX} notes at once: send these first.`)
    }
    const o = el.getBoundingClientRect()
    const { rects, ...kept } = keptSpot(page(), o, contentView(scroller() as Scroller | null, o), seed.spot, seed.quote?.rects)
    const quote = seed.quote ? { ...seed.quote, rects: rects ?? [] } : undefined
    setNotes([...notes, { ...kept, text: '', ...(seed.on ? { on: seed.on } : {}), ...(quote ? { quote } : {}), ...(seed.picture ? { picture: seed.picture } : {}) }])
    pick(notes.length)
  }, [seed])
  const focusGeneral = () => !phone && setTimeout(() => generalRef.current?.focus(), 0)
  const focusNote = () => !phone && setTimeout(() => ref.current?.querySelector<HTMLTextAreaElement>('textarea[data-note]')?.focus(), 0)
  useEffect(() => { if (!seed) focusGeneral() }, [])
  const at = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)) }
  }
  const box = (p: NonNullable<typeof press>): Spot => ({ x: Math.min(p.x0, p.x1), y: Math.min(p.y0, p.y1), w: Math.abs(p.x1 - p.x0), h: Math.abs(p.y1 - p.y0) })
  const fresh = () => {
    if (said && !sending) {
      setSaid('')
      setFailed(false)
    }
  }
  const pick = (i: number | null) => {
    setSel(i)
    setOpen(true)
    if (i !== null) focusNote()
  }
  const remove = (i: number) => {
    setNotes(notes.filter((_, j) => j !== i))
    setSel(sel === null || sel < i ? sel : sel === i ? null : sel - 1)
  }
  // where the content is now, and each tag's box on it, from the layer's top left
  const o = ref.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 }
  const view = contentView(scroller() as Scroller | null, o)
  const host = page()
  const boxOf = (key: string) => (host ? tagBox(host, o, key) : null)
  const out = outgoing(notes, general, view)
  const send = async () => {
    if (!out || sending) return
    setSending(true)
    setFailed(false)
    setSaid(MARKUP.sending)
    const base = { place: art.place, artifact: art.id, v }
    const msg: Action = noteAction(out, base)
    const r = (await act(msg).catch((e: Error) => ({ ok: false, error: e?.message }))) as { ok?: boolean; error?: string }
    setSending(false)
    if (r.ok === false) {
      setFailed(true)
      return setSaid(r.error || MARKUP.failed)
    }
    sentNotes.set(sentKey, [...sent, ...notes])
    setNotes([])
    setGeneral('')
    setSel(null)
    setSaid(markupSent(keeper))
  }
  // a touch screen taps where the window clicks
  const hint = device === 'desktop' ? markupHint(keeper) : markupHint(keeper).replace(/^Click/, 'Tap')
  const cur = sel !== null ? notes[sel] : null
  const line = said || (cur ? (cur.quote ? MARKUP.quote : cur.picture ? MARKUP.picture : cur.w || cur.h ? MARKUP.area : MARKUP.spot) : notes.length ? MARKUP.more.replace(/^Click/, device === 'desktop' ? 'Click' : 'Tap') : hint)
  const drawn = press?.moved ? box(press) : null
  const keys = (e: React.KeyboardEvent, enter: () => void, esc: () => void) => {
    if (sendsNow(e, getState().ui.keyboard)) {
      e.preventDefault()
      enter()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      esc()
    }
  }
  const boxCls = 'max-h-32 min-h-8 min-w-0 flex-1 rounded-row bg-bg px-2.5 py-1.5 shadow-[inset_0_0_0_1px_var(--line2)] outline-none placeholder:text-fg3 focus:shadow-[inset_0_0_0_1.5px_var(--focus)] phone:min-h-11 phone:text-[1rem]'
  return (
    <div
      ref={ref}
      className="@container absolute inset-0 cursor-crosshair touch-none rounded-[inherit] border-2 border-dashed border-focus"
      // the wheel scrolls the artifact under the layer, its notes with it
      onWheel={(e) => scroller()?.scrollBy({ left: e.deltaX, top: e.deltaY })}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        if (notes.length >= NOTES_MAX) {
          setFailed(true)
          return setSaid(`At most ${NOTES_MAX} notes at once: send these first.`)
        }
        const q = at(e)
        e.currentTarget.setPointerCapture(e.pointerId)
        setPress({ x0: q.x, y0: q.y, x1: q.x, y1: q.y, moved: false })
        setSaid('')
        setFailed(false)
      }}
      onPointerMove={(e) => {
        if (!press) return
        const q = at(e)
        setPress({ ...press, x1: q.x, y1: q.y, moved: press.moved || Math.abs(q.x - press.x0) + Math.abs(q.y - press.y0) > 4 })
      }}
      onPointerUp={() => {
        if (!press) return
        const s = press.moved ? box(press) : { x: press.x0, y: press.y0, w: 0, h: 0 }
        setPress(null)
        // on a recipe: the picture it is on, named with the spot in it (SHEP-114), else the blocks under it, from the
        // recipe drawn beneath the layer
        const layer = ref.current!
        const recipe = shownRecipe(recipeKey(art.id, v, art.machine)), at0 = origin()
        const pic = layer.parentElement && recipe ? pictureUnder(picturesOnPage(layer.parentElement, at0, recipe), s) : null
        const on = !pic && layer.parentElement ? noteOnPage(layer.parentElement, at0, recipe, s) : null
        // kept on the content and the tag under it, so it scrolls and reflows with them (SHEP-115)
        const kept = keptSpot(recipe ? page() : null, at0, contentView(scroller() as Scroller | null, at0), s)
        setNotes([...notes, { ...kept, text: '', ...(on ? { on } : {}), ...(pic ? { picture: { ...pic.picture, spot: pic.spot } } : {}) }])
        pick(notes.length)
      }}
    >
      {/* the notes on what they marked, clipped to the layer as the content scrolls past it */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
        {sent.map((n, i) => <NoteMark key={`s${i}`} at={placeNote(n, boxOf, view)} sent />)}
        {notes.map((n, i) => <NoteMark key={i} at={placeNote(n, boxOf, view)} n={i + 1} on={sel === i} onPick={() => pick(i)} />)}
      </div>
      {drawn ? (
        <span className="pointer-events-none absolute rounded-[4px] border-2 border-focus bg-[color-mix(in_srgb,var(--focus)_12%,transparent)]" style={{ left: drawn.x, top: drawn.y, width: drawn.w, height: drawn.h }} />
      ) : null}
      {press ? <MarkBadge x={press.moved ? Math.min(press.x0, press.x1) : press.x0} y={press.moved ? Math.min(press.y0, press.y1) : press.y0} n={notes.length + 1} /> : null}
      {press ? null : (
        // the window's markup card: what it's about, the numbered notes, the words about all of it and Send all
        <div
          className="absolute inset-x-2.5 bottom-[max(env(safe-area-inset-bottom),--spacing(2.5))] flex max-h-[calc(100%-1.25rem)] cursor-default flex-col gap-1.5 rounded-box bg-bg p-2 shadow-dialog @min-[40rem]:left-auto @min-[40rem]:w-[22rem]"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <div className="flex items-start gap-2 px-0.5 text-[0.75rem] phone:text-[0.8125rem]">
            <p className={clsx('min-w-0 flex-1 text-pretty', failed ? 'text-need-fg' : 'text-fg2')} role={said ? 'status' : undefined}>{line}</p>
            {notes.length ? (
              <button
                type="button"
                aria-expanded={open}
                className="flex shrink-0 items-center gap-0.5 font-medium text-focus hover:underline"
                onClick={() => setOpen(!open)}
              >
                {markupCount(notes.length)}
                <DownIcon className={clsx('size-3.5 transition-transform', open ? '' : '-rotate-90')} />
              </button>
            ) : null}
          </div>
          {open && notes.length ? (
            <ol aria-label="Notes" className="flex min-h-0 flex-col gap-1 overflow-y-auto">
              {notes.map((n, i) => (
                <li key={i} className={clsx('flex items-start gap-1.5 rounded-row px-0.5 py-0.5', sel === i ? 'bg-hover' : '')}>
                  <span className="mt-1.5 grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-focus px-[5px] text-[0.6875rem] font-semibold text-white tabular-nums phone:mt-3 phone:h-[22px] phone:min-w-[22px] phone:text-[0.8125rem]">{i + 1}</span>
                  <div className="flex min-w-0 flex-1 flex-col">
                  {aboutOf(n) ? <span data-about="" className="truncate px-1.5 pt-0.5 text-[0.75rem] text-fg2 phone:text-[0.8125rem]">{aboutOf(n)}</span> : null}
                  {sel === i ? (
                    <TextBox
                      label={`Note ${i + 1}`}
                      data-note=""
                      enterKeyHint="done"
                      value={n.text}
                      onChange={(t) => {
                        setNotes(notes.map((x, j) => (j === i ? { ...x, text: t } : x)))
                        fresh()
                      }}
                      onKeyDown={(e) => keys(e, () => { setSel(null); focusGeneral() }, () => { setSel(null); focusGeneral() })}
                      placeholder={MARKUP.notePlaceholder}
                      className={boxCls}
                    />
                  ) : (
                    <button
                      type="button"
                      className={clsx('min-h-8 min-w-0 flex-1 truncate rounded-row px-1.5 text-left text-[0.8125rem] hover:bg-hover phone:min-h-11 phone:text-[0.9375rem]', n.text.trim() ? 'text-fg' : 'text-fg3')}
                      onClick={() => pick(i)}
                    >
                      {n.text.trim() || MARKUP.notePlaceholder}
                    </button>
                  )}
                  </div>
                  <IconButton label={`${MARKUP.remove} ${i + 1}`} className="shrink-0 rounded-full!" onClick={() => remove(i)}>
                    <XIcon className={ic} />
                  </IconButton>
                </li>
              ))}
            </ol>
          ) : null}
          <div className="flex items-end gap-1.5">
            <TextBox
              label={notes.length ? 'About all of it' : 'Note'}
              ref={generalRef}
              enterKeyHint={enterHint()}
              value={general}
              onChange={(t) => {
                setGeneral(t)
                fresh()
              }}
              onFocus={() => setSel(null)}
              onKeyDown={(e) => keys(e, () => void send(), () => onEnd())}
              placeholder={notes.length ? MARKUP.general : MARKUP.placeholder}
              className={boxCls}
            />
            {notes.length ? (
              <button
                type="button"
                disabled={!out || sending}
                onClick={() => void send()}
                className={clsx('press-dim relative flex h-8 shrink-0 items-center gap-1 rounded-row bg-fg pr-2.5 pl-2 text-[0.8125rem] font-medium text-bg after:absolute after:-inset-1.5 phone:h-11 phone:text-[0.9375rem]', dimmed)}
              >
                <UpIcon className={ic} />
                {MARKUP.sendAll}
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={!out || sending}
                onClick={() => void send()}
                className={clsx('press-dim relative grid size-8 shrink-0 place-items-center rounded-row bg-fg text-bg after:absolute after:-inset-1.5 phone:size-11', dimmed)}
              >
                <UpIcon className={ic} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** A note's mark where it is now (placeNote, px of the layer): selected words highlighted with the number at their
 *  start, else its area outlined and its number at the top left. A sent note's is faded, with a tick for its number. */
function NoteMark({ at, n = 0, on, onPick, sent }: { at: Spot & { rects: Spot[] }; n?: number; on?: boolean; onPick?: () => void; sent?: boolean }) {
  const first = at.rects[0] ?? at
  const badge = sent ? (
    <span data-sent-mark="" className="absolute grid size-[18px] place-items-center rounded-full bg-fg2 text-bg phone:size-[22px]" style={{ left: first.x - 9, top: first.y - 9 }}>
      <CheckIcon className="size-3" />
    </span>
  ) : (
    <span className="pointer-events-auto"><MarkBadge x={first.x} y={first.y} n={n} on={on} onPick={onPick} /></span>
  )
  if (at.rects.length)
    return (
      <span className={sent ? 'opacity-80' : undefined}>
        {at.rects.map((r, j) => (
          <span key={j} data-quote-mark="" className={clsx('absolute rounded-[2px]', on ? 'bg-[color-mix(in_srgb,var(--focus)_32%,transparent)]' : 'bg-[color-mix(in_srgb,var(--focus)_20%,transparent)]')}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
        ))}
        {badge}
      </span>
    )
  return (
    <span className={sent ? 'opacity-80' : undefined}>
      {at.w || at.h ? (
        <span data-note-box="" className={clsx('absolute rounded-[4px] border-2', sent ? 'border-dashed border-fg2' : 'border-focus', on ? 'bg-[color-mix(in_srgb,var(--focus)_20%,transparent)]' : 'bg-[color-mix(in_srgb,var(--focus)_10%,transparent)]')}
          style={{ left: at.x, top: at.y, width: at.w, height: at.h }} />
      ) : null}
      {badge}
    </span>
  )
}

/** The area under an artifact's bar (the panel's, the viewer's): the artifact, Mark up laid over it while marking, and
 *  otherwise Comment beside selected words or on a picture of a recipe, which opens Mark up with that note started
 *  (SHEP-114). can: Mark up can show here (not in a page-filling full screen). */
function Marked({ art, v, marking, can = true, onMark, onEnd, children }: { art: Artifact; v: number; marking: boolean; can?: boolean; onMark: () => void; onEnd: () => void; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  const [seed, setSeed] = useState<Seed | null>(null)
  return (
    <div ref={host} className="relative min-h-0 flex-1">
      {children}
      {can && !marking ? <CommentChip host={host} art={art} v={v} onSeed={(s) => { setSeed(s); onMark() }} /> : null}
      {can && marking ? <MarkupLayer key={`${art.id}:${v}`} art={art} v={v} seed={seed} onSeeded={() => setSeed(null)} onEnd={onEnd} /> : null}
    </div>
  )
}

/** the words selected in a recipe under host, as quoteSeed reads them; null when none are */
function selectedIn(host: HTMLElement) {
  const sel = getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  const elOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)
  const start = elOf(r.startContainer)?.closest('[data-rp]') ?? null, end = elOf(r.endContainer)?.closest('[data-rp]') ?? null
  if (!start || !end || !host.contains(start) || !host.contains(end)) return null
  // the text of the selection's block before it, and of the block it ends in after it
  const before = document.createRange(), after = document.createRange()
  before.selectNodeContents(start)
  before.setEnd(r.startContainer, r.startOffset)
  after.selectNodeContents(end)
  after.setStart(r.endContainer, r.endOffset)
  const rects = Array.from(r.getClientRects()).filter((b) => b.width > 0 && b.height > 0)
  // the chip goes under the end of the last line
  return { text: r.toString(), prefix: before.toString(), rest: after.toString(), rects, start, end, last: rects[rects.length - 1] ?? r.getBoundingClientRect() }
}

/** Comment: a small button next to selected words of a recipe (below them, out of the way of a phone's own menu), or
 *  on a picture the pointer is over; it starts a note on them in Mark up. */
function CommentChip({ host, art, v, onSeed }: { host: React.RefObject<HTMLDivElement | null>; art: Artifact; v: number; onSeed: (s: Seed) => void }) {
  // x: where its right edge goes (the selection's end, the picture's right); kept inside the host by its width
  const [chip, setChip] = useState<{ x: number; y: number; pic: PicEl | null } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => { if (btn.current) setW(btn.current.offsetWidth) }, [chip?.pic, !!chip])
  const recipe = () => shownRecipe(recipeKey(art.id, v, art.machine))
  useEffect(() => {
    const el = host.current
    if (!el) return
    const words = () => {
      const s = selectedIn(el)
      if (!s || !recipe() || !s.text.trim()) return setChip((c) => (c && !c.pic ? null : c))
      const o = el.getBoundingClientRect()
      setChip({ x: Math.min(o.width - 8, s.last.right - o.left), y: Math.min(o.height - 48, s.last.bottom - o.top + 6), pic: null })
    }
    // a picture under a pointer that can hover (a touch screen comments on one in Mark up)
    const over = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const t = e.target as Element | null
      if (t?.closest?.('[data-comment]')) return
      const img = t?.closest?.('img[data-pic]') as HTMLImageElement | null
      if (img && recipe() && el.contains(img)) {
        const r = img.getBoundingClientRect(), o = el.getBoundingClientRect()
        return setChip((c) => (c && !c.pic ? c : { x: r.right - o.left - 8, y: Math.max(8, r.top - o.top + 8), pic: img }))
      }
      setChip((c) => (c?.pic ? null : c))
    }
    const scrolled = () => setChip(null)
    document.addEventListener('selectionchange', words)
    el.addEventListener('pointerover', over)
    el.addEventListener('scroll', scrolled, true)
    return () => {
      document.removeEventListener('selectionchange', words)
      el.removeEventListener('pointerover', over)
      el.removeEventListener('scroll', scrolled, true)
    }
  }, [art.id, v])
  if (!chip) return null
  const go = () => {
    const el = host.current
    if (!el) return
    const o = el.getBoundingClientRect()
    const s = chip.pic ? pictureSeed(chip.pic, o, recipe()) : (() => { const x = selectedIn(el); return x ? quoteSeed(x, o, recipe()) : null })()
    setChip(null)
    if (!s) return
    getSelection()?.removeAllRanges()
    onSeed(s)
  }
  return (
    <button
      type="button"
      ref={btn}
      data-comment={chip.pic ? 'picture' : 'words'}
      // pressing it must not drop the selection it comments on
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={go}
      className={clsx('press-dim absolute z-10 flex h-7 items-center gap-1 rounded-full bg-focus pr-2.5 pl-2 text-[0.8125rem] font-medium whitespace-nowrap text-white shadow-dialog phone:h-10 phone:pr-3.5 phone:pl-3 phone:text-[0.9375rem]')}
      style={{ left: Math.max(8, chip.x - w), top: chip.y }}
    >
      <ChatIcon className={ic} />
      {chip.pic ? MARKUP.commentPicture : MARKUP.comment}
    </button>
  )
}

/** the version whose HTML a version shows (one that brought only data shows the HTML before it) */
const htmlOf = (a: Artifact, n: number) => a.versions.find((x) => x.n === n)?.html ?? n

/* ---------- an artifact in the side panel ---------- */

const SHOWN = 'shepherdr.panelArtifacts'
/** the artifact each side panel shows, by "place:<id>" (its Artifacts list) or "chat:<key>" (a task's Artifacts tab),
 *  remembered on this device */
let shownIn: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(SHOWN) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
})()
const shownListeners = new Set<() => void>()

/** the last one each list showed: its row stays marked after ‹ Artifacts, as the window's */
const lastShown: Record<string, string> = {}

function setShown(key: string, id: string | null) {
  if (id) lastShown[key] = id
  const { [key]: _, ...rest } = shownIn
  shownIn = id ? { ...rest, [key]: id } : rest
  try {
    localStorage.setItem(SHOWN, JSON.stringify(shownIn))
  } catch {
    /* private window: the list shows again next time */
  }
  shownListeners.forEach((l) => l())
}

/** the artifact a side panel shows, while it is still kept */
function useShown(key: string) {
  const id = useSyncExternalStore(
    (l) => {
      shownListeners.add(l)
      return () => shownListeners.delete(l)
    },
    () => shownIn[key],
  )
  return useSnap()?.artifacts?.find((a) => a.id === id)
}

/** Show an artifact beside the chat: in the Artifacts list on the right (whatever its chips show; a phone's
 *  Artifacts tab), or, on a desktop where an open task's chat covers that list, in the task's own Artifacts tab (a
 *  phone or tablet has no column for it: the task gives way to the list) */
export function showInPanel(id: string) {
  const { ui, snap } = getState()
  if (!snap) return
  if (ui.viewer) closeArtifact()
  setShown(`list:${listView(ui, snap).key}`, id)
  setUI(ui.device === 'phone' ? { task: null, tab: 'artifacts', pick: null, plus: null, menu: false } : { task: ui.task && !taskInMiddle(ui, snap) ? null : ui.task, side: 'artifacts' })
}

/** Mark up / Done, one look in the viewer's bar and the panel's (and the window's, mods/artifacts/main.js and
 *  chat-image/artifact-bar.js): a pointer clicking a spot and its name, round like every header button. round: on a
 *  phone's bar it is a grey circle with only the pointer, like Close beside it. While marking it says Done with a tick,
 *  tinted the blue of the frame round what you mark. */
function MarkUpButton({ on, onClick, round }: { on: boolean; onClick: () => void; round?: boolean }) {
  return (
    <button
      type="button"
      aria-label={on ? 'Done' : 'Mark up'}
      aria-pressed={on}
      onClick={onClick}
      className={clsx(
        'hit press-dim inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-[0.8125rem] font-medium whitespace-nowrap coarse:h-9 phone:h-11 phone:gap-2 phone:pr-4 phone:pl-3.5 phone:text-[0.9375rem]',
        on ? 'bg-[color-mix(in_srgb,var(--focus)_14%,var(--bg))] text-fg' : 'text-fg2 hover:bg-hover hover:text-fg',
        round && !on && 'phone:w-11 phone:justify-center phone:bg-bubble phone:px-0',
      )}
    >
      {on ? <CheckIcon className={clsx(ic, 'text-focus')} /> : <MarkUpIcon className={ic} />}
      <span className={clsx(round && !on && 'phone:hidden')}>{on ? 'Done' : 'Mark up'}</span>
    </button>
  )
}

/** Full screen / Exit full screen, in the viewer's bar and the panel's (SHEP-90): the browser's own full screen of the
 *  artifact, or where it has none (an iPhone) the artifact over the whole page (useFullscreen); Esc leaves it too */
function FullButton({ on, onClick, className }: { on: boolean; onClick: () => void; className?: string }) {
  return (
    <IconButton label={on ? 'Exit full screen' : 'Full screen'} pressed={on} onClick={onClick} className={clsx('rounded-full!', className)}>
      {on ? <UnfitIcon className={ic} /> : <FitIcon className={ic} />}
    </IconButton>
  )
}

/** Translate / Hide translation (SHEP-102), in the viewer's bar and the panel's: the whole version translated, each
 *  text block's translation under it; shown only for a recipe while Settings › Translation is on */
function TranslateButton({ art, v, className }: { art: Artifact; v: number; className?: string }) {
  const on = useTranslateOn()
  const s = useTranslation(artifactKey(art, v))
  const kind = art.versions.find((x) => x.n === v)?.kind ?? art.kind
  if (!on || kind !== 'recipe') return null
  const shown = !!s?.shown
  return (
    <IconButton label={shown ? 'Hide translation' : 'Translate'} pressed={shown} className={clsx('rounded-full!', shown && 'text-fg', className)}
      onClick={() => toggleTranslate(artifactKey(art, v), { artifact: art.id, v, on: art.machine ?? null })}>
      <TranslateIcon className={ic} />
    </IconButton>
  )
}

/** An artifact in the side panel, under the window's sidebar bar: ‹ Artifacts back to the list, its title, which
 *  version (‹ v2 of 5 ›, · Latest ›), and Mark up / Done, which marks it up right there */
function PanelArtifact({ art, onBack }: { art: Artifact; onBack: () => void }) {
  const [v, setV] = useState<number | undefined>(undefined)
  const [marking, setMarking] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const full = useFullscreen(ref)
  const shown = v && art.versions.some((x) => x.n === v) ? v : art.v
  return (
    <div ref={ref} role="region" aria-label={art.title}
      className={clsx('flex h-full min-h-0 flex-1 flex-col bg-bg', full.how === 'page' && 'fixed inset-0 z-50 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]')}>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line py-1 pr-2 pl-1 coarse:py-0.5">
        <button type="button" onClick={() => { setMarking(false); if (full.on) full.toggle(); onBack() }} className="press-dim flex h-8 shrink-0 items-center gap-0.5 rounded-full pr-2 pl-1 text-[0.8125rem] text-fg2 hover:bg-hover hover:text-fg phone:h-11 phone:text-[0.9375rem]">
          <BackIcon className={ic} />
          Artifacts
        </button>
        <div className="min-w-0 flex-1 truncate font-semibold">{art.title}</div>
        <Stepper art={art} shown={shown} bar="sidebar" onStep={(n) => { setMarking(false); setV(n) }} />
        <TranslateButton art={art} v={shown} />
        <MarkUpButton on={marking} onClick={() => setMarking(!marking)} />
        <FullButton on={full.on} onClick={full.toggle} />
      </div>
      <Marked art={art} v={shown} marking={marking} onMark={() => setMarking(true)} onEnd={() => setMarking(false)}>
        <div className="absolute inset-0">
          <ArtifactFrame art={art} v={shown} full fullScreen={full.on} />
        </div>
      </Marked>
    </div>
  )
}

/** An artifact filling a split view's pane, at its latest */
function SplitArtifact({ artifactId }: { artifactId: string }) {
  const art = useSnap()?.artifacts?.find((a) => a.id === artifactId)
  return art ? (
    <div className="absolute inset-0">
      <ArtifactFrame art={art} v={art.v} full />
    </div>
  ) : null
}

/** a person just tapped or typed, and not in another frame: a tap inside a frame marks the app as touched too (the
 *  browser's user activation), a script can't; where the browser can't tell, the frame must have the focus */
function touchedNow(frame: HTMLIFrameElement | null) {
  const other = document.activeElement instanceof HTMLIFrameElement && document.activeElement !== frame
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return !other && (ua ? ua.isActive : document.activeElement === frame)
}

const onResize = (l: () => void) => {
  addEventListener('resize', l)
  return () => removeEventListener('resize', l)
}
/** the window's height; on a touch screen at its tallest for its width, so a keyboard or a browser's toolbar coming
 *  and going doesn't resize every card in the chat (turning it does) */
let tallest = { w: 0, h: 0 }
const useWindowHeight = () =>
  useSyncExternalStore(onResize, () => {
    if (!matchMedia('(pointer: coarse)').matches) return innerHeight
    if (innerWidth !== tallest.w || innerHeight > tallest.h) tallest = { w: innerWidth, h: innerHeight }
    return tallest.h
  })

/** how tall each page last said it is, so a card scrolled back into the chat doesn't jump */
const heights = new Map<string, number>()

/** Shepherdr 3.1: a recipe artifact is drawn here as the web's own HTML (Recipe.tsx); a custom panel only the Herdr
 *  window runs shows the window's picture of it; a 2.1 page (none here now) still has its frame. Each version by its own
 *  kind: a converted one was a panel before it became a recipe. */
export function ArtifactFrame(p: Parameters<typeof PageFrame>[0]) {
  const kind = p.art.versions.find((x) => x.n === p.v)?.kind ?? p.art.kind
  if (kind === 'recipe') return <RecipeFrame {...p} />
  if (kind === 'gpui') return <WindowPicture {...p} />
  return <PageFrame {...p} />
}

/** A recipe of the version shown, its pictures from the service (Mark up lays its layer over it: MarkupLayer). */
function RecipeFrame({ art, v, full, fullScreen }: Parameters<typeof PageFrame>[0]) {
  const [recipe, setRecipe] = useState<{ blocks: unknown[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Answers>({})
  // SHEP-102: its translation while the bar's Translate shows it
  const tkey = artifactKey(art, v)
  const ts = useTranslation(tkey)
  const tr = ts?.shown ? { units: ts.units, failed: ts.failed as string[] | undefined, loading: ts.state === 'loading', error: ts.state === 'error' ? ts.error : undefined,
    retry: () => retryTranslate(tkey, { artifact: art.id, v, on: art.machine ?? null }) } : undefined
  // another machine's: the service reads its files there
  const on = art.machine ? `&on=${encodeURIComponent(art.machine)}` : ''
  useEffect(() => {
    let gone = false
    setRecipe(null)
    setError(null)
    setAnswers({})
    fetch(`api/artifacts/${encodeURIComponent(art.id)}/recipe?v=${v}${on}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('gone'))))
      .then((r) => !gone && setRecipe(withIds(r)), () => !gone && setError(UNREADABLE))
    // the person's answers kept with this version (SHEP-87): none yet is {}
    fetch(`api/artifacts/${encodeURIComponent(art.id)}/answers?v=${v}${on}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((a) => !gone && a && typeof a === 'object' && setAnswers(a as Answers), () => undefined)
    return () => { gone = true }
  }, [art.id, v, on])
  // Mark up laid over it names the blocks a note is on from this recipe (SHEP-113); a version's recipe never changes,
  // and the panel and the viewer may both show it, so it stays kept
  useEffect(() => { if (recipe) keepRecipe(recipeKey(art.id, v, art.machine), recipe) }, [art.id, v, art.machine, recipe])
  if (error) return <p className="p-4 text-fg3">{error}</p>
  if (!recipe) return <p className="p-4 text-fg3">Loading…</p>
  return (
    <div data-recipe-scroll="" className={clsx('overflow-y-auto p-4 phone:p-5', full ? 'h-full' : 'max-h-[70dvh]')}>
      <Recipe recipe={recipe} asset={(src) => `api/artifacts/${encodeURIComponent(art.id)}/file/${src.split('/').map(encodeURIComponent).join('/')}?v=${v}${on}`}
        answers={answers} tr={tr} fullScreen={fullScreen}
        reply={(text, keep) => act({ type: 'artifact-send', place: art.place, artifact: art.id, v, text, ...(keep ? { answer: keep.key, value: keep.value } : {}) })} />
    </div>
  )
}

/** A custom panel, for the Herdr window only: the picture the window last took of it (herdr-artifact picture, as it
 *  showed it), this version's or else the newest before it, with where to open it small underneath. */
function WindowPicture({ art, v, full }: Parameters<typeof PageFrame>[0]) {
  const shot = (x: ArtifactVersion) => (x.kind ?? art.kind) === 'gpui' && !!x.picture
  // newest first
  const pic = art.versions.find((x) => x.n === v && shot(x)) ?? art.versions.find((x) => x.n < v && shot(x))
  const on = art.machine ? `&on=${encodeURIComponent(art.machine)}` : ''
  if (!pic) return <p className="p-4 text-pretty text-fg3">Made for the Herdr window: open it there.</p>
  return (
    <figure className={clsx('flex flex-col gap-1.5 overflow-y-auto p-4 phone:p-5', full ? 'h-full' : 'max-h-[70dvh]')}>
      <img src={`api/artifacts/${encodeURIComponent(art.id)}/file/.window.png?v=${pic.n}&t=${pic.picture}${on}`} alt={art.title}
        className="h-auto max-w-full self-start rounded-box shadow-box" />
      <figcaption className="text-pretty text-xs text-fg3">
        {pic.n === v ? '' : `As v${pic.n} looked. `}Made for the Herdr window: open it there.
      </figcaption>
    </figure>
  )
}

/** An artifact's page in a sealed frame: scripts and forms run, never with this app's origin, and it loads nothing. */
function PageFrame({
  art,
  v,
  full,
  markup,
  onPick,
  onMore,
}: {
  art: Artifact
  v: number
  full?: boolean
  /** the browser's or the page's full screen is on (SHEP-111): a recipe lays itself out for it */
  fullScreen?: boolean
  markup?: boolean
  onPick?: (p: Pick) => void
  /** more of the page is below what shows */
  onMore?: (more: boolean) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const device = useUI((u) => u.device)
  // in the chat it is as tall as its page, up to most of the screen; the rest scrolls inside it
  const cap = Math.round(useWindowHeight() * (device === 'phone' ? 0.7 : 0.75))
  const known = `${art.id}:${htmlOf(art, v)}:${device}${full ? ':full' : ''}`
  const [h, setH] = useState(() => heights.get(known) ?? 96)
  // the version in the frame's address: a newer one with the same page only brings data, which goes in without a reload
  const [loaded, setLoaded] = useState(v)
  /** the version whose data is in the frame */
  const has = useRef(v)
  const last = useRef(0)
  const page = htmlOf(art, v)
  const pageLoaded = htmlOf(art, loaded)
  // it opens in the app's light or dark, and is told when that changes, without a reload
  const dark = useDark()
  const opened = useMemo(() => (isDark() ? 'dark' : 'light'), [loaded, full, device])
  const theme = dark ? 'dark' : 'light'
  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ shepherdr: 'theme', theme }, '*')
  }, [theme])
  useEffect(() => {
    if (v === has.current) return
    if (page !== pageLoaded) {
      has.current = v
      return setLoaded(v)
    }
    has.current = v
    fetch(frameUrl(art.id, v, false, device, '/data'))
      .then((r) => r.json())
      .then((r: { data?: unknown }) => has.current === v && ref.current?.contentWindow?.postMessage({ shepherdr: 'data', data: r.data ?? null }, '*'))
      .catch(() => has.current === v && setLoaded(v))
  }, [art.id, v, page, pageLoaded, device])
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || typeof e.data !== 'object') return
      const d = e.data as { shepherdr?: string; h?: number; stuck?: boolean; grows?: boolean; text?: string; url?: string; more?: boolean } & Pick
      if (d.shepherdr === 'more') onMore?.(!!d.more)
      if (d.shepherdr === 'height' && d.h) {
        // one that grows with its frame (100vh) starts from scratch each time, so it settles the same each time
        if (d.stuck) heights.delete(known)
        else if (!d.grows) heights.set(known, d.h)
        setH(d.h)
      }
      // a page speaks for you only right after you tapped or typed in it: the browser's own mark of a person's touch,
      // which no script can make; at most once every two seconds, and on one line (it can't write a chat line of its own)
      if (d.shepherdr === 'send' && typeof d.text === 'string' && d.text.trim() && touchedNow(ref.current) && Date.now() - last.current > 2000) {
        last.current = Date.now()
        const text = d.text.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, 2000)
        act({ type: 'artifact-send', place: art.place, artifact: art.id, v, text })
          .then((r: { to?: string }) => ref.current?.contentWindow?.postMessage({ shepherdr: 'sent', text, to: r?.to }, '*'))
          .catch(() => undefined)
      }
      // a web link opens in a tab of its own, from a tap in the page, never with this app as its opener
      if (d.shepherdr === 'open' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url) && touchedNow(ref.current)) window.open(d.url, '_blank', 'noopener,noreferrer')
      if (d.shepherdr === 'pick' && markup && onPick) onPick({ text: d.text ?? '', selector: d.selector, component: d.component, x: d.x, y: d.y })
    }
    addEventListener('message', on)
    return () => removeEventListener('message', on)
  }, [art.id, art.place, v, known, markup, onPick, onMore])
  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ shepherdr: 'markup', on: !!markup }, '*')
  }, [markup])
  // a fixed-size design fits whole within the cap
  useEffect(() => {
    if (!full) ref.current?.contentWindow?.postMessage({ shepherdr: 'cap', h: cap }, '*')
  }, [cap, full])
  return (
    <iframe
      ref={ref}
      title={art.title}
      sandbox="allow-scripts allow-forms"
      // a Copy button in the page may write to the clipboard (SHEP-152); nothing else of the app's is lent to it
      allow="clipboard-write"
      loading={full ? undefined : 'lazy'}
      src={frameUrl(art.id, loaded, !!full, device, '', opened)}
      onLoad={() => {
        if (theme !== opened) ref.current?.contentWindow?.postMessage({ shepherdr: 'theme', theme }, '*')
        if (markup) ref.current?.contentWindow?.postMessage({ shepherdr: 'markup', on: true }, '*')
        if (!full) ref.current?.contentWindow?.postMessage({ shepherdr: 'cap', h: cap }, '*')
        // newer data came while it was still loading (or loaded again): it gets that data now
        if (has.current !== loaded) {
          const want = has.current
          fetch(frameUrl(art.id, want, false, device, '/data'))
            .then((r) => r.json())
            .then((r: { data?: unknown }) => has.current === want && ref.current?.contentWindow?.postMessage({ shepherdr: 'data', data: r.data ?? null }, '*'))
            .catch(() => undefined)
        }
      }}
      className={clsx('block w-full border-0 bg-transparent', full && 'h-full')}
      style={full ? undefined : { height: Math.min(Math.max(h, 24), cap) }}
    />
  )
}

/** the newest post of an artifact in a chat shows it; earlier ones fold to a line, so a chat never repeats big frames */
function ArtifactCard({ msg, chat }: { msg: Message; chat: Chat; from: string }) {
  const snap = useSnap()!
  const post = msg.artifact
  if (!post) return null
  const art = snap.artifacts?.find((a) => a.id === post.id)
  const later = chat.messages.slice(chat.messages.indexOf(msg) + 1).some((m) => m.artifact?.id === post.id)
  // under the words it came with (a message of its own, on its own)
  const gap = msg.text && 'mt-2'
  // gone from its folder's list: the window's chat shows nothing for it
  if (!art) return null
  // an earlier publish of it: a quiet line, as the window's chat ("Published <title> v2"), that opens that version
  if (later)
    return (
      <button type="button" onClick={() => openArtifact(art.id, post.v)}
        className={clsx(gap, 'press-dim flex max-w-full items-center gap-1.5 rounded-row text-left text-[0.75rem] text-fg3 hover:bg-hover hover:text-fg2 phone:min-h-11 phone:text-[0.8125rem]')}>
        <PageIcon className={ic} />
        <span className="min-w-0 truncate">Published {art.title} v{post.v}</span>
      </button>
    )
  // its latest publish: the window's card, its title, "Artifact · v3" (its latest version) and Open, over what is in it
  return <PreviewCard art={art} gap={gap || undefined} />
}

/** what an artifact's card shows of it (core/recipe.js preview: its key pictures, its first words), by artifact and
 *  version: read once, kept while the chat scrolls. { pics: their addresses, lines } */
type Peek = { pics: string[]; vids: string[]; lines: string[] }
const peeks = new Map<string, { images: string[]; videos?: string[]; lines: string[] } | 'none'>()
function usePeek(art: Artifact): Peek | null {
  const kind = art.versions.find((x) => x.n === art.v)?.kind ?? art.kind
  const key = `${art.machine ?? ''}:${art.id}:${art.v}`
  const on = art.machine ? `&on=${encodeURIComponent(art.machine)}` : ''
  const base = `api/artifacts/${encodeURIComponent(art.id)}`
  const [, redraw] = useState(0)
  useEffect(() => {
    if (kind !== 'recipe' || peeks.has(key)) return
    let gone = false
    fetch(`${base}/recipe?v=${art.v}${on}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('gone'))))
      .then((r) => peeks.set(key, preview(r)), () => peeks.set(key, 'none'))
      .finally(() => !gone && redraw((n) => n + 1))
    return () => { gone = true }
  }, [key, kind, base, on, art.v])
  if (kind === 'gpui') {
    // a custom panel: the picture the window last took of it (newest first)
    const pic = art.versions.find((x) => x.n <= art.v && (x.kind ?? art.kind) === 'gpui' && !!x.picture)
    return pic ? { pics: [`${base}/file/.window.png?v=${pic.n}&t=${pic.picture}${on}`], vids: [], lines: [] } : null
  }
  const p = peeks.get(key)
  if (!p || p === 'none') return null
  const addr = (src: string) => `${base}/file/${src.split('/').map(encodeURIComponent).join('/')}?v=${art.v}${on}`
  // a clip with no poster: its first frame, shown by the browser (SHEP-209)
  return { pics: p.images.map(addr), vids: (p.videos ?? []).map(addr), lines: p.lines }
}

/** the cards that are open in place, by artifact (it stays open as new versions come) */
const opened = new Set<string>()

/** An artifact's latest card in the chat: its title, "Artifact · v3" and Open, then its key pictures and first lines;
 *  Show more opens all of it right here, in the chat, and Open takes it full screen. A new version redraws it in place. */
function PreviewCard({ art, gap }: { art: Artifact; gap?: string }) {
  const peek = usePeek(art)
  const [open, setOpen] = useState(() => opened.has(art.id))
  const toggle = (on: boolean) => { if (on) opened.add(art.id); else opened.delete(art.id); setOpen(on) }
  const pics = peek?.pics ?? []
  const vids = peek?.vids ?? []
  const lines = peek?.lines ?? []
  const tiles = pics.length + vids.length
  const kind = art.versions.find((x) => x.n === art.v)?.kind ?? art.kind
  return (
    <div data-card className={clsx(gap, 'flex w-full flex-col overflow-hidden rounded-box bg-bubble shadow-[inset_0_0_0_1px_var(--line2)]', open ? 'max-w-[720px]' : 'max-w-[480px]')}>
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <button type="button" onClick={() => toggle(!open)} aria-expanded={open} aria-label={`${open ? WORDS.showLess : WORDS.showMore}: ${art.title}`}
          className="press-dim flex min-w-0 flex-1 items-center gap-2.5 rounded-row text-left">
          <span className="grid size-8 shrink-0 place-items-center rounded-row bg-bg text-fg2 phone:size-10">
            <PageIcon className={ic} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{art.title}</span>
            <span className="text-[0.75rem] text-fg3 tabular-nums phone:text-[0.8125rem]">{artifactLine(art.v)}</span>
          </span>
        </button>
        <button type="button" onClick={(e) => (splitClick(e) ? openSplit({ kind: 'artifact', id: art.id }) : openArtifact(art.id))}
          className="press grid h-7 shrink-0 place-items-center rounded-row bg-bg px-2.5 text-[0.8125rem] font-medium shadow-[inset_0_0_0_1px_var(--line2)] hover:bg-hover phone:h-9">
          Open
        </button>
      </div>
      {open ? (
        <div className="border-t border-line">
          <ArtifactFrame art={art} v={art.v} />
        </div>
      ) : (
        <>
          {tiles ? (
            <button type="button" onClick={() => toggle(true)} aria-label={`${WORDS.showMore}: ${art.title}`}
              className={clsx('grid gap-1.5 px-2.5', tiles === 1 ? 'grid-cols-1' : tiles === 2 ? 'grid-cols-2' : 'grid-cols-3')}>
              {pics.map((src) => (
                <img key={src} src={src} alt="" loading="lazy" decoding="async" draggable={false}
                  className={clsx('w-full rounded-[8px] bg-bg object-cover object-top outline-1 -outline-offset-1 outline-fg/10', tiles === 1 ? 'max-h-[240px]' : 'aspect-[4/3]')} />
              ))}
              {vids.map((src) => (
                <video key={src} src={src} preload="metadata" muted playsInline aria-label=""
                  className={clsx('w-full rounded-[8px] bg-black object-cover object-top outline-1 -outline-offset-1 outline-fg/10', tiles === 1 ? 'max-h-[240px]' : 'aspect-[4/3]')} />
              ))}
            </button>
          ) : null}
          {lines.length ? (
            <div className="line-clamp-3 px-3 pt-2 text-[0.875rem]/5 text-fg2 phone:text-[0.9375rem]/6 [&_p]:inline">
              <Markdown text={lines.join(' · ')} />
            </div>
          ) : null}
          {tiles || lines.length || kind !== 'recipe' ? (
            <button type="button" onClick={() => toggle(true)}
              className="press-dim flex items-center gap-1 self-start rounded-row px-3 pt-1.5 pb-2.5 text-[0.8125rem] font-medium text-fg2 hover:text-fg phone:min-h-11 phone:text-[0.875rem]">
              {WORDS.showMore}
              <DownIcon className="size-3.5" />
            </button>
          ) : null}
        </>
      )}
      {open ? (
        <button type="button" onClick={() => toggle(false)}
          className="press-dim flex items-center gap-1 self-start rounded-row px-3 py-2 text-[0.8125rem] font-medium text-fg2 hover:text-fg phone:min-h-11 phone:text-[0.875rem]">
          {WORDS.showLess}
          <UpIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/** An artifact full screen, as the window's viewer: its bar (icon, title, which version or the stepper, Mark up / Done,
 *  Open in sidebar, Close) over the artifact; Mark up lays the window's layer over it. A newer version swaps in while
 *  you look. */
function Viewer() {
  const v = useUI((u) => u.viewer)
  const device = useUI((u) => u.device)
  const snap = useSnap()
  const art = v && snap?.artifacts?.find((a) => a.id === v.artifact)
  const [markup, setMarkup] = useState(false)
  // a version no longer kept (the last 20 are) shows the latest
  const shown = art && v?.v && art.versions.some((x) => x.n === v.v) ? v.v : art?.v
  // another artifact, or another version: Mark up ends, as the window's viewer reopening on it
  useEffect(() => setMarkup(false), [v?.artifact, shown])
  if (!v) return null
  const phone = device === 'phone'
  if (!art || !shown)
    return (
      <div role="dialog" aria-modal="true" aria-label="Artifact" className="fixed inset-0 z-40 grid place-items-center bg-black/35 p-6" onClick={closeArtifact}>
        <div className="rounded-box bg-bg px-5 py-4 shadow-dialog">{snap ? 'This artifact was deleted.' : 'Opening…'}</div>
      </div>
    )
  // round, like every header's buttons; grey circles on a phone
  const barBtn = phone ? 'rounded-full! bg-bubble' : 'rounded-full!'
  return (
    <ViewerShell label={art.title} phone={phone}>
      {(full) => (
      /* the whole screen is the page's, but for a slim bar on top (the window's artifact viewer bar); full screen
         without the browser's own (an iPhone): no bar either, only a button to leave it */
      <div className="relative flex w-full min-w-0 flex-col overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        {full.how === 'page' ? (
          <FullButton on onClick={full.toggle} className="absolute top-[calc(env(safe-area-inset-top)+--spacing(2))] right-[calc(env(safe-area-inset-right)+--spacing(2))] z-10 bg-bubble/90 shadow-box backdrop-blur-sm" />
        ) : (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line pt-[calc(env(safe-area-inset-top)+--spacing(1))] pr-2 [[data-topbar]~*_&]:pt-1 pb-1 pl-4 phone:gap-2 phone:px-3">
          <PageIcon className={clsx(ic, 'shrink-0 text-fg2 phone:hidden')} />
          <div className="min-w-0 flex-1 truncate font-medium">{art.title || 'Artifact'}</div>
          <Stepper art={art} shown={shown} bar="viewer" onStep={(n) => openArtifact(art.id, n)} />
          <TranslateButton art={art} v={shown} className={phone ? 'bg-bubble' : undefined} />
          <MarkUpButton on={markup} onClick={() => setMarkup(!markup)} round />
          <FullButton on={full.on} onClick={full.toggle} className={phone ? 'bg-bubble' : undefined} />
          {/* beside the chat, in the Artifacts panel */}
          {phone ? null : (
            <IconButton label="Open in sidebar" onClick={() => showInPanel(art.id)} className="rounded-full!">
              <PanelIcon className={ic} />
            </IconButton>
          )}
          <IconButton label="Close" onClick={closeArtifact} className={barBtn}>
            <XIcon className={ic} />
          </IconButton>
        </div>
        )}
        <Marked art={art} v={shown} marking={markup} can={full.how !== 'page'} onMark={() => setMarkup(true)} onEnd={() => setMarkup(false)}>
          <div className="absolute inset-0">
            <ArtifactFrame art={art} v={shown} full fullScreen={full.on} />
          </div>
        </Marked>
      </div>
      )}
    </ViewerShell>
  )
}

/** the viewer over the whole screen: it pushes in on a phone and fades in wider, takes the focus and keeps Tab in it,
 *  and gives the focus back when it closes. Its full screen (useFullscreen) is this whole element, bar and all. */
function ViewerShell({ label, phone, children }: { label: string; phone: boolean; children: (full: ReturnType<typeof useFullscreen>) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useMotion(ref, phone ? 'page' : 'fade')
  // a phone has no keyboard to move: nothing takes the focus there (it would only show a ring)
  useDialogFocus(ref, { focus: !phone })
  const full = useFullscreen(ref)
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} className={clsx('fixed inset-0 flex bg-bg', full.how === 'page' ? 'z-50' : 'z-40')}>
      {children(full)}
    </div>
  )
}



/** "All" in the list's bar: every folder's artifacts (the default, like Tasks), or the shown space's (the window's
 *  toggle), kept on this device. A new key: a choice saved under the old one ('shepherdr.artifactsAll', off by
 *  default) starts over on All. */
const ALL = 'shepherdr.artifactsAllFolders'
let allOn = (() => { try { localStorage.removeItem('shepherdr.artifactsAll'); return localStorage.getItem(ALL) !== '0' } catch { return true } })()
const allListeners = new Set<() => void>()
function setAll(on: boolean) {
  allOn = on
  try { localStorage.setItem(ALL, on ? '1' : '0') } catch { /* private window */ }
  allListeners.forEach((l) => l())
}

/** The Artifacts panel, as the window's: "Artifacts", the space's folder or All folders, the All toggle, "Filter
 *  artifacts" (F), and each artifact with "v3 · its maker · 2h ago" ("Open · " while it is open in a pane); newest
 *  first. A row opens it right here, in place of the list (‹ Artifacts goes back). */
function ArtifactList(_: { placeId: string }) {
  const snap = useSnap()!
  const view = useStore((s) => listView(s.ui, snap))
  const place = useUI((u) => u.place)
  const panes = useUI((u) => panesHere(u))
  const all = useSyncExternalStore((l) => (allListeners.add(l), () => void allListeners.delete(l)), () => allOn)
  const value = useUI((u) => u.filter[`${view.search}|artifacts`] ?? '')
  const q = useUI((u) => filterOf(u, view.search, 'artifacts')).trim()
  // its key, where there is a keyboard
  const keys = useUI((u) => u.device === 'desktop' || u.kb)
  const here = placeOf(snap, place)
  // the folder the shown space's artifacts are kept for, and its name ("~" at home), as the window's header
  const store = here.store
  const key = `list:${view.key}`
  // one shown in the panel takes the list's place
  const shown = useShown(key)
  // "2h ago" moves on by the minute
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60000)
    return () => clearInterval(t)
  }, [])
  // with All, every folder's on the shown space's machine (the window's `list --all` there)
  const machineOf = (a: Artifact) => a.machine ?? snap.host
  const items = (snap.artifacts ?? [])
    .filter((a) => (all ? machineOf(a) === here.machine : store?.key && a.store ? a.store === store.key : a.place === here.id))
    .sort((a, b) => b.at - a.at)
  // by its title, the task that made it, who made it, and (with All) its folder
  const list = q ? items.filter((a) => matches(q, a.title, a.task, a.by, all ? a.folderName : undefined, all ? a.folder : undefined)) : items
  const isOpen = (a: Artifact) => panes.some((p) => p.kind === 'artifact' && p.id === a.id)
  if (shown) return <PanelArtifact art={shown} onBack={() => setShown(key, null)} />
  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2 phone:px-4">
        <span className="shrink-0 font-semibold">Artifacts</span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-fg3 phone:text-[0.9375rem]">{all ? 'All folders' : store?.name ?? here.name}</span>
        <button type="button" aria-pressed={all} onClick={() => setAll(!all)}
          className="press-dim h-7 shrink-0 rounded-full px-2.5 text-[0.8125rem] font-medium text-fg2 hover:bg-hover hover:text-fg aria-pressed:bg-sel aria-pressed:text-fg coarse:h-9 phone:h-9 phone:text-[0.875rem]">
          All
        </button>
      </div>
      <FilterBox
        label="Filter artifacts"
        hint={keys ? 'F' : undefined}
        value={value}
        onChange={(v) => setFilter(view.search, 'artifacts', v)}
      />
      {!items.length ? (
        <div className="flex flex-col items-center gap-1.5 px-5 pt-7 pb-4 text-center">
          <PageIcon className={clsx(ic, 'text-fg3')} />
          <p className="pt-1 font-medium">No artifacts.</p>
          <p className="max-w-64 text-[0.8125rem] text-pretty text-fg2 phone:text-[0.9375rem]">
            {all ? 'Reports, boards and forms agents make show here.' : `Reports, boards and forms agents make for ${store?.name ?? here.name} show here. Ask an agent to make one.`}
          </p>
        </div>
      ) : list.length ? (
        <List className="pt-1">
          {list.map((a) => {
            const sel = lastShown[key] === a.id
            return (
              <Row key={a.id} two sel={sel} onActivate={() => setShown(key, a.id)} className="gap-3! py-2!">
                <PageIcon className={clsx(ic, 'mt-0.5 shrink-0 self-start', sel || isOpen(a) ? 'text-focus' : 'text-fg3')} />
                <RowText sub={<>{isOpen(a) ? 'Open · ' : ''}{detailOf(a)}</>}>
                  <span className="block truncate">{a.title}</span>
                </RowText>
                {all && a.folderName ? <span className="max-w-36 shrink-0 truncate self-start text-[0.75rem] text-fg3 phone:text-[0.8125rem]">{a.folderName}</span> : null}
              </Row>
            )
          })}
        </List>
      ) : (
        <p className="px-5 pt-7 text-center text-[0.8125rem] text-fg3 phone:text-[0.9375rem]">No artifacts match “{q}”.</p>
      )}
    </>
  )
}

/** A task's Artifacts tab (SHEP-60): what its agent and its helpers made or updated (the service finds them:
 *  core/task-artifacts.js), its proof first and marked so, then newest first; each with its title (without the task's
 *  id in front), how many versions and when. A tap opens it in the viewer (its versions, Mark up). None: a quiet line. */
function TaskArtifacts({ task }: { task: Task; chatKey: string }) {
  const snap = useSnap()!
  // "2h ago" moves on by the minute
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60000)
    return () => clearInterval(t)
  }, [])
  const ref = task.id.slice(task.id.lastIndexOf(':') + 1)
  const all = snap.artifacts ?? []
  const list = (task.artifacts ?? []).map((id) => all.find((a) => a.id === id)).filter((a): a is Artifact => !!a)
  if (!list.length)
    return (
      <div className="flex flex-col items-center gap-1.5 px-5 pt-10 pb-4 text-center">
        <PageIcon className={clsx(ic, 'text-fg3')} />
        <p className="pt-1 font-medium">No artifacts yet</p>
        <p className="max-w-64 text-[0.8125rem] text-pretty text-fg2 phone:text-[0.9375rem]">Reports and proofs this task's agent makes show here.</p>
      </div>
    )
  return (
    <List className="py-1.5">
      {list.map((a) => {
        const proof = a.id === task.proof
        return (
          <Row key={a.id} two onActivate={() => openArtifact(a.id)} data-task-artifact={a.id} className="gap-3! py-2!">
            <PageIcon className={clsx(ic, 'mt-0.5 shrink-0 self-start', proof ? 'text-focus' : 'text-fg3')} />
            <RowText sub={[`${a.v} ${a.v === 1 ? 'version' : 'versions'}`, a.at ? ago(a.at) : null].filter(Boolean).join(' · ')}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{titleInTask(a.title, ref, proof)}</span>
                {proof ? <span className="shrink-0 rounded-full bg-sel px-2 py-px text-[0.6875rem]/4 font-medium text-fg2 phone:text-[0.75rem]/4">Proof</span> : null}
              </span>
            </RowText>
          </Row>
        )
      })}
    </List>
  )
}

export default definePlugin({
  name: 'artifacts',
  setup(reg) {
    // a task's own: the last of its tabs, always there (its place never moves), counted once it has some
    reg.taskPanel.push({ id: 'artifacts', order: 30, label: 'Artifacts', Icon: PageIcon, count: (t) => t.artifacts?.length ?? 0, View: TaskArtifacts })
    reg.views.artifacts = ArtifactList
    reg.views.artifact = SplitArtifact
    reg.messageParts.push({ order: 50, View: ArtifactCard })
    reg.overlays.push(Viewer)
  },
})
