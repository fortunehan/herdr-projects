// An artifact's recipe drawn as the web's own HTML (core/recipe.js says what each block is; the window draws the same
// file in GPUI). In 2.1's look: its tokens, type and corners; charts as SVG; Markdown through the chat's renderer.
// A choice, a form or a button sends its words to the agent that made it (reply), as the window's
// (mods/artifacts/recipe-view.js). The answer is kept with the version (answers.json, SHEP-87): reopened, the chosen
// option shows picked with when, and a choice or a form can be changed (sent again). Mark up lays its own layer over
// the whole recipe (plugins/artifacts). A tap on a picture opens it large, with the recipe's other pictures beside it
// (Pictures.tsx, SHEP-90).
import clsx from 'clsx'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { PictureViewer } from './Pictures.tsx'
import { ArrowUpRightIcon, CheckIcon } from '@heroicons/react/16/solid'
import { Markdown, TrLine } from '@plugins/chat/markdown.tsx'
import { Primary } from '../ui.tsx'
import * as R from '@core/recipe.js'
import * as TRc from '@core/translate.js'
import { marked } from 'marked'
import { FULL_TEXT, fullStyle, pairGrid, picturePlace } from './recipe-full.ts'

type Block = any
export type Answer = { value: unknown; at: number; by?: string }
export type Answers = Record<string, Answer>
/** the person's answer to the agent: its words, and what to keep (the block's key and its value) */
export type Reply = (text: string, keep?: { key: string; value: unknown }) => Promise<unknown>
/** SHEP-102: an artifact's translation (web/plugins/chat/translate.ts): each text's by its place (core/translate.js
 *  recipeUnits), the places that failed, loading or why it failed as a whole, and Retry */
export type RecipeTr = { units?: Record<string, string>; failed?: string[]; loading?: boolean; error?: string; retry?: () => void }
/** fullScreen (SHEP-111): the artifact fills the screen: the recipe centred, words at most FULL_TEXT px wide, each
 *  picture at most its own size; else today's layout */
type Props = { recipe: { blocks: Block[] }; asset: (src: string) => string; reply?: Reply; answers?: Answers; tr?: RecipeTr; fullScreen?: boolean }

/** the window's words when a recipe can't be read */
export const UNREADABLE = "This artifact's recipe can't be read."

const { chartShapes, choiceReply, formReply, isLink, answerLine, answerOf, checkStatus, diffLines, isDiff, pictures } = R as any

/** opens the picture viewer on a picture, by its src in the recipe */
const OpenPicture = createContext<((src: string) => void) | null>(null)
/** full screen: pictures and clips centred in their place */
const Full = createContext(false)
const PALETTE = ['var(--accent)', 'var(--focus)', 'var(--ready)', 'var(--work)', 'var(--merged)', 'var(--need)']
const TONE: Record<string, string> = { info: 'bg-well shadow-soft', good: 'bg-ready/10', warn: 'bg-work/12', bad: 'bg-need/10' }
/** SHEP-107: words keep a reading width (as the window's recipe view, mods/artifacts/recipe-view.js) while grids,
 *  columns, tables and pictures take the whole width: a full-screen artifact on a wide screen */
const PROSE = 'max-w-[46rem]'

function Chart({ b, T }: { b: Block; T?: (field: string) => string | undefined }) {
  const s = chartShapes(b)
  const W = 320, H = 160
  // an axis label's translation goes under it (SHEP-102): room for a second line
  const tall = (b.labels ?? []).some((_: string, i: number) => !!T?.(`label.${i}`))
  if (b.kind === 'pie') {
    const arc = (a0: number, a1: number) => {
      const r = 70, cx = 80, cy = 80, p = (a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)]
      const [x0, y0] = p(a0), [x1, y1] = p(a1)
      return a1 - a0 >= Math.PI * 2 - 1e-6 ? `M${cx} ${cy - r}A${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}Z` : `M${cx} ${cy}L${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}Z`
    }
    return (
      <div className="flex flex-wrap items-center gap-4">
        <svg viewBox="0 0 160 160" className="size-36 shrink-0" role="img" aria-label={b.title ?? 'Pie chart'}>
          {s.slices.map((x: any, i: number) => <path key={i} d={arc(x.a0, x.a1)} fill={PALETTE[i % PALETTE.length]} />)}
        </svg>
        <ul role="list" className="flex flex-col gap-1">
          {s.slices.map((x: any, i: number) => (
            <li key={i} className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />{x.label}{T?.(`label.${i}`) ? <span data-tr className="text-fg2">· {T(`label.${i}`)}</span> : null}<span className="text-fg3 tabular-nums">{Math.round(x.share * 100)}%</span></li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H + (tall ? 32 : 18)}`} className="w-full max-w-[560px]" role="img" aria-label={b.title ?? `${b.kind} chart`}>
        <line x1="0" x2={W} y1={H} y2={H} stroke="var(--line2)" />
        {b.kind === 'line'
          ? s.lines.map((l: any, i: number) => <polyline key={i} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="2" points={l.points.map((p: any) => `${p.x * (W - 8) + 4},${H - p.y * (H - 8)}`).join(' ')} />)
          : s.bars.map((x: any, i: number) => <rect key={i} x={x.x * W} y={H - x.h * (H - 4)} width={x.w * W} height={x.h * (H - 4)} rx="2" fill={PALETTE[x.series % PALETTE.length]} />)}
        {(b.labels ?? []).map((l: string, i: number, all: string[]) => (
          <g key={i}>
            <text x={((i + 0.5) / all.length) * W} y={H + 14} textAnchor="middle" fontSize="10" fill="var(--fg3)">{l}</text>
            {T?.(`label.${i}`) ? <text data-tr x={((i + 0.5) / all.length) * W} y={H + 28} textAnchor="middle" fontSize="10" fill="var(--fg2)">{T(`label.${i}`)}</text> : null}
          </g>
        ))}
      </svg>
      {(b.series ?? []).length > 1 ? (
        <figcaption className="flex flex-wrap gap-3 text-fg2">{b.series.map((x: any, i: number) => <span key={i} className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />{x.name}{T?.(`series.${i}`) ? <span data-tr className="text-fg3">· {T(`series.${i}`)}</span> : null}</span>)}</figcaption>
      ) : null}
    </figure>
  )
}

/** when the person answered, under the block: "You chose this at 14:05" */
function Answered({ kind, a }: { kind: string; a: Answer | null }) {
  return a ? <p className="text-fg3" data-answered>{answerLine(kind, a.at)}</p> : null
}

function Choice({ b, reply, answer }: { b: Block; reply?: Reply; answer: Answer | null }) {
  const [busy, setBusy] = useState(false)
  const chosen = answer ? String(answer.value) : null
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-medium">{b.question}</legend>
      {b.options.map((o: any) => {
        const on = chosen === o.label
        return (
          <button key={o.label} type="button" aria-pressed={on} disabled={on || busy || !reply}
            onClick={async () => { setBusy(true); try { await reply?.(choiceReply(b, o.label), { key: b.id, value: o.label }) } finally { setBusy(false) } }}
            className={clsx('press-dim flex items-center gap-3 rounded-box px-3.5 py-2.5 text-left enabled:hover:bg-hover disabled:cursor-default', on ? 'bg-sel shadow-[inset_0_0_0_1.5px_var(--fg2)]' : 'shadow-box')}>
            <span className="flex min-w-0 flex-1 flex-col items-start">
              <span className="font-medium">{o.label}</span>
              {o.description ? <span className="text-fg2">{o.description}</span> : null}
            </span>
            {on ? <span className="flex shrink-0 items-center gap-1 text-[0.8125rem] font-medium text-fg"><CheckIcon aria-hidden className="size-4" />Your choice</span> : null}
          </button>
        )
      })}
      <Answered kind="choice" a={answer} />
    </fieldset>
  )
}

function Form({ b, reply, answer }: { b: Block; reply?: Reply; answer: Answer | null }) {
  const kept = answer && typeof answer.value === 'object' ? (answer.value as Record<string, unknown>) : null
  const [v, setV] = useState<Record<string, unknown>>(() => kept ?? {})
  const [busy, setBusy] = useState(false)
  // reopened (or answered on another screen): its values as sent
  useEffect(() => { if (kept) setV(kept) }, [JSON.stringify(kept)])
  const same = !!kept && JSON.stringify(kept) === JSON.stringify(v)
  const field = 'w-full rounded-[var(--row-radius)] bg-bg px-3 py-2 shadow-[inset_0_0_0_1px_var(--line2)] outline-none focus:shadow-[inset_0_0_0_1px_var(--fg3)]'
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await reply?.(formReply(b, v), { key: b.id, value: v }) } finally { setBusy(false) } }}>
      {b.fields.map((f: any) => (
        <label key={f.name} className={clsx('flex gap-2', f.kind === 'checkbox' ? 'items-center' : 'flex-col')}>
          {f.kind === 'checkbox' ? <input type="checkbox" checked={!!v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.checked })} className="size-4" /> : null}
          <span className="text-fg2">{f.label ?? f.name}</span>
          {f.kind === 'textarea' ? <textarea rows={3} className={field} placeholder={f.label ?? f.name} value={String(v[f.name] ?? '')} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
            : f.kind === 'select' ? <select className={field} value={String(v[f.name] ?? '')} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}><option value="" />{(f.options ?? []).map((o: string) => <option key={o}>{o}</option>)}</select>
            : f.kind === 'checkbox' ? null : <input className={field} placeholder={f.label ?? f.name} value={String(v[f.name] ?? '')} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />}
        </label>
      ))}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Primary type="submit" disabled={same || busy || !reply} className="self-start">{same ? 'Sent' : kept ? 'Send again' : b.submit ?? 'Send'}</Primary>
        <Answered kind="form" a={answer} />
      </div>
    </form>
  )
}

/** a press sends its reply, once: "<label> · Sent" (kept: so it stays after a reopen, its time under it). With
 *  an href (https only) it opens that page in a new tab each press, as a plain link: the person acts there
 *  themselves. quiet: the softer look, beside the one to press. */
function Button({ b, k, reply, answers: kept, className }: { b: Block; k: string; reply?: Reply; answers?: Answers; className?: string }) {
  const a = answerOf(kept, k) as Answer | null
  const sent = !!a
  const link = isLink(b.href) ? (b.href as string) : null
  const answers = typeof b.reply === 'string'
  return (
    <Primary soft={!!b.quiet} disabled={!link && (sent || !reply)} className={clsx(link && 'pr-3', className)}
      onClick={async () => {
        if (link) window.open(link, '_blank', 'noopener,noreferrer')
        if (answers && !sent && reply) await reply(b.reply, { key: k, value: b.label })
      }}>
      {sent && !link ? `${b.label} · Sent` : b.label}
      {link ? <ArrowUpRightIcon aria-hidden className="size-4 shrink-0 opacity-70" /> : null}
    </Primary>
  )
}

/** a clip (mp4, webm or mov) in place: its controls, its poster, or muted and looping for a short one that plays itself.
 *  A browser that can't play it says so and offers the file (SHEP-209). videoRef and events let a pair play two together. */
function Clip({ src, poster, caption, loop, muted, autoplay, asset, videoRef, events, label }: { src: string; poster?: string; caption?: string; loop?: boolean; muted?: boolean; autoplay?: boolean; asset: (src: string) => string; videoRef?: RefObject<HTMLVideoElement | null>; events?: Record<string, () => void>; label?: string }) {
  const [broken, setBroken] = useState(false)
  const own = useRef<HTMLVideoElement>(null)
  const ref = videoRef ?? own
  const silent = !!muted || !!autoplay
  const full = useContext(Full)
  // React doesn't write the muted attribute, so a silent clip is muted on the element (autoplay needs it)
  useEffect(() => { if (ref.current && silent) ref.current.muted = true }, [silent, ref])
  return (
    <figure className={clsx('flex min-w-0 flex-col gap-1.5', full && 'items-center')}>
      {broken ? (
        <p className="rounded-box bg-well p-3 text-fg2">This browser can't play this clip. <a className="underline" href={asset(src)} target="_blank" rel="noopener noreferrer" download>Open the file</a></p>
      ) : (
        <video ref={ref} src={asset(src)} poster={poster ? asset(poster) : undefined} controls autoPlay={!!autoplay} loop={!!loop} muted={silent} playsInline preload="metadata"
          aria-label={label ?? caption ?? 'Clip'} onError={() => setBroken(true)} {...events}
          className={clsx('block h-auto max-h-[70vh] rounded-box bg-black shadow-box', full ? 'w-auto max-w-full' : 'w-full')} />
      )}
      {caption ? <figcaption className={clsx('text-fg2', full && 'text-center text-pretty')} style={full ? { maxWidth: FULL_TEXT } : undefined}>{caption}</figcaption> : null}
    </figure>
  )
}

/** a sound (mp3, m4a, wav or ogg) in a small player */
function Sound({ src, caption, asset }: { src: string; caption?: string; asset: (src: string) => string }) {
  const [broken, setBroken] = useState(false)
  return (
    <figure className="flex min-w-0 flex-col gap-1.5 rounded-box bg-well p-3 shadow-soft">
      {broken ? <p className="text-fg2">This browser can't play this sound. <a className="underline" href={asset(src)} target="_blank" rel="noopener noreferrer" download>Open the file</a></p>
        : <audio controls preload="metadata" src={asset(src)} aria-label={caption ?? 'Sound'} onError={() => setBroken(true)} className="w-full" />}
      {caption ? <figcaption className="text-fg2">{caption}</figcaption> : null}
    </figure>
  )
}

/** a PDF inline: its own pages in a frame, with a link to open it whole (phones often can't show one in a frame) */
function Pdf({ src, caption, asset }: { src: string; caption?: string; asset: (src: string) => string }) {
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <iframe src={asset(src)} title={caption ?? 'PDF'} className="h-[70vh] min-h-[320px] w-full rounded-box bg-well shadow-box" />
      <figcaption className="flex flex-wrap items-center gap-x-3 text-fg2">
        {caption ? <span>{caption}</span> : null}
        <a className="underline" href={asset(src)} target="_blank" rel="noopener noreferrer">Open the PDF</a>
      </figcaption>
    </figure>
  )
}

/** A picture at its own size, never wider than its column (a flex column would stretch it: #954). One that fails to
 *  load (a version still being copied, a hiccup reaching another machine) is asked for again a few times, under a
 *  new address so no cached failure answers (#983). */
function Pic({ src, file, alt, w, h }: { src: string; file: string; alt: string; w?: number; h?: number }) {
  const open = useContext(OpenPicture)
  const full = useContext(Full)
  const [tries, setTries] = useState(0)
  useEffect(() => setTries(0), [src])
  const retry = () => { if (tries < 3) setTimeout(() => setTries((n) => n + 1), 1000 * 2 ** tries) }
  const url = tries ? `${src}${src.includes('?') ? '&' : '?'}retry=${tries}` : src
  const pic = <img src={url} alt={alt} width={w} height={h} onError={retry} className="h-auto max-w-full rounded-box shadow-box" loading="lazy" />
  const place = picturePlace(full)
  if (!open) return <div className={place}>{pic}</div>
  return (
    <button type="button" aria-label={`Open ${alt || file.split('/').pop()}`} onClick={() => open(file)}
      className={clsx('press-dim block max-w-full cursor-zoom-in rounded-box', place)}>
      {pic}
    </button>
  )
}

/** before and after side by side: a picture or a clip each; two clips play together (one's play, pause and seek are the other's) */
function Pair({ b, asset, under }: { b: Block; asset: (src: string) => string; under?: (side: 'before' | 'after') => ReactNode }) {
  const left = useRef<HTMLVideoElement>(null), right = useRef<HTMLVideoElement>(null)
  const sides = [['Before', b.before, left, right], ['After', b.after, right, left]] as const
  const clips = R.mediaKind(b.before?.src) === 'video' && R.mediaKind(b.after?.src) === 'video'
  const full = useContext(Full)
  // the other clip: follows this one's play, pause and seek (a seek only when it has drifted, so the two don't fight)
  const follow = (me: RefObject<HTMLVideoElement | null>, other: RefObject<HTMLVideoElement | null>) => ({
    onPlay: () => { other.current?.play().catch(() => undefined) },
    onPause: () => { other.current?.pause() },
    onSeeked: () => { const o = other.current, m = me.current; if (o && m && Math.abs(o.currentTime - m.currentTime) > 0.05) o.currentTime = m.currentTime },
  })
  return (
    <div className={clsx('grid gap-3', pairGrid(full))}>
      {sides.map(([w, x, mine, theirs]) => {
        const kind = R.mediaKind(x?.src)
        // each side's caption translation under its own caption (SHEP-102)
        const side = w === 'Before' ? 'before' : 'after'
        return kind === 'video' ? (
          <div key={w} className="flex min-w-0 flex-col">
            <Clip src={x.src} poster={x.poster} caption={x.caption ?? w} asset={asset} videoRef={mine} label={`${w}: ${x.caption ?? w}`}
              events={clips ? follow(mine, theirs) : undefined} />
            {under?.(side)}
          </div>
        ) : (
          <figure key={w} className={clsx('flex min-w-0 flex-col gap-1.5', full && 'items-center')}><Pic src={asset(x.src)} file={x.src} alt={x.caption ?? w} /><figcaption className="text-fg2">{x.caption ?? w}{under?.(side)}</figcaption></figure>
        )
      })}
    </div>
  )
}

function Tabs({ b, render, T }: { b: Block; render: (bs: Block[]) => ReactNode; T?: (field: string) => string | undefined }) {
  const [on, setOn] = useState(0)
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" className="scroll-x inline-flex max-w-full gap-0.5 self-start rounded-full bg-hover p-0.5">
        {b.tabs.map((t: any, i: number) => (
          <button key={i} role="tab" aria-selected={on === i} type="button" onClick={() => setOn(i)} className={clsx('h-7 shrink-0 rounded-full px-3 phone:h-9', on === i ? 'bg-seg-on shadow-seg' : 'text-fg2')}>{t.label}{T?.(`tab.${i}`) ? <span data-tr className="text-fg3"> · {T(`tab.${i}`)}</span> : null}</button>
        ))}
      </div>
      {render(b.tabs[on]?.blocks ?? [])}
    </div>
  )
}

const DIFF: Record<string, string> = { add: 'bg-ready/12 text-ready-fg', del: 'bg-need/10 text-need-fg', hunk: 'text-fg3', file: 'font-semibold text-fg2', '': '' }

/** a code block; a diff's +, - and @@ lines coloured */
function Code({ b }: { b: Block }) {
  return (
    <pre data-selectable className="overflow-x-auto rounded-box bg-well p-3 font-mono text-[0.8125rem] shadow-soft">
      {isDiff(b) ? (
        <code className="block min-w-max">
          {diffLines(b.text).map((l: { text: string; kind: string }, i: number) => <span key={i} data-diff={l.kind || 'context'} className={clsx('-mx-3 block px-3', DIFF[l.kind])}>{l.text || ' '}</span>)}
        </code>
      ) : <code>{b.text}</code>}
    </pre>
  )
}

/** a command that ran: its status (green Passed, red Failed · exit N), the command, its summary; its output folded */
function Check({ b }: { b: Block }) {
  const s = checkStatus(b)
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-col gap-2 rounded-box bg-well p-3 shadow-soft">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span data-check={s.ok ? 'passed' : 'failed'} className={clsx('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.8125rem] font-medium', s.ok ? 'bg-ready/15 text-ready-fg' : 'bg-need/12 text-need-fg')}>
            <span className={clsx('size-[7px] rounded-full', s.ok ? 'bg-ready' : 'bg-need')} />{s.label}
          </span>
          {b.summary ? <span className="min-w-0 text-fg">{b.summary}</span> : null}
        </div>
        <code data-selectable className="block font-mono text-[0.8125rem] break-all whitespace-pre-wrap text-fg2">$ {b.command}</code>
        {b.output ? (
          <details className="group">
            <summary className="cursor-pointer text-[0.8125rem] text-fg3 hover:text-fg">Output</summary>
            <pre data-selectable className="mt-1.5 max-h-[50vh] overflow-auto rounded-[var(--row-radius)] bg-bg p-2.5 font-mono text-xs/5 shadow-[inset_0_0_0_1px_var(--line2)]">{b.output}</pre>
          </details>
        ) : null}
      </div>
      {b.caption ? <figcaption className="text-fg2">{b.caption}</figcaption> : null}
    </figure>
  )
}

export function Recipe({ recipe, asset, reply: send, answers: given, tr, fullScreen = false }: Props) {
  const prose = fullScreen ? undefined : PROSE
  // each block's place, as the translation names its texts
  const paths = useMemo(() => (TRc as any).blockPaths(recipe) as Map<Block, string>, [recipe])
  const failed = new Set(tr?.failed ?? [])
  /** the translation of a block's text (field: its place in the block), under it */
  const T = (b: Block, field: string) => {
    if (!tr) return null
    const key = `${paths.get(b)}.${field}`
    const t = tr.units?.[key]
    if (t) return <TrLine text={t} />
    return failed.has(key) ? <TrLine text={(TRc as any).WORDS.blockFailed} fail retry={tr.retry} /> : null
  }
  /** a chart's or tabs' labels that couldn't be translated: one line with Retry under it */
  const failedIn = (b: Block) => (tr?.failed?.some((k) => ['tab.', 'label.', 'series.'].some((f) => k.startsWith(`${paths.get(b)}.${f}`))) ? <TrLine text={(TRc as any).WORDS.blockFailed} fail retry={tr.retry} /> : null)
  /** a short label's translation (a tab's, a chart legend's), as words beside it */
  const words = (b: Block) => (field: string) => (tr ? tr.units?.[`${paths.get(b)}.${field}`] : undefined)
  /** a markdown block's paragraphs, each with its translation under it (as a chat message's) */
  const md = (b: Block, field: string, text: string) => {
    if (!tr) return <Markdown text={text} />
    const blocks = ((TRc as any).blocksFromTokens(marked.lexer(text)) as unknown[]).map((_, i) => tr.units?.[`${paths.get(b)}.${field}.${i}`] ?? null)
    const bad = blocks.map((_, i) => i).filter((i) => failed.has(`${paths.get(b)}.${field}.${i}`))
    return <Markdown text={text} tr={{ source: text, blocks, failed: bad, retry: tr.retry }} />
  }
  // what was answered here since it opened, over what was kept before (answers.json)
  const [mine, setMine] = useState<Answers>({})
  const answers: Answers = { ...(given ?? {}), ...mine }
  // every picture in it, for the viewer to page through; the one open
  const pics = useMemo(() => (pictures(recipe) as { src: string; caption: string }[]).map((x) => ({ src: x.src, url: asset(x.src), name: x.caption || x.src.split('/').pop()!, file: x.src.split('/').pop()! })), [recipe, asset])
  const [shown, setShown] = useState<number | null>(null)
  // the viewer sits outside the page (over everything): it takes the page's device shape with it
  const root = useRef<HTMLDivElement>(null)
  const reply: Reply | undefined = send && (async (text, keep) => {
    const r = await send(text, keep)
    if (keep) setMine((m) => ({ ...m, [keep.key]: { value: keep.value, at: Date.now(), by: 'web' } }))
    return r
  })
  const one = (b: Block): ReactNode => {
    switch (b.type) {
      case 'heading': { const H = (`h${Math.min(3, Math.max(1, b.level ?? 2)) + 1}`) as 'h2'; return <><H className={clsx('font-semibold text-balance', (b.level ?? 2) <= 1 ? 'text-xl' : 'text-base')}>{b.text}</H>{T(b, 'text')}</> }
      case 'text': return <div className={prose}>{md(b, 'md', b.md)}</div>
      case 'list': { const L = b.ordered ? 'ol' : 'ul'; return <L className={clsx('flex flex-col gap-1 pl-5', prose, b.ordered ? 'list-decimal' : 'list-disc')}>{b.items.map((x: string, i: number) => <li key={i}><Markdown text={x} />{T(b, `items.${i}`)}</li>)}</L> }
      case 'table': return (
        <div className="overflow-x-auto rounded-box shadow-box">
          <table className="w-full border-collapse">
            <thead><tr>{b.columns.map((c: any, i: number) => <th key={i} className={clsx('border-b border-line px-3 py-2 text-left font-medium text-fg2', (c.align ?? '') === 'right' && 'text-right')}>{c.label ?? c}{T(b, `col.${i}`)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r: unknown[], i: number) => <tr key={i} className="border-b border-line last:border-0">{r.map((c, j) => <td key={j} className={clsx('px-3 py-2 align-top', b.columns[j]?.align === 'right' && 'text-right tabular-nums')}>{String(c ?? '')}{T(b, `cell.${i}.${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
      case 'chart': return <><Chart b={b} T={words(b)} />{failedIn(b)}</>
      case 'stats': return <dl className="grid grid-cols-2 gap-3 @lg:grid-cols-4">{b.items.map((x: any, i: number) => <div key={i} className="rounded-box bg-well p-3 shadow-soft"><dt className="text-fg2">{x.label}{T(b, `label.${i}`)}</dt><dd className="text-xl font-semibold tabular-nums">{String(x.value)}</dd>{x.note ? <dd className="text-fg3">{x.note}{T(b, `note.${i}`)}</dd> : null}</div>)}</dl>
      case 'image': return <figure className={clsx('flex flex-col gap-1.5', fullScreen && 'items-center')}><Pic src={asset(b.src)} file={b.src} alt={b.caption ?? ''} w={b.w} h={b.h} />{b.caption ? <figcaption className={clsx('text-fg2', fullScreen && 'text-center text-pretty')} style={fullScreen ? { maxWidth: FULL_TEXT } : undefined}>{b.caption}{T(b, 'caption')}</figcaption> : null}</figure>
      case 'video': return <><Clip src={b.src} poster={b.poster} caption={b.caption} loop={b.loop} muted={b.muted} autoplay={b.autoplay} asset={asset} />{T(b, 'caption')}</>
      case 'audio': return <><Sound src={b.src} caption={b.caption} asset={asset} />{T(b, 'caption')}</>
      case 'pdf': return <><Pdf src={b.src} caption={b.caption} asset={asset} />{T(b, 'caption')}</>
      case 'pair': return <Pair b={b} asset={asset} under={(side) => T(b, side)} />
      case 'code': return <Code b={b} />
      case 'check': return <><Check b={b} />{T(b, 'summary')}{T(b, 'caption')}</>
      case 'callout': return <div className={clsx('rounded-box p-3.5', TONE[b.tone ?? 'info'])}>{b.title ? <p className="font-medium">{b.title}</p> : null}{T(b, 'title')}{b.md ? md(b, 'md', b.md) : null}</div>
      case 'columns': return <div className="grid gap-4 @2xl:grid-flow-col @2xl:auto-cols-fr">{b.columns.map((c: Block[], i: number) => <div key={i} className="flex min-w-0 flex-col gap-4">{c.map(wrap)}</div>)}</div>
      case 'tabs': return <>{failedIn(b)}<Tabs b={b} T={words(b)} render={(bs) => <div className="flex flex-col gap-4">{bs.map(wrap)}</div>} /></>
      case 'details': return <details className="group rounded-box shadow-box"><summary className="cursor-pointer px-3.5 py-2.5 font-medium">{b.summary}{T(b, 'summary')}</summary><div className="flex flex-col gap-4 px-3.5 pb-3.5">{b.blocks.map(wrap)}</div></details>
      case 'divider': return <hr className="border-line" />
      case 'choice': return <>{T(b, 'question')}<Choice b={b} reply={reply} answer={answerOf(answers, b.id)} /></>
      case 'form': return <Form b={b} reply={reply} answer={answerOf(answers, b.id)} />
      case 'button': return <div className="flex flex-col items-start gap-1.5"><Button b={b} k={b.id} reply={reply} answers={answers} /><Answered kind="button" a={answerOf(answers, b.id)} /></div>
      case 'buttons': {
        // the newest press among them, under the row
        const pressed = b.items.map((_: Block, i: number) => answerOf(answers, `${b.id}-${i}`) as Answer | null).filter(Boolean).sort((x: Answer, y: Answer) => y.at - x.at)[0] ?? null
        return (
          <div className="flex flex-col items-start gap-1.5">
            <div className="flex flex-wrap items-center gap-2">{b.items.map((x: Block, i: number) => <Button key={i} b={x} k={`${b.id}-${i}`} reply={reply} answers={answers} />)}</div>
            <Answered kind="button" a={pressed} />
          </div>
        )
      }
    }
    return null
  }
  const wrap = (b: Block) => {
    const f = fullStyle(b, fullScreen)
    return (
      <section key={b.id} data-block={b.id} className={clsx('min-w-0', f.className)} style={f.style}>
        {one(b)}
      </section>
    )
  }
  return (
    <Full.Provider value={fullScreen}>
    <OpenPicture.Provider value={(src) => setShown(Math.max(0, pics.findIndex((x) => x.src === src)))}>
      <div ref={root} className="@container flex flex-col gap-4 text-base/7 text-fg sm:text-sm/6">
        {tr?.loading ? <TrLine text={(TRc as any).WORDS.translating} note /> : null}
        {tr?.error ? <TrLine text={tr.error} fail retry={tr.retry} /> : null}
        {recipe.blocks.map(wrap)}
      </div>
      {shown !== null && pics.length ? <PictureViewer pics={pics} at={shown} device={root.current?.closest('[data-device]')?.getAttribute('data-device') ?? undefined} onClose={() => setShown(null)} /> : null}
    </OpenPicture.Provider>
    </Full.Provider>
  )
}
