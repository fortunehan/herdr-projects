// SHEP-111: a full-screen artifact's recipe (Recipe.tsx; here in screens/ so the viewer's styles see its classes): centred, words at most FULL_TEXT px wide (core/recipe.js),
// pictures, pairs, columns and clips the whole width, each picture at most its own size; not full screen, as before.
import * as R from '@core/recipe.js'

const { fullWide, FULL_TEXT } = R as any

export { FULL_TEXT }

/** a block's own width full screen: words capped and centred, the rest the whole width; not full screen nothing */
export function fullStyle(b: { type?: string } | null | undefined, full: boolean): { className?: string; style?: { maxWidth: number } } {
  if (!full) return {}
  return fullWide(b) ? { className: 'mx-auto w-full' } : { className: 'mx-auto w-full', style: { maxWidth: FULL_TEXT } }
}

/** the pair's two sides full screen: side by side at most their own sizes, the pair centred; else two equal halves */
export const pairGrid = (full: boolean) => (full ? 'justify-center @lg:grid-cols-[repeat(2,minmax(0,max-content))]' : '@lg:grid-cols-2')

/** a picture's place in its column: centred full screen, else at the start */
export const picturePlace = (full: boolean) => (full ? 'self-center' : 'self-start')
