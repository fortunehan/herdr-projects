// Shared core: the source is core/chat-links.js; bin/sync-shared copies it into mods/chat/core/. Edit it here.
// Clickable paths and links in an agent's reply (SHEP-99): the window's chat (mods/chat) and the web app's
// (web/plugins/chat/markdown.tsx) turn http(s) URLs, absolute and home paths and file:// URLs, in plain text and in
// inline code (never in a fenced block), into markdown links. A click opens a URL in the default browser; a file a
// browser can show opens in the default browser too (not the file type's own app: Preview for a PDF); any other path
// is shown in Finder (a folder opens there). The web app asks the service on the agent's machine (service/actions.ts
// "open-path"), which refuses paths outside the home folder and /tmp.
// Plain JS: no herdr, node or DOM.

/** File types the default browser opens (by extension, lower case). */
export const BROWSER_EXT = new Set(["html", "htm", "svg", "pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "json"]);

/** Where a path or URL in a sentence ends: spaces, quotes, and full-width punctuation (，。）「 and the rest). */
const END = "\\s<>\"'`\\\\\\u2018-\\u201f\\u3000-\\u303f\\uff00-\\uffef";
/** A path in plain text also ends at CJK text, so one in a Chinese sentence ends where the sentence goes on (inline code
 *  holding only a path takes it whole: linkCode()). */
const CJK = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af";
const URL_RE = new RegExp(`https?://[^${END}{}|]+`, "g");
// A path starts a word: not after a letter, digit or another path's characters (and/or, 1/2, a URL's own path).
// An absolute one has at least two parts (/tmp/x, /opt/app/): a lone /model is a slash command, not a path.
const NOT = `${END}${CJK}\\[\\]{}|(),;:`;
const P = `[^${NOT}]`, PART = `[^${NOT}/]`;
const PATH_RE = new RegExp(`(?<![\\w.~/:@%+=#?&-])(file://(?:localhost)?/${P}*|~/${P}*|/${PART}+/${P}*)(:\\d+(?::\\d+)?)?`, "g");
const CJK_START = new RegExp(`^[${CJK}]`);

/** Every match of a global pattern, reusing it. Never matchAll on these: it compiles a copy of the pattern per call, and
 *  the window's QuickJS (no regexp cache, no JIT) took 5-20 ms per reply doing that, which ran a chat's render past
 *  the window's time limit and left the whole message list blank (SHEP-108). */
function* matches(re, s) {
  re.lastIndex = 0;
  for (let m; (m = re.exec(s));) {
    if (m[0] === "") re.lastIndex++;
    yield m;
  }
}

/** A URL's end without the sentence's punctuation, and a closing ) or ] only when the URL opened one. */
function trimUrl(u) {
  for (;;) {
    const t = u.replace(/[.,;:!?*_~]+$/, "");
    const open = { ")": "(", "]": "[" }[t.slice(-1)];
    if (open && t.split(open).length < t.split(t.slice(-1)).length) { u = t.slice(0, -1); continue; }
    return t;
  }
}

/** A file:// URL's path, each part decoded once (its ?query and #fragment dropped), or null. */
function filePath(u) {
  try { return u.replace(/^file:\/\/(localhost)?/i, "").replace(/[?#].*$/, "").split("/").map(decodeURIComponent).join("/"); } catch { return null; }
}

const LINE = /:(\d+)(?::(\d+))?$/;
/** One path as written (with its :line:col): { path, line, col }, or null. */
function pathOf(body, suffix) {
  const path = /^file:\/\//i.test(body) ? filePath(body) : body;
  if (!path || path === "~/" || !/^(\/|~\/)/.test(path)) return null;
  const [, line, col] = LINE.exec(suffix) ?? [];
  return { path, line: line ? Number(line) : null, col: col ? Number(col) : null };
}

/** The links in plain text: [{ start, end, text, kind: "url", url } | { ..., kind: "path", path, line, col }].
 *  path: as written (~/ not expanded; a file:// URL decoded); line, col: its :12:3 suffix, or null. */
export function find(text) {
  const s = String(text ?? "");
  const out = [];
  for (const m of matches(URL_RE, s)) {
    const url = trimUrl(m[0]);
    if (/^https?:\/\/[^/?#]+/.test(url)) out.push({ start: m.index, end: m.index + url.length, text: url, kind: "url", url });
  }
  const inUrl = (i) => out.some((x) => i >= x.start && i < x.end);
  for (const m of matches(PATH_RE, s)) {
    if (inUrl(m.index)) continue;
    const suffix = m[2] ?? "";
    const body = suffix ? m[1] : m[1].replace(/[.!?*_~]+$/, "");
    const p = pathOf(body, suffix);
    if (!p) continue;
    const len = body.length + suffix.length;
    if (CJK_START.test(s.slice(m.index + len))) continue;
    out.push({ start: m.index, end: m.index + len, text: s.slice(m.index, m.index + len), kind: "path", ...p });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** A written path as an absolute one: ~/ against home (null when home isn't known: another machine's agent). */
export function absolute(path, home) {
  if (path === "~" || path.startsWith("~/")) return home ? `${home.replace(/\/$/, "")}${path.slice(1)}` : null;
  return path.startsWith("/") ? path : null;
}

const HEX = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", " ": "%20", "#": "%23", "?": "%3F", "[": "%5B", "]": "%5D" };
/** A URL as a markdown link target: brackets and spaces encoded, except an IPv6 host's own ([::1]). */
const escHref = (u) => {
  const [, head, rest] = /^(https?:\/\/[^/?#]*)([\s\S]*)$/i.exec(u) ?? [, "", u];
  return head.replace(/[()<> ]/g, (c) => HEX[c]) + rest.replace(/[()<> [\]]/g, (c) => HEX[c]);
};
/** The window's link target for a path: a file:// URL. */
export const fileHref = (abs) => {
  try { return `file://${encodeURI(abs).replace(/[()#?[\]]/g, (c) => HEX[c])}`; } catch { return null; }
};
const escText = (t) => t.replace(/[\\*_[\]~<>]/g, "\\$&");

/** Links in one stretch of plain markdown text (no code, no links in it). */
function linkText(text, opts) {
  let out = "", at = 0;
  for (const l of find(text)) {
    if (l.start < at) continue;
    const href = hrefOf(l, opts);
    if (!href) continue;
    out += text.slice(at, l.start) + `[${escText(l.text)}](${href})`;
    at = l.end;
  }
  return out + text.slice(at);
}

function hrefOf(l, opts) {
  const href = hrefOf_(l, opts);
  if (href && opts.emitted) opts.emitted.add(href);
  return href;
}

function hrefOf_(l, { home, paths = true, pathHref = fileHref }) {
  if (l.kind === "url") return escHref(l.url);
  if (!paths) return null;
  const abs = absolute(l.path, home);
  return abs ? pathHref(abs) : null;
}

/** An inline code span that is a link and nothing else: the link around it, else null. A span holding only a path takes
 *  it whole (`/tmp/中文/index.html`, `~/`, `/tmp`); a space in it only when its last part names a file or a folder
 *  (`/tmp/My Report/index.html`, not `/usr/bin/open -R x`). */
function linkCode(span, inner, opts) {
  const t = inner.trim();
  const ls = find(t);
  if (ls.length === 1 && ls[0].start === 0 && ls[0].end === t.length) {
    const href = hrefOf(ls[0], opts);
    return href ? `[${span}](${href})` : null;
  }
  if (/[\n\r\u2028\u2029`]/.test(t)) return null;
  const m = /^([\s\S]*?)((?::\d+){1,2})?$/.exec(t);
  const body = m?.[1] ?? "";
  if (!/^(\/|~$|~\/|file:\/\/)/.test(body)) return null;
  if (/\s/.test(body) && (/\s-/.test(body) || !(body.endsWith("/") || /\.\w+$/.test(body.split("/").pop())))) return null;
  // one part alone only for the usual top folders: `/model` is a slash command
  if (/^\/[^/]+\/?$/.test(body) && !/^\/(tmp|Users|home|opt|var|etc|usr|private|Applications|Volumes|Library|srv|mnt)\/?$/.test(body)) return null;
  const p = body === "~" || body === "~/" ? { path: "~" } : pathOf(body, m[2] ?? "");
  if (!p) return null;
  const href = hrefOf({ kind: "path", path: p.path }, opts);
  return href ? `[${span}](${href})` : null;
}

/** A link the agent wrote itself (`[the page](/tmp/a/b.html)`): a path's target as one of ours, so it opens the same
 *  way; where paths aren't links (a phone, another machine's agent) just its words. A URL's or anything else's as it
 *  is. */
function linkAuthored(m, opts) {
  const [whole, img, words, target] = m;
  if (img) return whole;
  // its :line:col as written, then the rest decoded once (%20 a space, %3A a colon that is part of the name)
  const suffix = (LINE.exec(target) ?? [""])[0];
  let t = target.slice(0, target.length - suffix.length);
  if (!/^file:/i.test(t)) try { t = decodeURIComponent(t); } catch {}
  const p = /^(\/(?!\/)|~\/|file:\/\/)/i.test(t) ? pathOf(t, suffix) : null;
  if (!p) return whole;
  const href = hrefOf({ kind: "path", path: p.path }, opts);
  return href ? `[${words}](${href})` : words;
}

/** An autolink or an HTML tag under opts.strict: <file://…> or <a href="file:…"> follows pathHref, else shows as
 *  words; anything else as written. */
function strictTag(tag, opts) {
  const auto = /^<(file:[^>\s]*)>$/i.exec(tag);
  if (auto) {
    const p = pathOf(auto[1], "");
    const href = p ? hrefOf({ kind: "path", path: p.path }, opts) : null;
    return href ? `[${escText(auto[1])}](${href})` : escText(tag);
  }
  return /^<a\s/i.test(tag) && /href\s*=\s*["']?\s*(file:|\/|~\/)/i.test(tag) ? escText(tag) : tag;
}

// Within a line run outside fences: code spans, links and pictures, autolinks and HTML tags are left whole.
const INLINE = "(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|(!?)\\[([^\\]\\n]*)\\]\\(([^)\\s]*)(?:\\s+(?:\"[^\"\\n]*\"|'[^'\\n]*'|\\([^)\\n]*\\)))?\\)|<[^>\\n]*>";
const refName = (t) => t.trim().replace(/\s+/g, " ").toLowerCase();
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The inline pattern for a reply. A reference link the agent wrote ([words][name], [name][], [name]) is left whole too,
 *  but only for a name the reply defines: its words lead where its definition says, never to one of our path links,
 *  and brackets that aren't one (a URL's ?filter[status]=, an index [0] in code) stay plain text. */
function inlineRe(refs) {
  if (!refs.size) return new RegExp(INLINE, "g");
  const name = [...refs].map((r) => r.split(" ").map(escRe).join("\\s+")).join("|");
  return new RegExp(`${INLINE}|!?\\[[^\\]]*\\]\\[(?:${name})\\]|!?\\[(?:${name})\\](?:\\[\\])?(?![(:])`, "gi");
}

function linkInline(text, opts) {
  let out = "", at = 0;
  for (const m of matches(opts.inline, text)) {
    out += linkText(text.slice(at, m.index), opts);
    if (m[1]) out += linkCode(m[0], m[2], opts) ?? m[0];
    else if (m[4] !== undefined) out += linkAuthored([m[0], m[3], m[4], m[5]], opts);
    else out += opts.strict ? strictTag(m[0], opts) : m[0];
    at = m.index + m[0].length;
  }
  return out + linkText(text.slice(at), opts);
}

/** A reference definition's destination (kind "def": `[name]: dest`, "dest": the destination alone on the line after
 *  `[name]:`) under opts.strict: a path's as one of ours, a path ours won't link made plain, anything else as written. */
function strictRef(line, kind, opts) {
  const m = (kind === "def" ? /^([\s>]*\[[^\]]+\]:[ \t]*)(<[^>\n]*>|\S+)([\s\S]*)$/ : /^([\s>]*)(<[^>\n]*>|\S+)([\s\S]*)$/).exec(line);
  if (!m) return line;
  const dest = m[2].replace(/^<([\s\S]*)>$/, "$1");
  const suffix = (LINE.exec(dest) ?? [""])[0];
  let t = dest.slice(0, dest.length - suffix.length);
  if (!/^file:/i.test(t)) try { t = decodeURIComponent(t); } catch {}
  const p = /^(\/(?!\/)|~\/|file:)/i.test(t) ? pathOf(t, suffix) : null;
  if (!p && !/^file:/i.test(dest)) return line;
  const href = p ? hrefOf({ kind: "path", path: p.path }, opts) : null;
  if (href) return m[1] + href + m[3];
  return kind === "def" ? line.replace("[", "\\[") : `${m[1]}<>${m[3]}`;
}

/** Markdown with its URLs and paths as links, code blocks left as they are: fenced ones (also in a quote or a list)
 *  and indented ones after a blank line.
 *  opts: home (expands ~/; null: no home paths), paths (false: URLs only, as on a phone or for another machine's
 *  agent), pathHref(abs) (a path's link target, null: no link; the window's file:// URL by default), strict (the
 *  window, SHEP-109: its links open with the system's opener, no check of ours on the way, so a path the agent linked
 *  itself through a reference definition, an autolink or an HTML tag follows pathHref too, or stays plain). */
export function linkify(md, opts = {}) {
  const lines = String(md ?? "").split("\n");
  // the names the reply defines ([name]: …), so [name] alone stays its link
  opts = { ...opts, inline: inlineRe(new Set(lines.map((l) => /^[\s>]*\[([^\]]+)\]:/.exec(l)?.[1]).filter(Boolean).map(refName))), emitted: opts.strict ? new Set() : null };
  const out = [];
  let run = [], fence = null, blank = true, indented = false, ref = false, title = false, para = false;
  const flush = () => { if (run.length) out.push(linkInline(run.join("\n"), opts)); run = []; };
  // a line's containers: quote markers and list markers in front of its words ("- > ```" is a quote in a list item)
  const PREFIX = /^(?:\s*(?:>|[-*+](?=\s)|\d+[.)](?=\s)))*/;
  const depth = (l) => (PREFIX.exec(l)[0].match(/>/g) ?? []).length;
  const inner = (l) => l.replace(/^(?:\s*>)*/, "");
  // the line with its quote markers as spaces: how far in its words start (a list item's code is indented to its words)
  const flat = (l) => l.replace(PREFIX, (m) => m.replace(/>/g, " "));
  const lead = (l) => /^ */.exec(flat(l))[0].length;
  for (const line of lines) {
    const f = /^(?:\s*(?:>|[-*+]\s|\d+[.)]\s))*\s*(`{3,}|~{3,})/.exec(line);
    // a fence opened in a quote ends with the quote, one in a list item when a line starts left of the item's words
    if (fence && depth(line) < fence.depth) fence = null;
    if (fence && fence.indent > 0 && flat(line).trim() && lead(line) < fence.indent) fence = null;
    if (fence) {
      out.push(line);
      const c = /^[\s>]*(`{3,}|~{3,})\s*$/.exec(line);
      if (c && depth(line) === fence.depth && c[1][0] === fence.mark[0] && c[1].length >= fence.mark.length) fence = null;
    } else if (f) {
      flush();
      // only a list item's fence ends by indentation; a top-level one indented 1-3 spaces runs to its closing fence
      fence = { mark: f[1], depth: depth(line), indent: /[-*+]|\d+[.)]/.test(PREFIX.exec(line)[0]) ? flat(line).indexOf(f[1]) : 0 };
      out.push(line);
    } else if (!(/^( {4}|\t)/.test(line) && (blank || indented) && line.trim()) && (title || (!para && /^[\s>]*\[[^\]]+\]:/.test(line))) || (ref && /^\S+(?:\s+(?:"[^"]*"?|'[^']*'?|\([^)]*\)?))?\s*$/.test(inner(line).trim()))) {
      // a reference definition (never right under a paragraph's line: there it is words; after a heading, a rule, a
      // code block or another definition it is one), the line its destination is on
      // when the definition ends at its colon (one word, maybe a title: "See /tmp/a" under it is words), and the lines
      // of a title still open in quotes
      flush();
      const kind = title ? null : !para && /^[\s>]*\[[^\]]+\]:/.test(line) ? "def" : "dest";
      const shown = opts.strict && kind ? strictRef(line, kind, opts) : line;
      const quotes = (inner(line).match(/"/g) ?? []).length % 2 === 1;
      ref = !title && /^[\s>]*\[[^\]]+\]:\s*$/.test(line);
      title = title ? !quotes : quotes;
      out.push(shown);
      blank = false;
      para = false;
      continue;
    } else if (/^( {4}|\t)/.test(line) && (blank || indented) && line.trim()) {
      flush();
      indented = true;
      out.push(line);
    } else {
      if (line.trim()) indented = false;
      run.push(line);
    }
    blank = !inner(line).trim();
    ref = false;
    // a line of a paragraph: not blank, not a heading (# or an === / --- underline) or a rule, not code
    para = run.length > 0 && run[run.length - 1] === line && !blank && !/^[\s>]*(#{1,6}(\s|$)|([-*_])(\s*\3){2,}\s*$|=+\s*$|-+\s*$)/.test(line);
  }
  flush();
  return opts.strict ? guard(out.join("\n"), opts.emitted) : out.join("\n");
}

/** A link target that leads to a file here: file:, an absolute path or ~/ (decoded once). */
function local(dest) {
  let d = String(dest ?? "");
  try { d = decodeURIComponent(d); } catch {}
  d = d.trim().toLowerCase();
  return d.startsWith("file:") || /^(\/(?!\/)|~\/)/.test(d);
}

const GUARD = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|\]\(\s*<?([^)\s>]*)|^( {0,3}(?:>[ \t]?)*)\[[^\]\n]+\]:[ \t]*<?([^\s>]*)|<([a-z][\w+.-]*:[^>\s]*)>|<a\s[^>]*>/gi;

/**
 * Markdown whose every clickable target that leads to a file here is one in `emitted` (ours, already checked); any
 * other is made plain words: a link's ( escaped, a reference definition's [, an autolink's or an <a> tag's <. Code
 * (fences, indented blocks, code spans) is left as written. SHEP-109: the window's links open with the system's
 * opener, whatever the target, so this is the last check before it; also for the person's own words (emitted empty).
 */
export function guard(md, emitted = new Set()) {
  const lines = String(md ?? "").split("\n");
  let fence = null, blank = true, indented = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = /^[ \t>]*(`{3,}|~{3,})/.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^[ \t>]*(`{3,}|~{3,})\s*$/.test(l)) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    if (/^( {4}|\t)/.test(l) && (blank || indented) && l.trim()) { indented = true; continue; }
    if (l.trim()) indented = false;
    blank = !l.replace(/^[\s>]*/, "").trim();
    if (!/[\](<]/.test(l)) continue;
    GUARD.lastIndex = 0;
    lines[i] = l.replace(GUARD, (m, tick, inl, pre, def, auto, at) => {
      if (tick || l[at - 1] === "\\") return m;
      const bad = (d) => local(d) && !emitted.has(d);
      if (inl !== undefined) return bad(inl) ? m.replace("](", "]\\(") : m;
      if (def !== undefined) return bad(def) ? m.replace("[", "\\[") : m;
      if (auto !== undefined) return bad(auto) ? escText(m) : m;
      const href = /href\s*=\s*["']?([^"'\s>]*)/i.exec(m)?.[1];
      return href !== undefined && bad(href) ? escText(m) : m;
    });
  }
  return lines.join("\n");
}


/** A clicked link's target: { kind: "url", url } or { kind: "path", path } (absolute, its line suffix gone), or null.
 *  href: a link's URL (an http(s) or file:// URL, or an absolute or ~/ path an agent wrote as a link). */
export function fromHref(href, home) {
  const h = String(href ?? "");
  if (/^https?:\/\/[^/?#\s]+/i.test(h)) return { kind: "url", url: h };
  if (/^\/\/[^/?#\s]+/.test(h)) return { kind: "url", url: `https:${h}` };
  let p = null;
  if (/^file:\/\//i.test(h)) {
    p = h.replace(/^file:\/\/(localhost)?/i, "").replace(/[?#].*$/, "");
    try { p = decodeURIComponent(p); } catch { return null; }
  } else if (/^(\/|~\/)/.test(h)) p = h.replace(/:\d+(?::\d+)?$/, "");
  const abs = p ? absolute(p, home) : null;
  return abs && !abs.includes("\0") ? { kind: "path", path: abs } : null;
}

/** What a click on a path does: "browser" (a file the browser shows) or "reveal" (Finder; a folder opens there). */
export function actionOf(path) {
  const name = String(path).replace(/\/+$/, "").split("/").pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return !String(path).endsWith("/") && BROWSER_EXT.has(ext) ? "browser" : "reveal";
}

/** The hover words: what a click does. os: "macos", "windows" or "linux". */
export function label(kind, os) {
  if (kind === "url" || kind === "browser") return "Open in browser";
  return os === "macos" ? "Show in Finder" : "Show in folder";
}

/** sh: $1 "browser" or "reveal", $2 the path (~/ expanded here), $3 "guard": only paths in the home folder or /tmp.
 *  Exits 3 when the path isn't there, 4 when nothing can open it, 5 when the guard refuses it. The guard checks where
 *  the path really leads (links and .. resolved) and opens that.
 *  macOS: the default browser's app for http URLs (LaunchServices) opens the file, since plain `open` would pick the
 *  file type's app; a folder opens in Finder, anything else is revealed there. A folder with an extension (an app or
 *  another bundle, which `open` would run) is only revealed. Linux: the browser, xdg-open, or the file manager's
 *  ShowItems. */
export const OPEN = `p=$2
case $p in "~") p=$HOME ;; "~/"*) p="$HOME/\${p#"~/"}" ;; esac
[ -e "$p" ] || exit 3
if [ "$3" = guard ]; then
  if [ -d "$p" ]; then r=$(cd "$p" 2>/dev/null && pwd -P) || exit 3
  elif command -v realpath >/dev/null 2>&1; then r=$(realpath "$p" 2>/dev/null) || exit 3
  else [ -L "$p" ] && exit 5; r="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)/$(basename "$p")" || exit 3; fi
  h=$(cd "$HOME" 2>/dev/null && pwd -P) || h=
  t=$(cd /tmp 2>/dev/null && pwd -P) || t=/tmp
  case "$r/" in "$t"/*) ;; *) [ -n "$h" ] && [ "$h" != / ] || exit 5; case "$r/" in "$h"/*) ;; *) exit 5 ;; esac ;; esac
  p=$r
  case $(printf %s "$p" | tr '[:upper:]' '[:lower:]') in *.html|*.htm|*.svg|*.pdf|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.txt|*.json) set -- browser "$2" "$3" ;; *) set -- reveal "$2" "$3" ;; esac
fi
# macOS: its programs by absolute path, so a PATH cannot put another open in their place (SHEP-104)
if [ "$(uname)" = Darwin ]; then
  if [ -d "$p" ]; then
    case $(basename "$p") in ?*.*) exec /usr/bin/open -R "$p" ;; esac
    exec /usr/bin/open "$p"
  fi
  if [ "$1" = browser ]; then
    app=$(/usr/bin/osascript -l JavaScript -e 'ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com")); u.isNil() ? "" : u.path.js' 2>/dev/null)
    [ -n "$app" ] && exec /usr/bin/open -a "$app" "$p"
    exec /usr/bin/open "$p"
  fi
  exec /usr/bin/open -R "$p"
fi
# xdg-open hands the file on and returns, so its exit says whether it worked; a browser itself keeps running
if [ -d "$p" ]; then command -v xdg-open >/dev/null 2>&1 || exit 4; exec xdg-open "$p"; fi
if [ "$1" = browser ]; then
  for b in x-www-browser sensible-browser; do command -v "$b" >/dev/null 2>&1 && { "$b" "$p" >/dev/null 2>&1 & exit 0; }; done
  command -v xdg-open >/dev/null 2>&1 || exit 4; exec xdg-open "$p"
fi
dbus-send --session --print-reply --dest=org.freedesktop.FileManager1 /org/freedesktop/FileManager1 org.freedesktop.FileManager1.ShowItems array:string:"file://$p" string:"" >/dev/null 2>&1 && exit 0
command -v xdg-open >/dev/null 2>&1 || exit 4
exec xdg-open "$(dirname "$p")"`;

/** The command opening a path: [program, args]. action: actionOf(); os: window().platform; guard: the service's. */
export function command(action, os, path, guard = false) {
  // Windows: explorer opens the file with its own app (a .html one in the browser), or selects it in its folder. Never
  // cmd's start: cmd would read & and ^ in the path as its own.
  if (os === "windows") return ["explorer", [action === "browser" ? path : `/select,${path}`]];
  return ["sh", ["-c", OPEN, "open-path", action, path, ...(guard ? ["guard"] : [])]];
}

/** What a click says when it didn't work: { title, body }, or null when it worked. r: the exec result (null: it
 *  couldn't start). */
export function problem(action, os, path, r) {
  // explorer's exit code is 1 even when it worked
  if (r && (r.code === 0 || (os === "windows" && r.code === 1))) return null;
  const title = action === "browser" ? "Couldn't open it in the browser" : `Couldn't show it in ${os === "macos" ? "Finder" : "its folder"}`;
  if (!r) return { title, body: "The command it needs couldn't start." };
  if (r.code === 3) return { title, body: `${path} isn't there.` };
  if (r.code === 4) return { title, body: "Nothing here can open it." };
  if (r.code === 5) return { title, body: "Only paths in your home folder or /tmp open from here." };
  return { title, body: String(r.stderr ?? "").trim().split("\n").pop() || `It exited with ${r.code}.` };
}
