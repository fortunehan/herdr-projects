import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { SpaceCounts, WorkingCount } from './counts.tsx'

const render = (need: number, ready: number, look?: { red?: boolean; green?: boolean }) => renderToStaticMarkup(<SpaceCounts need={need} ready={ready} scope="here" look={look} />)
const visible = (html: string) => html.replace(/<[^>]+>/g, '')

test('Spaces show bold colored digits at the existing size with exact accessible counts', () => {
  const html = render(12, 3)
  expect(visible(html)).toBe('9+3')
  expect(html).toContain('aria-label="12 needs you, 3 ready · here"')
  for (const style of ['font-bold', 'text-[11px]', 'phone:text-[12px]', 'text-need-fg', 'text-ready-fg', 'shrink-0']) expect(html).toContain(style)
  expect(html).not.toMatch(/attention-badge|bg-|rounded/)
})

test('zeros and disabled count settings stay hidden independently', () => {
  expect(render(0, 0)).toBe('')
  expect(visible(render(2, 0))).toBe('2')
  expect(visible(render(0, 3))).toBe('3')
  expect(visible(render(2, 3, { red: false }))).toBe('3')
  expect(visible(render(2, 3, { green: false }))).toBe('2')
  expect(render(2, 3, { red: false, green: false })).toBe('')
})

test('Working retains the ring, motion, cap and sizes in yellow', () => {
  const html = renderToStaticMarkup(<WorkingCount n={12} />)
  expect(visible(html)).toBe('9+')
  for (const style of ['data-working="12"', 'text-work', 'text-[0.75rem]', 'size-2.5', 'animate-spin', 'motion-reduce:animate-none', 'stroke="currentColor"']) expect(html).toContain(style)
  expect(html).not.toContain('text-fg3')
})

test('only Spaces rows and folded headings use plain counts, after Working', () => {
  const source = readFileSync(new URL('./client.tsx', import.meta.url), 'utf8')
  expect(source).toContain('<SpaceCounts need={c.ownNeed} ready={c.ownReady} scope="here" look={snap.look} />')
  expect(source).toContain('<SpaceCounts need={need} ready={ready} scope="in it" look={snap.look} />')
  expect(source.indexOf('<WorkingCount')).toBeLessThan(source.indexOf('<SpaceCounts'))
  const other = readFileSync(new URL('../../src/ui.tsx', import.meta.url), 'utf8')
  expect(other).toContain('attention-badge-split')
  expect(other).not.toContain('data-space-counts')
})
