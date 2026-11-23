// What a Mark up note is on, read from the page (SHEP-113): the recipe view (screens/Recipe.tsx) tags each block and
// its parts with their place in the recipe (data-rp); a note's spot is matched against the tags' boxes, and each tag
// is named from the recipe (core/markup.js). blockOfNode names the block around any node of the page, for notes on
// selected words or a picture.
import * as M from '@core/markup.js'
import type { Action, NoteOn } from '@shared/types.ts'

type Box = { left: number; top: number; width: number; height: number }
/** the little of a DOM element this needs (a test passes plain objects) */
export type Tagged = { getAttribute(name: string): string | null; getBoundingClientRect(): Box; closest?(sel: string): Tagged | null }
type Root = { querySelectorAll(sel: string): ArrayLike<Tagged> | Iterable<Tagged> }
export type Target = { path: string; kind: string; text: string; file?: string }
export type On = { blocks: Target[]; more: number }
type Spot = { x: number; y: number; w: number; h: number }

const { keysUnder, noteOn, recipeTarget } = M as unknown as {
  keysUnder: (nodes: unknown[], spot: Spot) => string[]
  noteOn: (recipe: unknown, nodes: unknown[], spot: Spot) => On | null
  recipeTarget: (recipe: unknown, key: string) => Target | null
}

/** every tag's box under root, in px from origin (the Mark up layer's top left), in page order */
export function tagBoxes(root: Root, origin: { left: number; top: number }) {
  return Array.from(root.querySelectorAll('[data-rp]') as Iterable<Tagged>).flatMap((el) => {
    const key = el.getAttribute('data-rp')
    const r = el.getBoundingClientRect()
    return key ? [{ key, x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }] : []
  })
}

/** what a spot of the layer is on: the recipe's blocks under it, or null (not a recipe, or on nothing) */
export function noteOnPage(root: Root, origin: { left: number; top: number }, recipe: unknown, spot: Spot): On | null {
  return recipe ? noteOn(recipe, tagBoxes(root, origin), spot) : null
}

/** the tags a spot is on (their places), for a caller that names them its own way */
export const tagsUnder = (root: Root, origin: { left: number; top: number }, spot: Spot) => keysUnder(tagBoxes(root, origin), spot)

/** the block (or part of one) around a node of the recipe view: its path in recipe.json, kind and excerpt */
export function blockOfNode(node: Tagged | null | undefined, recipe: unknown): Target | null {
  const el = node?.closest?.('[data-rp]')
  const key = el?.getAttribute('data-rp')
  return key && recipe ? recipeTarget(recipe, key) : null
}

// ---- notes stay on what they marked (SHEP-115) ---------------------------------------------------------------------
// The recipe scrolls under the still Mark up layer: a note keeps its spot as fractions of the whole content and of the
// tag it starts on (core/markup.js anchorOf), and is drawn where that tag is now (placeNote).

/** the recipe view's scrolling box (RecipeFrame's, data-recipe-scroll): the little of it this needs */
export type Scroller = { getBoundingClientRect(): Box; scrollTop: number; scrollLeft: number; scrollWidth: number; scrollHeight: number }
/** where the content is: its top left in px from origin (above it once scrolled) and its whole size */
export type View = { x: number; y: number; width: number; height: number; page?: boolean }

/** the recipe's whole content seen from the layer (origin: its top left); without a recipe, the layer itself */
export function contentView(scroller: Scroller | null | undefined, origin: Box): View {
  if (!scroller) return { x: 0, y: 0, width: origin.width, height: origin.height }
  const r = scroller.getBoundingClientRect()
  return { x: r.left - origin.left - scroller.scrollLeft, y: r.top - origin.top - scroller.scrollTop, width: Math.max(r.width, scroller.scrollWidth), height: Math.max(r.height, scroller.scrollHeight), page: true }
}

/** a tag's box now, in px from origin, or null when the page doesn't draw it (another tab, a closed details) */
export function tagBox(root: { querySelector(sel: string): Tagged | null }, origin: { left: number; top: number }, key: string): Spot | null {
  const el = root.querySelector(`[data-rp="${key.replace(/["\\]/g, '')}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height } : null
}

const { anchorOf, contentFrac } = M as unknown as {
  anchorOf: (nodes: unknown[], s: Spot, rects?: Spot[]) => Anchor | null
  contentFrac: (s: Spot, view: View) => Spot
}
export type Anchor = { key: string; x: number; y: number; w: number; h: number; rects?: Spot[] }

/** a spot of the layer (px), and the boxes of selected words, as a note keeps them: fractions of the content, and the
 *  tag it starts on (root: the page under the layer) */
export function keptSpot(root: Root | null | undefined, origin: Box, view: View, s: Spot, rects?: Spot[]): Spot & { anchor?: Anchor; rects?: Spot[] } {
  const anchor = root ? anchorOf(tagBoxes(root, origin), s, rects) : null
  return { ...contentFrac(s, view), ...(anchor ? { anchor } : {}), ...(rects ? { rects: rects.map((r) => contentFrac(r, view)) } : {}) }
}

/** the recipe each artifact version shows now (RecipeFrame keeps it here), for Mark up laid over it */
const shown = new Map<string, unknown>()
export const recipeKey = (id: string, v: number, machine?: string | null) => `${machine ?? ''}|${id}|${v}`
export function keepRecipe(key: string, recipe: unknown) {
  if (recipe) shown.set(key, recipe)
  else shown.delete(key)
}
export const shownRecipe = (key: string) => shown.get(key) ?? null

// ---- Comment on selected words or on a picture (SHEP-114) ----------------------------------------------------------
// The recipe view's words select as ever: Comment beside a selection, or on a picture, opens Mark up with a note
// already on it. A note on words keeps the quote, a little of its block's text on each side and the boxes it was
// highlighted in; one on a picture names the picture (its file, place, caption and own size).

const { quoteOf, pictureAt, cleanPicture } = M as unknown as {
  quoteOf: (selected: string, prefix?: string, rest?: string) => { text: string; before: string; after: string } | null
  pictureAt: (recipe: unknown, key: string) => Picture | null
  cleanPicture: (p: unknown) => Picture | null
}

export type Picture = { file: string; path?: string; caption?: string; alt?: string; width?: number; height?: number }
/** a note to start in Mark up: its spot in px of the layer, and what it is on */
export type Seed = {
  spot: Spot
  on?: On
  quote?: { text: string; before: string; after: string; rects: Spot[] }
  picture?: Picture & { spot?: Spot }
}

/** selected words as the page has them: the words, the text before and after them in their block, the boxes they
 *  are drawn in and the elements they start and end in */
export type Selected = { text: string; prefix: string; rest: string; rects: Box[]; start: Tagged | null; end: Tagged | null }

const boxIn = (r: Box, origin: { left: number; top: number }): Spot => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height })

/** a note on selected words: the quote and its context, the block(s) it is in, the boxes to highlight and the box
 *  round them all as its spot; null when nothing of the recipe is selected */
export function quoteSeed(sel: Selected, origin: { left: number; top: number }, recipe: unknown): Seed | null {
  const quote = quoteOf(sel.text, sel.prefix, sel.rest)
  const first = blockOfNode(sel.start, recipe)
  if (!quote || !first) return null
  const last = blockOfNode(sel.end, recipe)
  const blocks = last && last.path !== first.path ? [first, last] : [first]
  // a line's box often comes twice (the text and its element): each kept once
  const seen = new Set<string>()
  const rects = sel.rects.filter((r) => r.width > 0 && r.height > 0).map((r) => boxIn(r, origin)).filter((r) => {
    const k = [r.x, r.y, r.w, r.h].map(Math.round).join(',')
    return seen.has(k) ? false : (seen.add(k), true)
  }).slice(0, 40)
  if (!rects.length) return null
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { spot: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, on: { blocks, more: 0 }, quote: { ...quote, rects } }
}

/** a picture element of the page (an <img data-pic>): what the little this needs */
export type PicEl = Tagged & { naturalWidth?: number; naturalHeight?: number; alt?: string }

/** a picture of the recipe view: its file, place and caption from the recipe, its own size and alt from the page */
export function pictureOf(el: PicEl, recipe: unknown): Picture | null {
  const key = el.closest?.('[data-rp]')?.getAttribute('data-rp')
  const p = key && recipe ? pictureAt(recipe, key) : null
  if (!p) return null
  return cleanPicture({ ...p, alt: el.alt && el.alt !== p.caption ? el.alt : undefined, width: el.naturalWidth || p.width, height: el.naturalHeight || p.height })
}

/** every picture of the recipe view under root, its box in px from origin (the Mark up layer's top left) */
export function picturesOnPage(root: { querySelectorAll(sel: string): ArrayLike<PicEl> | Iterable<PicEl> }, origin: { left: number; top: number }, recipe: unknown) {
  return Array.from(root.querySelectorAll('img[data-pic]') as Iterable<PicEl>).flatMap((el) => {
    const p = pictureOf(el, recipe)
    return p ? [{ ...boxIn(el.getBoundingClientRect(), origin), ...p }] : []
  })
}

/** a note on a whole picture: its box as the spot */
export function pictureSeed(el: PicEl, origin: { left: number; top: number }, recipe: unknown): Seed | null {
  const picture = pictureOf(el, recipe)
  return picture ? { spot: boxIn(el.getBoundingClientRect(), origin), picture } : null
}

type Out = { text: string; spot: string } & NoteOn
/** what Send all asks the service for (core/markup.js outgoing's result): each note's words, spot and what it is on */
export function noteAction(out: { kind: 'say'; text: string } | ({ kind: 'note' } & Out) | { kind: 'notes'; notes: Out[]; text: string }, base: { place: string; artifact: string; v: number }): Action {
  const on = (n: Out): NoteOn => ({
    ...(n.blocks ? { blocks: n.blocks, more: n.more ?? 0 } : {}),
    ...(n.quote ? { quote: n.quote } : {}),
    ...(n.picture ? { picture: n.picture } : {}),
  })
  if (out.kind === 'say') return { type: 'artifact-say', ...base, text: out.text }
  if (out.kind === 'note') return { type: 'artifact-note', ...base, note: out.text, target: out.spot, ...on(out) }
  return { type: 'artifact-note', ...base, notes: out.notes.map((n) => ({ note: n.text, target: n.spot, ...on(n) })), text: out.text }
}
