// SHEP-113: a Mark up note on a recipe names the blocks it is on. The web's recipe view tags each block and its parts
// with their place in the recipe (data-rp); Mark up matches its spot against the tags' boxes.
import { afterAll, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { blockOfNode, contentView, keptSpot, tagBox, keepRecipe, noteAction, noteOnPage, pictureSeed, picturesOnPage, quoteSeed, recipeKey, shownRecipe, tagBoxes, tagsUnder, type PicEl, type Tagged } from './spots.ts'
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

// SHEP-114: Comment on selected words or on a picture
const words = { blocks: [{ type: 'text', id: 't', md: 'The plan is that we ship on Friday after the review.' }, { type: 'list', id: 'l2', items: ['One', 'Two'] }, { type: 'image', id: 'p', src: 'shots/login.png', caption: 'Sign-in screen' }, { type: 'pair', id: 'pp', before: { src: 'a.png' }, after: { src: 'b.png' } }] }

test('selected words become a note with the quote, its context, its block path and the boxes to highlight', () => {
  const text = el('0', { left: 116, top: 66, width: 600, height: 48 })
  // the words cross a line: two boxes, one of them given twice (text and element)
  const rects = [{ left: 300, top: 70, width: 200, height: 20 }, { left: 300, top: 70, width: 200, height: 20 }, { left: 116, top: 92, width: 80, height: 20 }, { left: 0, top: 0, width: 0, height: 0 }]
  const seed = quoteSeed({ text: 'ship on\nFriday', prefix: 'The plan is that we ', rest: ' after the review.', rects, start: text, end: text }, origin, words)
  expect(seed).toEqual({
    spot: { x: 16, y: 20, w: 384, h: 42 },
    on: { blocks: [{ path: 'blocks[0]', kind: 'text', text: 'The plan is that we ship on Friday after the review.' }], more: 0 },
    quote: { text: 'ship on Friday', before: 'The plan is that we ', after: ' after the review.', rects: [{ x: 200, y: 20, w: 200, h: 20 }, { x: 16, y: 42, w: 80, h: 20 }] },
  })
  // from a paragraph into a list item: both are named
  const item = el('1/items.1', { left: 116, top: 130, width: 600, height: 24 })
  expect(quoteSeed({ text: 'review. One Two', prefix: '', rest: '', rects: rects.slice(0, 1), start: text, end: item }, origin, words)?.on?.blocks.map((b) => b.path)).toEqual(['blocks[0]', 'blocks[1].items[1]'])
  // nothing of the recipe selected, or only spaces: no note
  expect(quoteSeed({ text: 'x', prefix: '', rest: '', rects, start: el(null, rects[0]), end: null }, origin, words)).toBeNull()
  expect(quoteSeed({ text: '  ', prefix: '', rest: '', rects, start: text, end: text }, origin, words)).toBeNull()
})

// a stand-in <img data-pic> in its tagged block
const img = (key: string, r: { left: number; top: number; width: number; height: number }, size: [number, number], alt = ''): PicEl => ({
  getAttribute: () => null, getBoundingClientRect: () => r, alt, naturalWidth: size[0], naturalHeight: size[1],
  closest: (sel) => (sel === '[data-rp]' ? el(key, r) : null),
})

test('a picture note names the picture: its file, place, caption and its own size', () => {
  const login = img('2', { left: 116, top: 200, width: 640, height: 400 }, [1280, 800], 'Sign-in screen')
  expect(pictureSeed(login, origin, words)).toEqual({ spot: { x: 16, y: 150, w: 640, h: 400 }, picture: { file: 'login.png', path: 'blocks[2]', caption: 'Sign-in screen', width: 1280, height: 800 } })
  const before = img('3/before', { left: 116, top: 620, width: 300, height: 200 }, [600, 400], 'Before')
  expect(pictureSeed(before, origin, words)?.picture).toEqual({ file: 'a.png', path: 'blocks[3].before', alt: 'Before', width: 600, height: 400 })
  // not a recipe's picture: none
  expect(pictureSeed(login, origin, null)).toBeNull()
  const page = { querySelectorAll: (sel: string) => (sel === 'img[data-pic]' ? [login, before] : []) }
  expect(picturesOnPage(page, origin, words).map((p) => [p.file, p.x, p.y, p.w, p.h])).toEqual([['login.png', 16, 150, 640, 400], ['a.png', 16, 570, 300, 200]])
})

test('the recipe view tags each picture with its file, for Comment on this picture', () => {
  const html = renderToStaticMarkup(<Recipe recipe={words} asset={(s) => s} />)
  expect([...html.matchAll(/data-pic="([^"]+)"/g)].map((m) => m[1])).toEqual(['shots/login.png', 'a.png', 'b.png'])
})

test('Send all asks for the quote and the picture with each note, as drafted on the layer', () => {
  const { toFrac, outgoing, pictureUnder } = M as any
  const size = { width: 800, height: 900 }
  const text = el('0', { left: 116, top: 66, width: 600, height: 48 })
  const q = quoteSeed({ text: 'ship on Friday', prefix: 'The plan is that we ', rest: ' after the review.', rects: [{ left: 300, top: 70, width: 120, height: 20 }], start: text, end: text }, origin, words)!
  const login = img('2', { left: 116, top: 200, width: 640, height: 400 }, [1280, 800])
  const page = { querySelectorAll: () => [login] }
  // Mark up's drag over the picture's top right quarter
  const drag = { x: 336, y: 150, w: 320, h: 200 }
  const pic = pictureUnder(picturesOnPage(page, origin, words), drag)
  const notes = [
    { ...toFrac(q.spot, size), text: 'Say Monday', on: q.on, quote: { ...q.quote!, rects: q.quote!.rects.map((r) => toFrac(r, size)) } },
    { ...toFrac(drag, size), text: 'Too dark', picture: { ...pic.picture, spot: pic.spot } },
  ]
  expect(noteAction(outgoing(notes, '', size), { place: 'p', artifact: 'abc', v: 2 })).toEqual({
    type: 'artifact-note', place: 'p', artifact: 'abc', v: 2, text: '',
    notes: [
      { note: 'Say Monday', target: '', blocks: [{ path: 'blocks[0]', kind: 'text', text: 'The plan is that we ship on Friday after the review.' }], more: 0,
        quote: { text: 'ship on Friday', before: 'The plan is that we ', after: ' after the review.' } },
      { note: 'Too dark', target: 'the 640×400 px area at x 640–1280, y 0–400 (the top right quarter) of picture “login.png” (1280×800)',
        picture: { file: 'login.png', path: 'blocks[2]', caption: 'Sign-in screen', width: 1280, height: 800, spot: 'the 640×400 px area at x 640–1280, y 0–400 (the top right quarter)' } },
    ],
  })
  expect(noteAction({ kind: 'say', text: 'Hi' }, { place: 'p', artifact: 'abc', v: 2 })).toEqual({ type: 'artifact-say', place: 'p', artifact: 'abc', v: 2, text: 'Hi' })
})

// SHEP-115: the recipe scrolls under the still layer; a note keeps its spot on the content and on the tag it marks.
test('a note made while the recipe is scrolled keeps its spot on the content and the row it marks', () => {
  // the recipe's scrolling box fills the layer at (100, 50), 800×600, scrolled 400 down its 2000
  const scroller = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }), scrollTop: 400, scrollLeft: 0, scrollWidth: 800, scrollHeight: 2000 }
  const layer = { left: 100, top: 50, width: 800, height: 600 }
  const view = contentView(scroller, layer)
  expect(view).toEqual({ x: 0, y: -400, width: 800, height: 2000, page: true })
  // without a recipe (a page in a frame): the layer itself
  expect(contentView(null, layer)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  // a drag over the table's second row (the page's boxes as drawn now, scrolled)
  const kept = keptSpot(root, layer, view, { x: 30, y: 125, w: 300, h: 20 })
  expect(kept.anchor?.key).toBe('2/rows.1')
  expect(kept.y).toBeCloseTo(525 / 2000)
  // drawn again later: the row is wherever the page draws it now
  const placeNote = (M as any).placeNote
  const moved = [el('2/rows.1', { left: 116, top: 70, width: 600, height: 30 })]
  const now = { querySelector: (sel: string) => moved.find((e) => sel === `[data-rp="${e.getAttribute('data-rp')}"]`) ?? null }
  expect(tagBox(now, layer, '2/rows.1')).toEqual({ x: 16, y: 20, w: 600, h: 30 })
  expect(tagBox(now, layer, '9')).toBeNull()
  const at = placeNote(kept, (k: string) => tagBox(now, layer, k), view)
  expect([at.x, at.y, at.w, at.h].map(Math.round)).toEqual([30, 25, 300, 20])
  // selected words' boxes come along, on the content and on the tag
  const q = keptSpot(root, layer, view, { x: 30, y: 125, w: 300, h: 20 }, [{ x: 30, y: 125, w: 300, h: 20 }])
  expect(q.rects).toEqual([{ x: 30 / 800, y: 525 / 2000, w: 300 / 800, h: 20 / 2000 }])
  expect(q.anchor?.rects?.length).toBe(1)
})

test('the recipe view scrolls in a box Mark up can find', () => {
  const src = require('node:fs').readFileSync(join(import.meta.dir, 'client.tsx'), 'utf8') as string
  expect(src).toContain('<div data-recipe-scroll=""')
  expect(src).toContain("onWheel={(e) => scroller()?.scrollBy({ left: e.deltaX, top: e.deltaY })}")
})
