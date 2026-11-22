// SHEP-99/110: the web app's chat links an agent's URLs (never its paths: the file isn't on this device), and never
// changes what a code block reads (its Copy takes that text): where the line scanner (core/chat-links.js) reads an odd
// nesting otherwise, marked decides.
import { expect, test } from 'bun:test'
import { marked } from 'marked'
import { linked } from './linked.ts'

const codes = (md: string) => {
  const out: string[] = []
  marked.walkTokens(marked.lexer(md), (t) => { if (t.type === 'code') out.push(t.text) })
  return out
}

test('URLs become links; paths stay words, and a path link the agent wrote shows its words only (SHEP-110)', () => {
  expect(linked('在 `/tmp/sds18-mock/index.html`，可以打开。见 https://x.y/z。'))
    .toBe('在 `/tmp/sds18-mock/index.html`，可以打开。见 [https://x.y/z](https://x.y/z)。')
  expect(linked('at /tmp/a/b.html and ~/dev/x.ts')).toBe('at /tmp/a/b.html and ~/dev/x.ts')
  expect(linked('[the page](/tmp/a.html), [docs](https://x.y/d)')).toBe('the page, [docs](https://x.y/d)')
})

test('an odd nesting the scanner reads otherwise leaves the reply as it was, never code with links in it', () => {
  // lazy continuations the line scanner can't follow (found by fuzzing against marked)
  for (const s of [
    '>x\n> see https://x.y/d.pdf\n>- ```\n  see https://x.y/d.pdf',
    '> - ```sh\n  /tmp/a/b.txt\n- > ```\n  > ',
    '  see https://x.y/d.pdf\n  > - ```\n   /tmp/a/b.txt\n> > ```\n1. see https://x.y/d.pdf',
  ]) expect(codes(linked(s))).toEqual(codes(s))
})

test('a link the reply already had leads where it did, or the reply stays as it was', () => {
  const hrefs = (md: string) => {
    const out: string[] = []
    marked.walkTokens(marked.lexer(md), (t) => { if (t.type === 'link') out.push(t.href) })
    return out
  }
  for (const s of [
    'Build results\n=============\n[report]: https://example.org/build\n\nRead [report]',
    '# Build results\n[report]: https://example.org/build\n\nRead [report]',
    '[docs]:\n  https://example.org/guide "Open the guide\n  in a browser"\n\n[docs]',
  ]) for (const h of hrefs(s)) expect(hrefs(linked(s))).toContain(h)
})

test('a reference link the agent wrote keeps its words and where they lead', () => {
  const s = 'Open [`/tmp/build/report.html`][report].\n\n[report]: https://example.org/build'
  expect(linked(s)).toBe(s)
})
