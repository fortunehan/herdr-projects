// Full screen for an artifact (SHEP-90): the browser's own (the Fullscreen API: no tabs, no address bar, no dock), on
// the element given; where the browser has none for an element (an iPhone's Safari) or refuses it, the element fills
// the page instead ("page": the caller lays it over everything and hides its own bar). Esc and the same button leave
// either: the browser's own leaves on Esc by itself, the page's listens for it.
import { useEffect, useState, type RefObject } from 'react'

type Doc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenEnabled?: boolean }
type El = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

/** what full screen there is here: the browser's own on an element, or only filling the page */
export function fullscreenWay(doc: Pick<Doc, 'fullscreenEnabled' | 'webkitFullscreenEnabled'> | undefined, el: Pick<El, 'requestFullscreen' | 'webkitRequestFullscreen'> | undefined): 'browser' | 'page' {
  const can = !!(doc?.fullscreenEnabled || doc?.webkitFullscreenEnabled)
  return can && !!(el?.requestFullscreen || el?.webkitRequestFullscreen) ? 'browser' : 'page'
}

const shownFull = () => {
  const d = document as Doc
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null
}

/** Esc goes to whatever is over a page-filled artifact first (its picture viewer) */
const covered = () => !!document.querySelector('[data-picture-viewer]')

/** Full screen for the element in `ref`: { on, how, toggle }. how: which kind is on ('browser' or 'page'), null when
 *  off. It ends when the element goes (the artifact closed). */
export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [page, setPage] = useState(false)
  const [browser, setBrowser] = useState(false)
  useEffect(() => {
    const el = ref.current
    const sync = () => setBrowser(!!el && shownFull() === el)
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
      // closed while full screen: the browser's ends with it
      if (el && shownFull() === el) void exit()
    }
  }, [ref])
  useEffect(() => {
    if (!page) return
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || covered()) return
      e.preventDefault()
      e.stopPropagation()
      setPage(false)
    }
    addEventListener('keydown', esc, true)
    return () => removeEventListener('keydown', esc, true)
  }, [page])
  const toggle = () => {
    if (page) return setPage(false)
    if (browser) return void exit()
    const el = ref.current as El | null
    if (!el) return
    if (fullscreenWay(document as Doc, el) === 'page') return setPage(true)
    // asked in the click itself (a browser forgets the click after an await); refused (a frame not allowed it): the
    // page's instead
    try {
      Promise.resolve(el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen!()).catch(() => setPage(true))
    } catch {
      setPage(true)
    }
  }
  return { on: page || browser, how: page ? ('page' as const) : browser ? ('browser' as const) : null, toggle }
}

function exit() {
  const d = document as Doc
  return Promise.resolve()
    .then(() => (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.()))
    .catch(() => undefined)
}
