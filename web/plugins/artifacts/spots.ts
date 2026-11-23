// What a Mark up note is on, read from the page (SHEP-113): the recipe view (screens/Recipe.tsx) tags each block and
// its parts with their place in the recipe (data-rp); a note's spot is matched against the tags' boxes, and each tag
// is named from the recipe (core/markup.js). blockOfNode names the block around any node of the page, for notes on
// selected words or a picture.
import * as M from '@core/markup.js'

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

/** the recipe each artifact version shows now (RecipeFrame keeps it here), for Mark up laid over it */
const shown = new Map<string, unknown>()
export const recipeKey = (id: string, v: number, machine?: string | null) => `${machine ?? ''}|${id}|${v}`
export function keepRecipe(key: string, recipe: unknown) {
  if (recipe) shown.set(key, recipe)
  else shown.delete(key)
}
export const shownRecipe = (key: string) => shown.get(key) ?? null
