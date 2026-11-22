// SHEP-111: a full-screen artifact's recipe: centred, words at most 1000 px wide, pictures at most their own size
// (Recipe.tsx gives a picture no width: its pixels as CSS px, max-w-full), each centred; not full screen, as before.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FULL_TEXT, fullStyle, pairGrid, picturePlace } from './screens/recipe-full.ts'

test('words are capped at 1000 px and centred; pictures, pairs, columns and clips take the whole width, centred', () => {
  expect(FULL_TEXT).toBe(1000)
  for (const type of ['text', 'list', 'table', 'heading', 'callout', 'code', 'check', 'tabs', 'details', 'stats', 'chart'])
    expect(fullStyle({ type }, true)).toEqual({ className: 'mx-auto w-full', style: { maxWidth: 1000 } })
  for (const type of ['image', 'pair', 'columns', 'video']) expect(fullStyle({ type }, true)).toEqual({ className: 'mx-auto w-full' })
})

test('not full screen: nothing added, today’s layout', () => {
  for (const type of ['text', 'image', 'columns']) expect(fullStyle({ type }, false)).toEqual({})
  expect(pairGrid(false)).toBe('@lg:grid-cols-2')
  expect(picturePlace(false)).toBe('self-start')
})

test('full screen: pictures centred, a pair side by side at most its own sizes', () => {
  expect(picturePlace(true)).toBe('self-center')
  expect(pairGrid(true)).toContain('justify-center')
  expect(pairGrid(true)).toContain('max-content')
})

test('a picture is never given a width beyond its own: the img sets only the recipe’s w and h, and max-w-full', () => {
  const src = readFileSync(new URL('./screens/Recipe.tsx', import.meta.url), 'utf8')
  const img = src.match(/<img src=\{url\}[^>]*\/>/)?.[0] ?? ''
  expect(img).toContain('width={w}')
  expect(img).toContain('max-w-full')
  expect(img).not.toMatch(/(?<![-\w])w-full/)
})
