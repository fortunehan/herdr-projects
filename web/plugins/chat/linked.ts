// An agent's reply with its URLs and paths as links (SHEP-99, core/chat-links.js), for markdown.tsx. No DOM: tested alone.
import { marked } from 'marked'
import * as CLs from '@core/chat-links.js'

export const CL = CLs as any as {
  linkify: (md: string, o: { home: string; paths: boolean; pathHref: (p: string) => string | null }) => string
  actionOf: (p: string) => 'browser' | 'reveal'
  label: (kind: string, os?: string) => string
}

/** a path link's target in the page: the path itself after this marker (the service opens it, not the browser) */
export const PATH_HREF = '#shepherdr-path='
const pathHref = (p: string) => { try { return PATH_HREF + encodeURIComponent(p) } catch { return null } }

/** the code blocks marked finds in some markdown, as they read */
const codes = (md: string) => {
  const out: string[] = []
  marked.walkTokens(marked.lexer(md), (t) => { if (t.type === 'code') out.push(t.text) })
  return out.join('\0')
}

/** the reply with its URLs and paths as links, unless that would change what any code block reads to marked (an odd
    nesting of quotes, lists and fences the line scanner reads otherwise): then as it was, since a code block's Copy
    takes its text as it is. ~/ stays as written ("~" as the home): the agent's machine expands it */
export function linked(text: string, paths: boolean) {
  const md = CL.linkify(text, { home: '~', paths, pathHref })
  return md === text || codes(md) === codes(text) ? md : text
}
