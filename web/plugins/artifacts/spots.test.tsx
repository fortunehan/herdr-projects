// SHEP-113: a Mark up note on a recipe names the blocks it is on. The web's recipe view tags each block and its parts
// with their place in the recipe (data-rp); Mark up matches its spot against the tags' boxes.
import { afterAll, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { blockOfNode, keepRecipe, noteOnPage, recipeKey, shownRecipe, tagBoxes, tagsUnder, type Tagged } from './spots.ts'
import * as M from '@core/markup.js'

const recipeTarget = (M as any).recipeTarget as (r: unknown, k: string) => unknown

// the recipe view's Markdown loads kernel.ts, which reads the page as it loads: the little it needs, for this file only
const g = globalThis as Record<string, unknown>
const noop = () => {}
const stand: Record<string, unknown> = {
  location: new URL('http://app.test/'),
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  addEventListener: noop,
  removeEventListener: noop,
  innerWidth: 1280,
  innerHeight: 800,
  history: { replaceState: noop, pushState: noop, state: null },
  document: { head: { innerHTML: '' }, visibilityState: 'visible', addEventListener: noop, documentElement: { style: {}, dataset: {} } },
}
const had = Object.keys(stand).filter((k) => k in g)
for (const k of Object.keys(stand)) if (!had.includes(k)) g[k] = stand[k]
afterAll(() => {
  for (const k of Object.keys(stand)) if (!had.includes(k)) delete g[k]
})
// and the chat's Markdown needs a browser's DOM (DOMPurify): plain words stand in for it (no other test loads it)
mock.module(join(import.meta.dir, '../chat/markdown.tsx'), () => ({ Markdown: ({ text }: { text: string }) => <span>{text}</span>, TrLine: () => null }))
const { Recipe } = await import('../../src/screens/Recipe.tsx')

const recipe = {
  blocks: [
    { type: 'heading', id: 'h', text: 'Release plan' },
    { type: 'list', id: 'l', items: ['One', 'Two'] },
    { type: 'table', id: 'tb', columns: ['Name', 'Count'], rows: [['Alpha', 12], ['Beta', 9]] },
    { type: 'image', id: 'im', src: 'shots/login.png', caption: 'Sign-in screen' },
    { type: 'columns', id: 'c', columns: [[{ type: 'text', id: 'x', md: 'left' }], [{ type: 'stats', id: 's', items: [{ label: 'Lines', value: '92%' }] }]] },
    { type: 'tabs', id: 'tt', tabs: [{ label: 'A', blocks: [{ type: 'code', id: 'cd', text: 'npm test' }] }] },
    { type: 'choice', id: 'ch', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
    { type: 'form', id: 'f', fields: [{ name: 'who' }] },
    { type: 'buttons', id: 'bs', items: [{ label: 'Go', reply: 'go' }] },
    { type: 'pair', id: 'pr', before: { src: 'a.png' }, after: { src: 'b.png', caption: 'New' } },
  ],
}

test('the recipe view tags every block and its parts with a place the recipe names', () => {
  const html = renderToStaticMarkup(<Recipe recipe={recipe} asset={(s) => s} />)
  const tags = [...html.matchAll(/data-rp="([^"]+)"/g)].map((m) => m[1])
  for (const k of ['0', '1', '1/items.1', '2', '2/columns', '2/rows.0', '2/rows.1', '3', '4', '4/columns.1', '4.c0.0', '4.c1.0', '4.c1.0/items.0', '5', '5/tabs.0', '5.t0.0', '6/options.1', '7/fields.0', '8/items.0', '9/before', '9/after']) {
    expect(tags).toContain(k)
  }
  for (const k of tags) expect(recipeTarget(recipe, k)).not.toBeNull()
})

// a stand-in page: each tag's box in the window, and an element's closest tag
const el = (key: string | null, r: { left: number; top: number; width: number; height: number }, up?: Tagged): Tagged => ({
  getAttribute: (n) => (n === 'data-rp' ? key : null),
  getBoundingClientRect: () => r,
  closest: (sel) => (sel === '[data-rp]' ? (key ? el(key, r) : up ?? null) : null),
})
const page = [
  el('0', { left: 116, top: 66, width: 600, height: 30 }),
  el('2', { left: 116, top: 110, width: 600, height: 90 }),
  el('2/columns', { left: 116, top: 110, width: 600, height: 30 }),
  el('2/rows.0', { left: 116, top: 140, width: 600, height: 30 }),
  el('2/rows.1', { left: 116, top: 170, width: 600, height: 30 }),
  el('3', { left: 116, top: 210, width: 300, height: 200 }),
]
const root = { querySelectorAll: (sel: string) => (sel === '[data-rp]' ? page : []) }
// the Mark up layer's top left
const origin = { left: 100, top: 50 }

test('a note made on the layer names the heading, a table row or the picture under it', () => {
  expect(tagBoxes(root, origin)[1]).toEqual({ key: '2', x: 16, y: 60, w: 600, h: 90 })
  expect(noteOnPage(root, origin, recipe, { x: 50, y: 30, w: 0, h: 0 })).toEqual({ blocks: [{ path: 'blocks[0]', kind: 'heading', text: 'Release plan' }], more: 0 })
  expect(noteOnPage(root, origin, recipe, { x: 50, y: 135, w: 0, h: 0 })).toEqual({ blocks: [{ path: 'blocks[2].rows[1]', kind: 'table row 2', text: 'Beta | 9' }], more: 0 })
  expect(noteOnPage(root, origin, recipe, { x: 30, y: 200, w: 10, h: 10 })).toEqual({ blocks: [{ path: 'blocks[3]', kind: 'image', text: 'Sign-in screen', file: 'login.png' }], more: 0 })
  expect(tagsUnder(root, origin, { x: 0, y: 0, w: 700, h: 400 })).toEqual(['0', '2', '3'])
  // not a recipe (a custom panel's picture): nothing but the spot
  expect(noteOnPage(root, origin, null, { x: 50, y: 30, w: 0, h: 0 })).toBeNull()
})

test('the block around any node of the recipe view, for notes on words or a picture', () => {
  const words = el(null, { left: 0, top: 0, width: 1, height: 1 }, el('2/rows.0', { left: 0, top: 0, width: 1, height: 1 }))
  expect(blockOfNode(words, recipe)).toEqual({ path: 'blocks[2].rows[0]', kind: 'table row 1', text: 'Alpha | 12' })
  expect(blockOfNode(el(null, { left: 0, top: 0, width: 1, height: 1 }), recipe)).toBeNull()
  expect(blockOfNode(null, recipe)).toBeNull()
})

test('the recipe shown is kept for Mark up while it shows', () => {
  const k = recipeKey('abc', 2, null)
  keepRecipe(k, recipe)
  expect(shownRecipe(k)).toBe(recipe)
  expect(shownRecipe(recipeKey('abc', 2, 'mini'))).toBeNull()
  keepRecipe(k, null)
  expect(shownRecipe(k)).toBeNull()
})
