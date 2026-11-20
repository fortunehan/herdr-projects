// The artifact picture viewer's zoom, apart from React (SHEP-90); its Copy is copy.ts's copyPicture. The viewer itself
// is screens/Pictures.tsx.

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
