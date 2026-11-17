/** Spaces rows and folded headings keep exact counts in their accessible name. */
export function SpaceCounts({ need: allNeed, ready: allReady, scope, look }: { need: number; ready: number; scope: string; look?: { red?: boolean; green?: boolean } }) {
  const need = look?.red === false ? 0 : allNeed, ready = look?.green === false ? 0 : allReady
  if (!need && !ready) return null
  const cap = (n: number) => n > 9 ? '9+' : String(n)
  return (
    <span role="img" aria-label={`${need} needs you, ${ready} ready · ${scope}`} data-space-counts
      className="inline-flex h-4 shrink-0 items-center gap-2 text-[11px] font-bold tabular-nums phone:h-[18px] phone:text-[12px]">
      {need > 0 ? <span aria-hidden="true" className="text-need-fg">{cap(need)}</span> : null}
      {ready > 0 ? <span aria-hidden="true" className="text-ready-fg">{cap(ready)}</span> : null}
    </span>
  )
}

/** A space's tasks at work, before its red and green counts. */
export function WorkingCount({ n }: { n: number }) {
  return (
    <span aria-hidden data-working={n} className="flex shrink-0 items-center gap-0.5 text-[0.75rem] text-work tabular-nums phone:text-[0.8125rem]">
      <svg viewBox="0 0 16 16" className="size-2.5 shrink-0 animate-spin motion-reduce:animate-none">
        <path d="M14 8A6 6 0 1 1 8 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {n > 9 ? '9+' : n}
    </span>
  )
}
