// The Accept card (Shepherdr 3's mods/accept-card), in 2.1's dialog: what the person approves before a Ready task
// merges. Its summary and plain-words explanation with What to check (SHEP-89), then Proof, Code changes (commits and
// files), Automatic checks and folded Technical details, all from `herdr-task show --evidence`; Accept runs `herdr-task accept`, which merges first when there is something to merge.
// A task no longer Ready says where it is now, with only Close. On a phone it slides up as a sheet.
// With a proof (SHEP-138) the card grows large and the proof shows right in it, drawn as the artifact viewer draws it
// (ArtifactFrame): beside the rest on a wide screen, its own scroll; under the summary on a narrow one, all in one
// scroll. Accept stays in view under it either way. Send back… (SHEP-87) beside it opens a note box: the task goes back
// to its agent with that note (`herdr-task send-back`), Ready to Working.
// A task with nothing to merge (SHEP-95: research or a design done in the folder itself) says Mark done and leads with
// what it made: its proof (and other artifacts) first, then the summary and explanation; its changes and checks show
// only when it has some. Its row (markDone) says so until its evidence is read.
import clsx from 'clsx'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { act, closeArtifact, getState, openArtifact, taskOf, useStore } from '../kernel.ts'
import { Dialog } from '../rowmenu.tsx'
import type { Artifact } from '@shared/types.ts'
import { DownIcon, NextIcon, OpenIcon, Primary } from '../ui.tsx'
import { Markdown } from '@plugins/chat/markdown.tsx'
import { ArtifactFrame } from '@plugins/artifacts/client.tsx'
// the card's words, the summary's cut and the details as bullets: the window's own (core/accept.js)
import * as A from '@core/accept.js'

type Evidence = {
  summary?: string
  details?: string
  /** ready's plain-words explanation (--explain), led with; absent on older tasks */
  explain?: string
  /** one short line per thing the person should check (--check) */
  to_check?: string[]
  proof?: { id: string; title: string } | null
  /** its other artifacts (a research task's report), linked beside its proof */
  artifacts?: { id: string; title: string }[]
  git?: boolean
  commits?: { count: number; list: { sha: string; subject: string }[] }
  diff?: { files: number; added: number; removed: number; list: { path: string; added: number; removed: number }[] } | null
  checks?: { state: 'passed' | 'failed' | 'running' | 'none' | 'unknown'; text: string }
  /** Accept merges its branch first (it has work to merge): the button says "Accept and merge" */
  merges?: boolean
  /** the person's answers in its proof (answers.json), listed under Details */
  choices?: { question: string; value: string; at: number; v: number }[]
}
type Shown = { ref: string; title: string; state: string; status?: string; needs?: string; attention?: string; status_text?: string; accepted_at?: number; evidence?: Evidence }

// Which task's card is open (one at a time): a small store of its own, so any row or header can open it.
let open: string | null = null
const listeners = new Set<() => void>()
export const openAccept = (task: string) => { open = task; for (const f of listeners) f() }
const close = () => { open = null; for (const f of listeners) f() }
const useOpen = () => useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f) }, () => open)
// The tasks whose accept runs now from this screen: their row and header say "Accepting…" meanwhile, as the window's
// until the snapshot says so itself (it reads Working, "Accepting…": herdr-task finishes the accept in the background)
const accepting = new Set<string>()
const setAccepting = (task: string, on: boolean) => { if (on) accepting.add(task); else accepting.delete(task); for (const f of listeners) f() }
export const useAccepting = (task: string) => useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f) }, () => accepting.has(task))

const CHECK = { passed: 'bg-ready', failed: 'bg-need', running: 'bg-work', unknown: 'bg-need', none: '' } as const

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-line pt-3">
      <h3 className="text-[0.8125rem] font-medium text-fg3 phone:text-sm">{label}</h3>
      {children}
    </section>
  )
}

function Changes({ e }: { e: Evidence }) {
  if (e.git === false) return <p className="text-fg3">{A.ACCEPT.notGit}</p>
  const c = e.commits ?? { count: 0, list: [] }, d = e.diff
  if (!c.count && !d?.files) return <p className="text-fg3">{A.ACCEPT.noCommits}</p>
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="flex flex-wrap items-center gap-x-2 tabular-nums">
        <span>{A.commitsLine(c.count)}</span>
        {d ? (
          <>
            <span className="text-fg3">·</span>
            <span>{A.filesLine(d.files)}</span>
            <span className="font-mono text-xs text-ready-fg tabular-nums">+{d.added}</span>
            <span className="font-mono text-xs text-need-fg tabular-nums">−{d.removed}</span>
          </>
        ) : <span className="text-need-fg">{A.ACCEPT.noFiles}</span>}
      </p>
      {c.list.length ? (
        <ul role="list" className="flex min-w-0 flex-col gap-0.5">
          {c.list.map((x) => (
            <li key={x.sha} className="flex min-w-0 gap-2">
              <span className="shrink-0 font-mono text-xs/5 text-fg3">{x.sha}</span>
              <span className="min-w-0 truncate">{x.subject}</span>
            </li>
          ))}
          {c.count > c.list.length ? <li className="text-xs text-fg3 tabular-nums">{A.moreLine(c.count - c.list.length)}</li> : null}
        </ul>
      ) : null}
      {d?.list?.length ? (
        <ul role="list" className="flex min-w-0 flex-col gap-0.5 font-mono text-xs/5 text-fg2">
          {d.list.map((f) => <li key={f.path} className="truncate">{f.path}</li>)}
          {d.files > d.list.length ? <li className="font-sans text-fg3 tabular-nums">{A.moreLine(d.files - d.list.length)}</li> : null}
        </ul>
      ) : null}
    </div>
  )
}

// What the card leads with: the summary, then (SHEP-89) the plain-words explanation at reading size and What to check
// as a short list. A task without them (an older ready) shows its summary alone, as before.
function Lead({ summary, e }: { summary: string; e: Evidence }) {
  const s = A.simple(e) as { explain: string; toCheck: string[] }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className={clsx('max-w-[560px] text-pretty', !summary && 'text-fg3', s.explain && 'text-[1.0625rem]/6 font-semibold')}>{summary || A.ACCEPT.noSummary}</p>
      {s.explain ? (
        <div data-selectable className="flex max-w-[560px] flex-col gap-2 text-[0.9375rem]/6 text-pretty text-fg phone:text-base/7">
          {(A.paragraphs(s.explain) as string[]).map((x, i) => <p key={i}>{x}</p>)}
        </div>
      ) : null}
      {s.toCheck.length ? (
        <section aria-label={A.ACCEPT.toCheck} className="flex max-w-[560px] flex-col gap-1.5 rounded-box bg-well px-3 py-2.5">
          <h3 className="text-[0.8125rem] font-medium text-fg3 phone:text-sm">{A.ACCEPT.toCheck}</h3>
          <ul role="list" data-selectable className="flex flex-col gap-1">
            {s.toCheck.map((x, i) => (
              <li key={i} className="flex gap-2 text-pretty">
                <span aria-hidden className="mt-[0.45em] size-[7px] shrink-0 rounded-full border border-fg3" />
                <span className="min-w-0">{x}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

// The proof right in the card, as the viewer draws it: a quiet line with its title and a small Open ↗ (the viewer,
// over the card), over the proof in a well. Wide: it fills its column and scrolls inside; narrow: as tall as it is.
function InlineProof({ art, headWide }: { art: Artifact; /** its title line only on a wide card (a narrow one leads with it already) */ headWide?: boolean }) {
  return (
    <section aria-label={A.ACCEPT.proof} className="flex min-w-0 flex-col gap-1.5 @3xl:min-h-0 @3xl:flex-1">
      <div className={clsx('min-w-0 items-center gap-2', headWide ? 'hidden @3xl:flex' : 'flex')}>
        <h3 className="shrink-0 text-[0.8125rem] font-medium text-fg3 phone:text-sm">{A.ACCEPT.proof}</h3>
        <p className="min-w-0 flex-1 truncate text-[0.8125rem] text-fg2 phone:text-sm">{A.proofTitle(art.title).replace(/\s*·\s*Proof$/i, '')}</p>
        <button type="button" onClick={() => openArtifact(art.id)} className="press-dim -my-1 flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-fg3 hover:bg-hover hover:text-fg phone:h-9 phone:text-[0.8125rem]">
          {A.ACCEPT.open}
          <OpenIcon className="size-3.5 shrink-0" />
        </button>
      </div>
      <div className="relative min-w-0 overflow-hidden rounded-box bg-bg shadow-[inset_0_0_0_1px_var(--line2)] @3xl:min-h-0 @3xl:flex-1">
        <div className="@3xl:absolute @3xl:inset-0">
          <ArtifactFrame art={art} v={art.v} full />
        </div>
      </div>
    </section>
  )
}

// An artifact (its proof, or another it published) over the card, in the viewer; closing it comes back here
function ArtifactRow({ a }: { a: { id: string; title: string } }) {
  return (
    <button type="button" onClick={() => openArtifact(a.id)} className="press-dim flex h-9 w-full items-center gap-2 rounded-[var(--row-radius)] bg-well px-2.5 text-left shadow-soft hover:bg-hover phone:h-11">
      <span className="min-w-0 flex-1 truncate">{A.proofTitle(a.title)}</span>
      <span className="shrink-0 text-xs text-fg3">{A.ACCEPT.open}</span>
      <OpenIcon className="size-3.5 shrink-0 text-fg3" />
    </button>
  )
}

export function AcceptCard() {
  const task = useOpen()
  const current = useStore((s) => (task && s.snap ? taskOf(s.snap, task) : undefined))
  const named = current?.name
  const artifacts = useStore((s) => s.snap?.artifacts)
  const [t, setT] = useState<Shown | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState(false)
  /** Send back's note while its box is open, else null */
  const [back, setBack] = useState<string | null>(null)

  useEffect(() => {
    setT(null); setError(null); setBusy(false); setDetails(false); setBack(null)
    if (!task) return
    let gone = false
    act({ type: 'evidence', task } as never).then((x) => !gone && setT(x as Shown), (e) => !gone && setError(String(e?.message ?? e)))
    return () => { gone = true }
  }, [task, current?.status, current?.acceptAgain])

  if (!task) return null
  const ready = A.canAccept(t) && (current?.status === 'ready' || !!current?.acceptAgain)
  const e = t?.evidence ?? {}
  // nothing to merge: Mark done, what it made first (its evidence once read, its row until then)
  const hint = !!current?.markDone
  const done = A.markDone(e, hint) as boolean
  // its proof as the app knows it, to draw in the card; one it doesn't know (yet) stays a row that opens it
  const proofArt = e.proof ? artifacts?.find((a) => a.id === e.proof!.id) : undefined

  const accept = async () => {
    if (!ready || busy) return
    setBusy(true); setError(null); setAccepting(task, true)
    try {
      await act({ type: 'accept', task } as never)
      // done: the next snapshot moves it out of Ready; until then its row still says Accepting…
      setTimeout(() => setAccepting(task, false), 15000)
      close()
    } catch (err) {
      setAccepting(task, false)
      setError(String((err as Error)?.message ?? err))
      // accepted (or changed) from elsewhere meanwhile: show where it is now, not the refusal
      const now = (await act({ type: 'evidence', task } as never).catch(() => null)) as Shown | null
      if (now && !A.canAccept(now)) { setT(now); setError(null) }
      setBusy(false)
    }
  }

  // Send back: the note to its agent, Ready back to Working; the card closes once it went
  const sendBack = async () => {
    const note = (back ?? '').trim()
    if (!ready || busy || !note) return
    setBusy(true); setError(null)
    try {
      await act({ type: 'send-back', task, note } as never)
      close()
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
      const now = (await act({ type: 'evidence', task } as never).catch(() => null)) as Shown | null
      if (now && !A.canAccept(now)) { setT(now); setError(null); setBack(null) }
      setBusy(false)
    }
  }

  // as the window's card: "Accept HERD-4?" while it can be accepted, only its ref once settled; its name under it
  const ref = t?.ref ?? task
  const settled = !!t && !ready
  const w = A.words(e) as { summary: string; details: string }
  // the answered choices first, then the agent's details
  const more = A.detailsText(e, w.details) as string
  // Escape over the proof (the viewer sits over this card) closes the proof, back to the card as it was; with Send
  // back's box open it closes the box
  const cancel = () => (getState().ui.viewer ? closeArtifact() : back !== null ? setBack(null) : close())
  // what follows the lead (and the proof, when it shows in the card)
  const artifactRows = e.artifacts?.length ? (
    <Section label={A.ACCEPT.artifacts}>
      <div className="flex flex-col gap-1.5">{e.artifacts.map((a) => <ArtifactRow key={a.id} a={a} />)}</div>
    </Section>
  ) : null
  // what a nothing-to-merge task made, before its lead: its proof as a row (drawn in the card too, on a wide one beside
  // it already), then its other artifacts
  const made = (
    <div className={clsx('flex min-w-0 flex-col gap-4', proofArt && !e.artifacts?.length && '@3xl:hidden')}>
      <section className={clsx('flex flex-col gap-1.5', proofArt && '@3xl:hidden')}>
        <h3 className="text-[0.8125rem] font-medium text-fg3 phone:text-sm">{A.ACCEPT.proof}</h3>
        {e.proof ? <ArtifactRow a={e.proof} /> : <p className="text-fg3">{A.ACCEPT.noProof}</p>}
      </section>
      {artifactRows}
    </div>
  )
  const rest = (
    <>
      {proofArt || done ? null : (
        <Section label={A.ACCEPT.proof}>
          {e.proof ? <ArtifactRow a={e.proof} /> : <p className="text-fg3">{A.ACCEPT.noProof}</p>}
        </Section>
      )}
      {done ? null : artifactRows}
      {!done || A.hasChanges(e) ? <Section label={A.ACCEPT.changes}><Changes e={e} /></Section> : null}
      {!done || A.hasChecks(e) ? (
        <Section label={A.ACCEPT.checks}>
          <p className="flex items-center gap-2">
            {e.checks && e.checks.state !== 'none' ? <span className={clsx('size-[7px] shrink-0 rounded-full', CHECK[e.checks.state])} /> : null}
            <span className={clsx(!e.checks || e.checks.state === 'none' ? 'text-fg3' : '')}>{e.checks?.text ?? A.ACCEPT.noChecks}</span>
          </p>
        </Section>
      ) : null}
      {more ? (
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          <button type="button" aria-expanded={details} onClick={() => setDetails(!details)} className="flex items-center gap-1.5 self-start text-[0.8125rem] font-medium text-fg3 hover:text-fg phone:text-sm">
            {details ? <DownIcon className="size-3.5 shrink-0" /> : <NextIcon className="size-3.5 shrink-0" />}
            {A.ACCEPT.details}
          </button>
          {details ? <div data-selectable className="pl-5"><Markdown text={A.readable(more)} /></div> : null}
        </section>
      ) : null}
    </>
  )

  return (
    <Dialog title={settled ? ref : A.cardTitle(ref, e, hint)} sub={t?.title ?? named ?? ''} closer wide large={!!proofArt} onCancel={cancel} safe
      cancel={settled ? A.ACCEPT.close : A.ACCEPT.cancel}
      foot={t && (error || settled || (back !== null && !settled)) ? (
        <>
          {back !== null && !settled ? (
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-fg">{A.ACCEPT.sendBackAsk}</span>
              <textarea autoFocus rows={3} value={back} onChange={(ev) => setBack(ev.target.value)} disabled={busy}
                onKeyDown={(ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void sendBack() } }}
                className="w-full resize-y rounded-[var(--row-radius)] bg-bg px-3 py-2 text-fg shadow-[inset_0_0_0_1px_var(--line2)] outline-none focus:shadow-[inset_0_0_0_1px_var(--fg3)]" />
              <span className="text-fg3">{A.ACCEPT.sendBackHint}</span>
            </label>
          ) : null}
          {error ? <p role="alert" className="text-need-fg">{error}</p> : null}
          {settled ? (
            <p className="flex items-center gap-2 text-fg"><span className={clsx('size-[7px] shrink-0 rounded-full', t.state === 'done' ? 'bg-ready' : 'bg-fg3')} />{A.whereNow(t)}</p>
          ) : null}
        </>
      ) : null}
      // Accept shows while it is read too, not yet pressable; once settled only Close is left
      buttons={settled ? null : back !== null ? (
        <Primary disabled={!ready || busy || !back.trim()} onClick={sendBack}>{busy ? A.ACCEPT.sendingBack : A.ACCEPT.sendBackGo}</Primary>
      ) : (
        <>
          <Primary soft disabled={!ready || busy} onClick={() => setBack('')}>{A.ACCEPT.sendBack}</Primary>
          <Primary disabled={!ready || busy} onClick={accept}>{busy ? A.busyLabel(e, hint) : A.acceptLabel(e, hint)}</Primary>
        </>
      )}>
      {!t ? (
        <div className="pt-2 pb-1"><p className={error ? 'text-need-fg' : 'text-fg3'} role={error ? 'alert' : undefined}>{error ?? A.ACCEPT.reading}</p></div>
      ) : proofArt ? (
        // wide: the proof on the left over the card's height, the lead and the rest beside it in one scroll; narrow:
        // one scroll, the lead, then the proof, then the rest (the column is `contents` there, its parts ordered)
        <div className="@container flex min-h-0 flex-1 flex-col pt-2 text-fg">
          <div className="min-h-0 flex-1 overflow-y-auto @3xl:overflow-hidden">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 pb-1 @3xl:h-full @3xl:grid-cols-[minmax(0,1fr)_360px] @3xl:grid-rows-[minmax(0,1fr)] @3xl:gap-x-6 @3xl:pb-0">
              <div className="order-2 @3xl:order-none @3xl:col-start-1 @3xl:row-start-1 @3xl:flex @3xl:min-h-0 @3xl:flex-col"><InlineProof art={proofArt} headWide={done} /></div>
              <div className="contents @3xl:col-start-2 @3xl:row-start-1 @3xl:flex @3xl:min-h-0 @3xl:min-w-0 @3xl:flex-col @3xl:gap-4 @3xl:overflow-y-auto @3xl:pb-1">
                {done ? <div className="order-0 @3xl:order-none">{made}</div> : null}
                <div className="order-1 @3xl:order-none"><Lead summary={w.summary} e={e} /></div>
                <div className="order-3 flex min-w-0 flex-col gap-4 @3xl:order-none">{rest}</div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex max-h-[60dvh] min-w-0 flex-col gap-4 overflow-y-auto pt-2 pb-1 text-fg">
          {done ? made : null}
          <Lead summary={w.summary} e={e} />
          {rest}
        </div>
      )}
    </Dialog>
  )
}

// A link straight to a task's card (a notification's Accept): #accept=<task id>
function fromLink(hash: string) {
  const m = /^#accept=(.+)$/.exec(hash)
  if (m) openAccept(decodeURIComponent(m[1]))
}
if (typeof window !== 'undefined') {
  // index.html keeps the first one, before the app writes its own address
  fromLink((window as { shepherdrLink?: string }).shepherdrLink ?? '')
  addEventListener('hashchange', () => fromLink(location.hash))
  // an alert's Accept opened in this page (kernel openGo: the phone app's tap, or a tap with the app open)
  addEventListener('shepherdr:accept', (e) => typeof (e as CustomEvent).detail === 'string' && openAccept((e as CustomEvent).detail))
}
