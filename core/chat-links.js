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

/** Characters a path or URL never holds here: spaces, quotes, brackets, and CJK text and full-width punctuation, so a
 *  path in a Chinese sentence ends where the sentence goes on. */
const STOP = "\\s<>\"'`\\[\\]{}|\\\\\\u2018-\\u201f\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uff00-\\uffef";
const URL_RE = new RegExp(`https?://[^${STOP}]+`, "g");
// A path starts a word: not after a letter, digit or another path's characters (and/or, 1/2, a URL's own path).
// An absolute one has at least two parts (/tmp/x, /Users/me/): a lone /model is a slash command, not a path.
const PATH_RE = new RegExp(`(?<![\\w.~/:@%+=#?&-])(file://(?:localhost)?/[^${STOP}(),;:]*|~/[^${STOP}(),;:]*|/[^${STOP}(),;:/]+/[^${STOP}(),;:]*)(:\\d+(?::\\d+)?)?`, "g");

/** A URL's end without the sentence's punctuation, and a closing ) only when the URL opened one. */
function trimUrl(u) {
  for (;;) {
    const t = u.replace(/[.,;:!?*_~]+$/, "");
    if (t.endsWith(")") && (t.match(/\(/g) ?? []).length < (t.match(/\)/g) ?? []).length) { u = t.slice(0, -1); continue; }
    return t;
  }
}

/** The links in plain text: [{ start, end, text, kind: "url", url } | { ..., kind: "path", path, line, col }].
 *  path: as written (~/ not expanded; a file:// URL decoded); line, col: its :12:3 suffix, or null. */
export function find(text) {
  const s = String(text ?? "");
  const out = [];
  for (const m of s.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (/^https?:\/\/[^/?#]+/.test(url)) out.push({ start: m.index, end: m.index + url.length, text: url, kind: "url", url });
  }
  const inUrl = (i) => out.some((x) => i >= x.start && i < x.end);
  for (const m of s.matchAll(PATH_RE)) {
    if (inUrl(m.index)) continue;
    let body = m[1];
    const suffix = m[2] ?? "";
    if (!suffix) body = body.replace(/[.!?*_~]+$/, "");
    let path = body;
    if (path.startsWith("file://")) {
      path = path.replace(/^file:\/\/(localhost)?/, "");
      try { path = decodeURI(path); } catch {}
    }
    if (path === "~/" || !/^(\/|~\/)/.test(path)) continue;
    const [, line, col] = /^:(\d+)(?::(\d+))?$/.exec(suffix) ?? [];
    const len = body.length + suffix.length;
    out.push({ start: m.index, end: m.index + len, text: s.slice(m.index, m.index + len), kind: "path", path, line: line ? Number(line) : null, col: col ? Number(col) : null });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** A written path as an absolute one: ~/ against home (null when home isn't known: another machine's agent). */
export function absolute(path, home) {
  if (path === "~" || path.startsWith("~/")) return home ? `${home.replace(/\/$/, "")}${path.slice(1)}` : null;
  return path.startsWith("/") ? path : null;
}

/** The window's link target for a path: a file:// URL. */
const HEX = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", " ": "%20", "#": "%23", "?": "%3F" };
const escHref = (u) => u.replace(/[()<> ]/g, (c) => HEX[c]);
export const fileHref = (abs) => `file://${encodeURI(abs).replace(/[()#?]/g, (c) => HEX[c])}`;
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

function hrefOf(l, { home, paths = true, pathHref = fileHref }) {
  if (l.kind === "url") return escHref(l.url);
  if (!paths) return null;
  const abs = absolute(l.path, home);
  return abs ? pathHref(abs) : null;
}

/** An inline code span that is a link and nothing else (`/tmp/x/index.html`): the link around it, else null. */
function linkCode(span, inner, opts) {
  const t = inner.trim();
  const ls = find(t);
  if (ls.length !== 1 || ls[0].start !== 0 || ls[0].end !== t.length) return null;
  const href = hrefOf(ls[0], opts);
  return href ? `[${span}](${href})` : null;
}

// Within a line run outside fences: code spans, links and pictures, autolinks and HTML tags are left whole.
const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>/g;

function linkInline(text, opts) {
  let out = "", at = 0;
  for (const m of text.matchAll(INLINE)) {
    out += linkText(text.slice(at, m.index), opts);
    out += m[1] ? (linkCode(m[0], m[2], opts) ?? m[0]) : m[0];
    at = m.index + m[0].length;
  }
  return out + linkText(text.slice(at), opts);
}

/** Markdown with its URLs and paths as links, fenced code blocks left as they are.
 *  opts: home (expands ~/; null: no home paths), paths (false: URLs only, as on a phone or for another machine's
 *  agent), pathHref(abs) (a path's link target; the window's file:// URL by default). */
export function linkify(md, opts = {}) {
  const lines = String(md ?? "").split("\n");
  const out = [];
  let run = [], fence = null;
  const flush = () => { if (run.length) out.push(linkInline(run.join("\n"), opts)); run = []; };
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null;
    } else if (f) {
      flush();
      fence = f[1];
      out.push(line);
    } else run.push(line);
  }
  flush();
  return out.join("\n");
}

/** A clicked link's target: { kind: "url", url } or { kind: "path", path } (absolute, its line suffix gone), or null.
 *  href: a link's URL (an http(s) or file:// URL, or an absolute or ~/ path an agent wrote as a link). */
export function fromHref(href, home) {
  const h = String(href ?? "");
  if (/^https?:\/\/[^/?#\s]+/i.test(h)) return { kind: "url", url: h };
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
 *  Exits 3 when the path isn't there, 4 when nothing can open it, 5 when the guard refuses it.
 *  macOS: the default browser's app for http URLs (LaunchServices) opens the file, since plain `open` would pick the
 *  file type's app; a folder opens in Finder, anything else is revealed there. A folder with an extension (an app or
 *  another bundle, which `open` would run) is only revealed. Linux: the browser, xdg-open, or the file manager's
 *  ShowItems. */
export const OPEN = `p=$2
case $p in "~") p=$HOME ;; "~/"*) p="$HOME/\${p#"~/"}" ;; esac
[ -e "$p" ] || exit 3
if [ "$3" = guard ]; then
  if [ -d "$p" ]; then r=$(cd "$p" 2>/dev/null && pwd -P) || exit 3
  else r="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)/$(basename "$p")" || exit 3; fi
  h=$(cd "$HOME" 2>/dev/null && pwd -P)
  case "$r/" in "$h"/*|/tmp/*|/private/tmp/*) ;; *) exit 5 ;; esac
fi
if [ "$(uname)" = Darwin ]; then
  if [ -d "$p" ]; then
    case $(basename "$p") in ?*.*) exec open -R "$p" ;; esac
    exec open "$p"
  fi
  if [ "$1" = browser ]; then
    app=$(osascript -l JavaScript -e 'ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com")); u.isNil() ? "" : u.path.js' 2>/dev/null)
    [ -n "$app" ] && exec open -a "$app" "$p"
    exec open "$p"
  fi
  exec open -R "$p"
fi
if [ -d "$p" ]; then command -v xdg-open >/dev/null 2>&1 || exit 4; xdg-open "$p" >/dev/null 2>&1 & exit 0; fi
if [ "$1" = browser ]; then
  for b in x-www-browser sensible-browser; do command -v "$b" >/dev/null 2>&1 && { "$b" "$p" >/dev/null 2>&1 & exit 0; }; done
  command -v xdg-open >/dev/null 2>&1 || exit 4; xdg-open "$p" >/dev/null 2>&1 & exit 0
fi
dbus-send --session --print-reply --dest=org.freedesktop.FileManager1 /org/freedesktop/FileManager1 org.freedesktop.FileManager1.ShowItems array:string:"file://$p" string:"" >/dev/null 2>&1 && exit 0
command -v xdg-open >/dev/null 2>&1 || exit 4
xdg-open "$(dirname "$p")" >/dev/null 2>&1 & exit 0`;

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
