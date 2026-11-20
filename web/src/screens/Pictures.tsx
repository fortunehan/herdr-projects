// An artifact's pictures, one large at a time (SHEP-90), as the window's picture viewer (mods/chat-image): a toolbar on
// top (its name and size; zoom out, the zoom % (a click: fitted <-> its own size), zoom in; copy, open, save; close),
// and with several, previous / next at the sides and "2 / 3" below. Zoom: the buttons, + - 0 1, the wheel or a pinch
// (at the pointer), a double click or double tap. A zoomed picture is dragged to look around; a fitted one is swiped
// to the next. Left / Right step, Esc or a click beside the picture closes. Show in folder isn't here: a browser has no
// folder to show. Copy shows only where the browser can put a picture on the clipboard (https).
import clsx from 'clsx'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from '@heroicons/react/16/solid'
import { BackIcon, CheckIcon, CopyIcon, DownloadIcon, ic, NextIcon, OpenIcon, XIcon } from '../ui.tsx'
import { toast } from '@plugins/alerts/toasts.tsx'
import { canCopyPicture, clampZoom, copyPicture, percent, STEP, toggledZoom } from '../pictures.ts'

/** one picture: its address, what the bar calls it, the file name it saves as */
export type Picture = { url: string; name: string; file: string }

type Pt = { x: number; y: number }
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** device: the page's shape (data-device), which the viewer, outside the page, carries itself */
export function PictureViewer({ pics, at, device, onClose }: { pics: Picture[]; at: number; device?: string; onClose: () => void }) {
  const [i, setI] = useState(Math.min(Math.max(0, at), pics.length - 1))
  const p = pics[i]
  // over a full-screen artifact too: only what is inside the full-screen element shows
  const host = document.fullscreenElement ?? document.body
  return createPortal(<Stage key={p.url} pics={pics} i={i} device={device} go={(n) => setI((n + pics.length) % pics.length)} onClose={onClose} />, host)
}

function Stage({ pics, i, device, go, onClose }: { pics: Picture[]; i: number; device?: string; go: (n: number) => void; onClose: () => void }) {
  const p = pics[i]
  const many = pics.length > 1
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [broken, setBroken] = useState(false)
  /** zoom (times the fitted size) and how far it is moved from the middle */
  const [v, setV] = useState({ s: 1, x: 0, y: 0 })
  const vr = useRef(v)
  vr.current = v
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pts = useRef(new Map<number, Pt>())
  const g = useRef<{ kind: 'pinch' | 'pan' | 'swipe'; d0: number; s0: number; m0: Pt; t0: Pt; moved: boolean } | null>(null)
  const lastTap = useRef(0)
  const copyable = canCopyPicture()

  /** the fitted size over the picture's own, up to 1 */
  const fit = () => {
    const el = img.current
    return el && el.naturalWidth ? Math.min(1, el.offsetWidth / el.naturalWidth) : 1
  }
  /** keep a zoomed picture over the stage: no empty space past its edges */
  const clamp = (n: typeof v) => {
    const el = img.current
    const b = box.current
    if (!el || !b || n.s <= 1.001) return { s: 1, x: 0, y: 0 }
    const mx = Math.max(0, (el.offsetWidth * n.s - b.clientWidth) / 2)
    const my = Math.max(0, (el.offsetHeight * n.s - b.clientHeight) / 2)
    return { s: n.s, x: Math.min(mx, Math.max(-mx, n.x)), y: Math.min(my, Math.max(-my, n.y)) }
  }
  /** zoom to s, keeping the point q (from the stage's middle) still */
  const zoomTo = (s: number, q: Pt = { x: 0, y: 0 }, from = vr.current) => {
    const to = clampZoom(s, fit())
    const k = to / from.s
    setV(clamp({ s: to, x: q.x - (q.x - from.x) * k, y: q.y - (q.y - from.y) * k }))
  }
  const at = (e: { clientX: number; clientY: number }): Pt => {
    const r = box.current!.getBoundingClientRect()
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
  }
  const say = (text: string, error = false) => {
    clearTimeout(noteTimer.current)
    setNote({ text, error })
    noteTimer.current = setTimeout(() => setNote(null), error ? 6000 : 1400)
  }
  const copy = () => {
    copyPicture(p.url).then(
      () => say('Copied'),
      (e: Error) => {
        // the viewer covers the toasts' corner on a phone: the bar says it too
        toast({ title: "Couldn't copy the picture", body: e.message, level: 'error' })
        say(`Couldn't copy: ${e.message}`, true)
      },
    )
  }

  useEffect(() => {
    closeBtn.current?.focus({ preventScroll: true })
    const el = box.current!
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomTo(vr.current.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), at(e))
    }
    // its own keys, before the app's (Esc would close the artifact under it)
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      let done = true
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && many) go(i - 1)
      else if (e.key === 'ArrowRight' && many) go(i + 1)
      else if ((e.key === '+' || e.key === '=') && !mod) zoomTo(vr.current.s * STEP)
      else if (e.key === '-' && !mod) zoomTo(vr.current.s / STEP)
      else if (e.key === '0' && !mod) setV({ s: 1, x: 0, y: 0 })
      else if (e.key === '1' && !mod) zoomTo(1 / fit())
      else if (e.key === 'c' && mod && copyable && !getSelection()?.toString()) copy()
      else done = false
      if (!done) return
      e.preventDefault()
      e.stopPropagation()
    }
    el.addEventListener('wheel', wheel, { passive: false })
    addEventListener('keydown', key, true)
    return () => {
      el.removeEventListener('wheel', wheel)
      removeEventListener('keydown', key, true)
      clearTimeout(noteTimer.current)
    }
  }, [i])

  const down = (e: ReactPointerEvent) => {
    if (e.button > 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pts.current.set(e.pointerId, at(e))
    const [a, b] = [...pts.current.values()]
    const t0 = { x: vr.current.x, y: vr.current.y }
    g.current = b ? { kind: 'pinch', d0: dist(a, b), s0: vr.current.s, m0: mid(a, b), t0, moved: true } : { kind: vr.current.s > 1 ? 'pan' : 'swipe', d0: 0, s0: vr.current.s, m0: a, t0, moved: false }
  }
  const move = (e: ReactPointerEvent) => {
    if (!pts.current.has(e.pointerId) || !g.current) return
    const q = at(e)
    pts.current.set(e.pointerId, q)
    const { kind, d0, s0, m0, t0 } = g.current
    if (dist(q, m0) > 6) g.current.moved = true
    if (kind === 'pinch') {
      const [a, b] = [...pts.current.values()]
      if (b) zoomTo((s0 * dist(a, b)) / d0, m0, { s: s0, ...t0 })
    } else if (kind === 'pan') setV(clamp({ s: s0, x: t0.x + q.x - m0.x, y: t0.y + q.y - m0.y }))
  }
  const up = (e: ReactPointerEvent) => {
    if (!pts.current.delete(e.pointerId)) return
    const gesture = g.current
    if (pts.current.size || !gesture) return
    g.current = null
    const q = at(e)
    if (gesture.kind === 'swipe' && gesture.moved) {
      const dx = q.x - gesture.m0.x
      if (many && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(q.y - gesture.m0.y)) go(dx < 0 ? i + 1 : i - 1)
      return
    }
    if (gesture.moved || e.type === 'pointercancel') return
    // a click: two quick ones on the picture zoom (fitted <-> its own size, there); one beside it closes
    const on = (e.target as Element).closest('img') === img.current
    if (Date.now() - lastTap.current < 300) {
      lastTap.current = 0
      if (on) zoomTo(toggledZoom(vr.current.s, fit()), q)
      return
    }
    lastTap.current = Date.now()
    if (!on && vr.current.s <= 1) onClose()
  }

  const barBtn = 'grid size-8 shrink-0 place-items-center rounded-full text-white/80 hover:bg-white/15 hover:text-white phone:size-11'
  const sideBtn = 'absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white shadow-[0_0_0_1px_rgb(255_255_255/0.12)] backdrop-blur-sm hover:bg-black/65'
  const own = { onPointerDown: (e: ReactPointerEvent) => e.stopPropagation(), onPointerUp: (e: ReactPointerEvent) => e.stopPropagation() }
  const zoomed = v.s > 1.001
  return (
    <div data-picture-viewer="" data-device={device} role="dialog" aria-modal="true" aria-label={p.name} className="fixed inset-0 z-[60] flex flex-col bg-black text-white">
      <div {...own} className="flex shrink-0 items-center gap-1 pt-[calc(env(safe-area-inset-top)+6px)] pr-2 pb-1.5 pl-4 phone:gap-0.5 phone:pl-3 [[data-topbar]~*_&]:pt-1.5">
        <div className="flex min-w-0 flex-1 flex-col phone:pr-1 sm:flex-row sm:items-baseline sm:gap-2">
          <span className="truncate text-[0.875rem] font-medium">{p.name}</span>
          <span className="shrink-0 text-[0.75rem] text-white/60 tabular-nums">
            {size ? `${size.w} × ${size.h}` : ''}
            {many ? <span className="sm:hidden">{size ? ' · ' : ''}{`${i + 1} / ${pics.length}`}</span> : null}
          </span>
        </div>
        {note ? (
          <span role="status" className={clsx('max-w-[40%] truncate text-[0.75rem] phone:absolute phone:inset-x-3 phone:top-[calc(env(safe-area-inset-top)+3.5rem)] phone:max-w-none phone:rounded-row phone:bg-black/70 phone:px-3 phone:py-2 phone:text-center', note.error ? 'text-[#ff8a80]' : 'text-white')}>{note.text}</span>
        ) : null}
        {broken ? null : (
          <>
            <button type="button" aria-label="Zoom out" disabled={!zoomed} onClick={() => zoomTo(v.s / STEP)} className={clsx(barBtn, 'disabled:opacity-40 phone:hidden')}>
              <MagnifyingGlassMinusIcon className={ic} />
            </button>
            <button type="button" aria-label={zoomed ? 'Fit to screen' : 'Actual size'} onClick={() => zoomTo(toggledZoom(v.s, fit()))}
              className="h-8 w-14 shrink-0 rounded-full text-[0.75rem] text-white/80 tabular-nums hover:bg-white/15 hover:text-white phone:h-11 phone:w-12">
              {percent(v.s, fit())}
            </button>
            <button type="button" aria-label="Zoom in" onClick={() => zoomTo(v.s * STEP)} className={clsx(barBtn, 'phone:hidden')}>
              <MagnifyingGlassPlusIcon className={ic} />
            </button>
            <span className="mx-1 h-[18px] w-px shrink-0 bg-white/20 phone:hidden" />
            {copyable ? (
              <button type="button" aria-label="Copy picture" onClick={copy} className={barBtn}>
                {note?.text === 'Copied' ? <CheckIcon className={ic} /> : <CopyIcon className={ic} />}
              </button>
            ) : null}
          </>
        )}
        <a href={p.url} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" className={barBtn}>
          <OpenIcon className={ic} />
        </a>
        <a href={p.url} download={p.file} aria-label={`Save ${p.file}`} className={barBtn}>
          <DownloadIcon className={ic} />
        </a>
        <span className="mx-1 h-[18px] w-px shrink-0 bg-white/20 phone:hidden" />
        <button ref={closeBtn} type="button" aria-label="Close" onClick={onClose} className={barBtn}>
          <XIcon className={ic} />
        </button>
      </div>
      <div
        ref={box}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className={clsx('relative min-h-0 flex-1 touch-none overflow-hidden select-none', zoomed && (g.current?.kind === 'pan' ? 'cursor-grabbing' : 'cursor-grab'))}
      >
        <div className="absolute inset-0 grid place-items-center p-6 phone:p-2">
          {broken ? (
            <p className="px-8 text-center text-white/70">This picture can't be shown here. Save it to open it.</p>
          ) : (
            <img
              ref={img}
              src={p.url}
              alt={p.name}
              draggable={false}
              onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setBroken(true)}
              style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})` }}
              className={clsx('max-h-full max-w-full object-contain shadow-2xl', zoomed ? '' : 'rounded-[4px]')}
            />
          )}
        </div>
        {many ? (
          <>
            <button {...own} type="button" aria-label="Previous picture" onClick={() => go(i - 1)} className={clsx(sideBtn, 'left-3 phone:hidden')}>
              <BackIcon className={ic} />
            </button>
            <button {...own} type="button" aria-label="Next picture" onClick={() => go(i + 1)} className={clsx(sideBtn, 'right-3 phone:hidden')}>
              <NextIcon className={ic} />
            </button>
            <div className="pointer-events-none absolute bottom-[calc(env(safe-area-inset-bottom)+14px)] left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[0.75rem] tabular-nums phone:hidden">
              {`${i + 1} / ${pics.length}`}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
