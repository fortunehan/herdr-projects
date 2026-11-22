// SHEP-99: the web app's chat links an agent's paths and URLs, and never changes what a code block reads (its Copy takes
// that text): where the line scanner (core/chat-links.js) reads an odd nesting otherwise, marked decides.
import { expect, test } from 'bun:test'
import { marked } from 'marked'
import { linked } from './linked.ts'

const codes = (md: string) => {
  const out: string[] = []
  marked.walkTokens(marked.lexer(md), (t) => { if (t.type === 'code') out.push(t.text) })
  return out
}

test('paths and URLs become links, with the web marker', () => {
  expect(linked('在 `/tmp/sds18-mock/index.html`，可以打开。见 https://x.y/z。', true))
    .toBe('在 [`/tmp/sds18-mock/index.html`](#shepherdr-path=%2Ftmp%2Fsds18-mock%2Findex.html)，可以打开。见 [https://x.y/z](https://x.y/z)。')
  expect(linked('at /tmp/a/b.html', false)).toBe('at /tmp/a/b.html')
})

test('an odd nesting the scanner reads otherwise leaves the reply as it was, never code with links in it', () => {
  // lazy continuations the line scanner can't follow (found by fuzzing against marked)
  for (const s of [
    '>x\n> see /tmp/c/d.pdf\n>- ```\n  see /tmp/c/d.pdf',
    '> - ```sh\n  /tmp/a/b.txt\n- > ```\n  > ',
    '  see /tmp/c/d.pdf\n  > - ```\n   /tmp/a/b.txt\n> > ```\n1. see /tmp/c/d.pdf',
  ]) expect(codes(linked(s, true))).toEqual(codes(s))
})
