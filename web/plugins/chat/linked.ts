// An agent's reply with its URLs as links (SHEP-99, core/chat-links.js), for markdown.tsx. No DOM: tested alone.
// SHEP-110: URLs only. A path is words here: the file is on the agent's machine, never on the phone reading it.
import { marked } from 'marked'
import * as CLs from '@core/chat-links.js'

export const CL = CLs as any as {
  linkify: (md: string, o: { home: null; paths: false }) => string
  label: (kind: string) => string
}

/** what marked makes of some markdown that linking must not change: its code (blocks and inline) as it reads, and where each link
    it already has leads, with its words (a reference definition, a link the agent wrote) */
function kept(md: string) {
  const code: string[] = [], hrefs: string[] = []
  marked.walkTokens(marked.lexer(md), (t) => {
    if (t.type === 'code' || t.type === 'codespan') code.push(`${t.type}:${t.text}`)
    // written as a link ([words](…), [words][ref]); a bare URL marked links itself is ours to link better
    if (t.type === 'link' && t.raw.startsWith('[')) hrefs.push(`${t.href}\0${t.text}`)
  })
  return { code: code.join('\0'), hrefs }
}

/** the reply with its URLs as links, unless that would change what any code block reads or where a link the reply
    already had leads, to marked (an odd nesting of quotes, lists and fences, or a reference definition, that the line
    scanner reads otherwise): then as it was, since a code block's Copy takes its text as it is and a link must not lead
    elsewhere. A path link the agent wrote shows its words only */
export function linked(text: string) {
  // a reply linking can't handle shows as written, never a blank chat (SHEP-108)
  try { return linkedOrThrow(text) } catch { return text }
}

function linkedOrThrow(text: string) {
  const md = CL.linkify(text, { home: null, paths: false })
  if (md === text) return md
  const was = kept(text), now = kept(md)
  if (was.code !== now.code) return text
  const left = [...now.hrefs]
  for (const h of was.hrefs) {
    if (/^(\/(?!\/)|~\/|file:)/i.test(h.split("\0")[0])) continue
    const i = left.indexOf(h)
    if (i < 0) return text
    left.splice(i, 1)
  }
  return md
}
