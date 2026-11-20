// The artifact picture viewer's logic, apart from React (SHEP-90): its zoom steps, copying a picture to the clipboard
// as PNG (the one picture type every browser's clipboard takes), and what each failure says. The viewer itself is
// screens/Pictures.tsx.

/** one zoom step (buttons, keys), and the most a picture is magnified (800%, as the window's viewer) */
export const STEP = 1.25
export const MAX = 8

/** a zoom of `s` times the fitted size, kept between fitted (1) and 800% of the picture's own pixels; `fit`: the
 *  fitted size over the picture's own (up to 1) */
export const clampZoom = (s: number, fit: number) => Math.min(Math.max(1, MAX / Math.max(fit, 1e-6)), Math.max(1, s))

/** the % the toolbar shows: the picture's drawn size over its own */
export const percent = (s: number, fit: number) => `${Math.round(s * fit * 100)}%`

/** fitted <-> 100% (the % button, "1" / "0", a double click): from fitted to its own size, else back to fitted. A
 *  picture smaller than the screen is already at 100% fitted: it zooms to twice that. */
export const toggledZoom = (s: number, fit: number) => (s > 1.001 ? 1 : fit < 0.999 ? 1 / fit : 2)

/** what the browser lends the viewer for Copy */
export type ClipEnv = {
  secure: boolean
  write?: (items: unknown[]) => Promise<void>
  Item?: new (parts: Record<string, Promise<Blob> | Blob>) => unknown
}

const browser = (): ClipEnv => ({
  secure: typeof window !== 'undefined' && window.isSecureContext,
  write: typeof navigator !== 'undefined' && navigator.clipboard?.write ? (items) => navigator.clipboard.write(items as ClipboardItem[]) : undefined,
  Item: typeof ClipboardItem === 'undefined' ? undefined : (ClipboardItem as unknown as ClipEnv['Item']),
})

/** whether Copy can work here: a page over https (or this computer) whose browser can put a picture on the clipboard.
 *  Over plain http it can't, so the button isn't there at all. */
export const canCopyPicture = (env: ClipEnv = browser()) => env.secure && !!env.write && !!env.Item

/** Puts the picture at `url` on the clipboard as a PNG. The clipboard is asked for at once, in the click, with the
 *  picture still to come (Safari forgets the click after an await); a non-PNG is drawn into a PNG first. Throws a
 *  plain-words Error (copyProblem). */
export async function copyPicture(url: string, toPng: (b: Blob) => Promise<Blob> = pngOf, env: ClipEnv = browser()) {
  if (!canCopyPicture(env)) throw new Error(copyProblem(null, env))
  const png = fetch(url)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`the picture didn't load (${r.status})`))))
    .then(toPng)
  // the clipboard reads it; a browser that refused first never does
  png.catch(() => undefined)
  try {
    await env.write!([new env.Item!({ 'image/png': png })])
  } catch (e) {
    throw new Error(copyProblem(e, env))
  }
}

/** why Copy failed, in plain words */
export function copyProblem(e: unknown, env: ClipEnv = browser()) {
  if (!env.secure) return 'Copying a picture needs the app over https.'
  if (!env.write || !env.Item) return "This browser can't put a picture on the clipboard: save it instead."
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError') return "The browser didn't allow it: click the picture, then Copy again."
  const msg = String((e as Error)?.message ?? '').trim()
  return msg ? `${msg[0].toUpperCase()}${msg.slice(1)}${/[.!?]$/.test(msg) ? '' : '.'}` : 'Something went wrong.'
}

/** a picture drawn into a PNG (an SVG with no size of its own at 1024 wide) */
async function pngOf(b: Blob): Promise<Blob> {
  if (b.type === 'image/png') return b
  const url = URL.createObjectURL(b)
  try {
    const img = new Image()
    img.src = url
    await img.decode().catch(() => Promise.reject(new Error("the browser can't read this picture")))
    const w = img.naturalWidth || 1024
    const h = img.naturalHeight || Math.round(w * 0.75)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')!.drawImage(img, 0, 0, w, h)
    return await new Promise<Blob>((ok, no) => c.toBlob((x) => (x ? ok(x) : no(new Error("the picture couldn't be made a PNG"))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}
