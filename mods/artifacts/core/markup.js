// Mark up's words, its spots in words and its drafts (Shepherdr 3.0's mods/artifacts/markup.js; many notes: SHEP-88):
// click spots or drag over areas of an artifact, each a numbered note with its own words, and Send all gives them to the
// agent that keeps it as one message, each spot described. The web app (web/plugins/artifacts/client.tsx) loads this
// file from core/; the window's markup.js imports its copy (mods/artifacts/core/markup.js, bin/sync-shared), which
// herdr-artifact copies into every artifact beside it (MARKUP_HELPERS).

export const MARKUP = {
  placeholder: "What should change?",
  notePlaceholder: "What should change here?",
  general: "Anything else, about all of it? (optional)",
  clear: "Clear spot",
  remove: "Delete note",
  sendAll: "Send all",
  sending: "Sending…",
  failed: "That didn't go through. Try again.",
  spot: "A note on the marked spot.",
  area: "A note on the marked area.",
  more: "Click or drag again for another note.",
  noWords: "(no words: just this spot)",
  quote: "A note on the selected words.",
  picture: "A note on the picture.",
  comment: "Comment",
  commentPicture: "Comment on this picture",
};

/** At most this many notes in one message. */
export const NOTES_MAX = 30;

// The card's line before anything is marked, and once it went: keeper is the agent's program ("Claude Code"), else
// "the agent".
export const markupHint = (keeper) => `Click a spot or drag over an area, or write to ${keeper} about all of it.`;
export const markupSent = (keeper) => `Sent to ${keeper}. A new version shows here when it's in.`;
/** "1 note", "3 notes" */
export const markupCount = (n) => (n === 1 ? "1 note" : `${n} notes`);

const REGION_Y = ["top", "middle", "bottom"], REGION_X = ["left", "center", "right"];

// The spot in words, for the agent: "the 180×80 px area at x 120–300, y 80–160 of the 720×540
// panel (near the top left)"; on a recipe that scrolls, in px of its whole content: "… of the 720×2400 page" (SHEP-115).
export function describe(s, size) {
  const W = Math.round(size?.width ?? 0), H = Math.round(size?.height ?? 0);
  const r = (v) => Math.round(v);
  const third = (v, n) => Math.min(2, Math.max(0, Math.floor((v / Math.max(1, n)) * 3)));
  const yx = [REGION_Y[third(s.y + s.h / 2, H)], REGION_X[third(s.x + s.w / 2, W)]];
  const near = yx[0] === "middle" && yx[1] === "center" ? "the middle" : yx[0] === "middle" ? `the middle ${yx[1]}` : yx[1] === "center" ? `the ${yx[0]} center` : `the ${yx[0]} ${yx[1]}`;
  const of = W && H ? ` of the ${W}×${H} ${size?.page ? "page" : "panel"}` : "";
  return s.w || s.h
    ? `the ${r(s.w)}×${r(s.h)} px area at x ${r(s.x)}–${r(s.x + s.w)}, y ${r(s.y)}–${r(s.y + s.h)}${of} (near ${near})`
    : `the point at x ${r(s.x)}, y ${r(s.y)}${of} (near ${near})`;
}

const frac = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** A spot in px kept as fractions of the layer ({x, y, w, h} in 0..1), so a note stays on its place when the layer
 *  changes size (a phone turned, a draft opened in a wider window). */
export function toFrac(s, size) {
  const W = Math.max(1, size?.width ?? 1), H = Math.max(1, size?.height ?? 1);
  return { x: frac(s.x / W), y: frac(s.y / H), w: frac(s.w / W), h: frac(s.h / H) };
}

/** A note's spot back in px of the layer as it is now. */
export function fromFrac(f, size) {
  const W = size?.width ?? 0, H = size?.height ?? 0;
  return { x: f.x * W, y: f.y * H, w: f.w * W, h: f.h * H };
}

// ---- a note stays on what it marked (SHEP-115) ---------------------------------------------------------------------
// The layer lies still over the artifact while its content scrolls under it, so a note isn't kept in the layer's px: its
// {x, y, w, h} are fractions of the whole content (toFrac of the spot less the content's top left), and on a recipe
// it also keeps an anchor, the spot as fractions of the tag it starts on ({ key, x, y, w, h, rects? }; not cut to 0..1:
// a drag may run past its tag). Drawn, a note finds its tag where it is now (scrolled, or reflowed by a new width).

const ANCHOR_MAX = 100;
const rel = (v) => (Number.isFinite(v) ? Math.max(-ANCHOR_MAX, Math.min(ANCHOR_MAX, v)) : 0);

/** A box as fractions of another (its tag's): { x, y, w, h }. */
export function relTo(s, b) {
  const W = Math.max(1, b.w), H = Math.max(1, b.h);
  return { x: rel((s.x - b.x) / W), y: rel((s.y - b.y) / H), w: rel((s.w || 0) / W), h: rel((s.h || 0) / H) };
}

/** A box kept as fractions of its tag back in the px its tag's box is in. */
export const fromRel = (r, b) => ({ x: b.x + r.x * b.w, y: b.y + r.y * b.h, w: r.w * b.w, h: r.h * b.h });

/** What a spot stays on: the innermost tag under its middle (else under its top left), with the spot as fractions of
 *  it, and the boxes of selected words the same way; null when it's on no tag. nodes: the tags' boxes in the spot's px. */
export function anchorOf(nodes, s, rects) {
  const list = nodes ?? [];
  const key = keysUnder(list, { x: s.x + (s.w || 0) / 2, y: s.y + (s.h || 0) / 2, w: 0, h: 0 })[0] ?? keysUnder(list, { x: s.x, y: s.y, w: 0, h: 0 })[0];
  const b = key && list.find((n) => n.key === key);
  if (!b) return null;
  return { key, ...relTo(s, b), ...(rects?.length ? { rects: rects.slice(0, RECTS_MAX).map((r) => relTo(r, b)) } : {}) };
}

/** An anchor as kept: a tag's key and finite fractions; null for anything else. */
export function cleanAnchor(a) {
  if (!a || typeof a !== "object" || typeof a.key !== "string" || !/^[\w./]{1,80}$/.test(a.key)) return null;
  const box = (r) => ({ x: rel(r.x), y: rel(r.y), w: rel(r.w), h: rel(r.h) });
  const rects = Array.isArray(a.rects) ? a.rects.filter(isBox).slice(0, RECTS_MAX).map(box) : [];
  return { key: a.key, ...box(a), ...(rects.length ? { rects } : {}) };
}

/** Where a note is drawn now, in px of the layer: on its tag where that is now (boxOf(key): the tag's box in the
 *  layer's px, or null when it isn't drawn), else at its fractions of the content, whose top left is at view.x, view.y
 *  of the layer (scrolled: above it) and whose size is view.width × view.height. rects: selected words' boxes. */
export function placeNote(n, boxOf, view) {
  const b = n.anchor && boxOf ? boxOf(n.anchor.key) : null;
  if (b && b.w > 0 && b.h > 0) {
    const out = fromRel(n.anchor, b);
    const rects = n.anchor.rects?.length ? n.anchor.rects.map((r) => fromRel(r, b)) : (n.quote?.rects ?? []).map((r) => shift(fromFrac(r, view), view));
    return { ...out, rects };
  }
  return { ...shift(fromFrac(n, view), view), rects: (n.quote?.rects ?? []).map((r) => shift(fromFrac(r, view), view)) };
}
const shift = (s, o) => ({ ...s, x: s.x + (o?.x ?? 0), y: s.y + (o?.y ?? 0) });

/** A spot in px of the layer as a note keeps it: fractions of the content (view, as for placeNote). */
export const contentFrac = (s, view) => toFrac({ x: s.x - (view?.x ?? 0), y: s.y - (view?.y ?? 0), w: s.w, h: s.h }, view);

/** Where a device keeps its draft for one version of an artifact (the web's localStorage key; the window's file name). */
export const draftKey = (id, v) => `shepherdr.markup:${id}:v${v}`;

/** A draft as text to keep: its notes ({x, y, w, h} fractions and words) and the general words; null when there's
 *  nothing to keep (the draft goes). */
export function draftText(notes, general) {
  const list = (notes ?? []).map((n) => ({ x: frac(n.x), y: frac(n.y), w: frac(n.w), h: frac(n.h), text: String(n.text ?? ""), ...keptOn(n.on), ...keptKind(n), ...keptAnchor(n) }));
  const g = String(general ?? "");
  if (!list.length && !g.trim()) return null;
  return JSON.stringify({ notes: list.slice(0, NOTES_MAX), general: g });
}

/** A kept draft read back; anything unreadable is an empty draft. */
export function readDraft(text) {
  const empty = { notes: [], general: "" };
  if (!text) return empty;
  let d;
  try { d = JSON.parse(text); } catch { return empty; }
  if (!d || typeof d !== "object") return empty;
  const notes = (Array.isArray(d.notes) ? d.notes : [])
    .filter((n) => n && typeof n === "object" && [n.x, n.y, n.w, n.h].every((v) => typeof v === "number"))
    .slice(0, NOTES_MAX)
    .map((n) => ({ x: frac(n.x), y: frac(n.y), w: frac(n.w), h: frac(n.h), text: typeof n.text === "string" ? n.text : "", ...keptOn(n.on), ...keptKind(n), ...keptAnchor(n) }));
  return { notes, general: typeof d.general === "string" ? d.general : "" };
}

// A note on selected words keeps its quote (and the boxes it was highlighted in), one on a picture the picture.
function keptKind(n) {
  const q = cleanQuote(n?.quote), p = cleanPicture(n?.picture);
  if (q) return { quote: { ...q, rects: (Array.isArray(n.quote.rects) ? n.quote.rects : []).filter(isBox).slice(0, RECTS_MAX).map(fracBox) } };
  if (p) return { picture: { ...p, ...(isBox(n.picture.spot) ? { spot: fracBox(n.picture.spot) } : {}) } };
  return {};
}
const keptAnchor = (n) => { const a = cleanAnchor(n?.anchor); return a ? { anchor: a } : {}; };
const isBox = (b) => b && typeof b === "object" && [b.x, b.y, b.w, b.h].every((v) => typeof v === "number");
const fracBox = (b) => ({ x: frac(b.x), y: frac(b.y), w: frac(b.w), h: frac(b.h) });

/** What Send all sends, for the layer's size now (null: nothing to send yet):
 *  - no notes, general words: { kind: "say", text } (today's note about all of it);
 *  - one note with words and no general words: { kind: "note", text, spot, blocks?, more? } (today's single note);
 *  - else { kind: "notes", notes: [{ text, spot, blocks?, more? }], text }: numbered as on the artifact, a note without
 *    words says so.
 *  On a recipe, a note's blocks (noteOn, SHEP-113) name what it is on; its spot stays, in px, beside them. */
export function outgoing(notes, general, size) {
  const g = String(general ?? "").trim();
  const list = (notes ?? []).slice(0, NOTES_MAX).map((n) => ({ text: String(n.text ?? "").trim(), ...sentWhere(n, size) }));
  if (!list.length) return g ? { kind: "say", text: g } : null;
  if (list.length === 1 && !g) return list[0].text ? { kind: "note", ...list[0] } : null;
  if (!g && !list.some((n) => n.text)) return null;
  return { kind: "notes", notes: list.map((n) => ({ ...n, text: n.text || MARKUP.noWords })), text: g };
}

// A note's blocks as a draft keeps them ({ on }) and as Send all sends them ({ blocks, more }); nothing without any.
function keptOn(on) {
  const blocks = cleanBlocks(on?.blocks);
  return blocks.length ? { on: { blocks, more: cleanMore(on.more) } } : {};
}
function sentOn(on) {
  const blocks = cleanBlocks(on?.blocks), more = cleanMore(on?.more);
  return blocks.length ? { blocks, ...(more ? { more } : {}) } : {};
}
// Where a note is, as sent (SHEP-114): selected words go as their quote and the block they are in (no px spot); a
// picture by its name and size, its spot in it described in the picture's own px; any other note by its px spot.
function sentWhere(n, size) {
  const q = cleanQuote(n.quote), p = cleanPicture(n.picture);
  if (q) return { spot: "", ...sentOn(n.on), quote: q };
  if (p) {
    const inside = isBox(n.picture.spot) ? describeInPicture(fracBox(n.picture.spot), p) : "";
    return { spot: pictureSpot(p, inside), picture: { ...p, ...(inside ? { spot: inside } : {}) } };
  }
  return { spot: describe(fromFrac(n, size), size), ...sentOn(n.on) };
}

// ---- notes on selected words and on pictures (SHEP-114) --------------------------------------------------------------
// The web's recipe view offers Comment next to selected words and on a picture; Mark up's click or drag on a picture
// also makes a picture note. The window's TextView can't tell a script what is selected, so it has picture and block
// notes only.

/** At most this many characters of a quote, and of the context on each side of it. */
export const QUOTE_MAX = 1000, CONTEXT_MAX = 80;
/** At most this many highlight boxes per quote. */
export const RECTS_MAX = 40;

const squash = (s) => str(s).replace(/\s+/g, " ");

/** Selected words and the block text around them as one quote: { text, before, after }, the words on each side cut
 *  to CONTEXT_MAX at a word; null for nothing selected. prefix: the block's text before the selection, as the page
 *  has it; rest: after it. */
export function quoteOf(selected, prefix = "", rest = "") {
  const text = squash(selected).trim();
  if (!text) return null;
  let before = squash(prefix).trimStart(), after = squash(rest).trimEnd();
  if (/^\s/.test(str(selected)) && before && !before.endsWith(" ")) before += " ";
  if (/\s$/.test(str(selected)) && after && !after.startsWith(" ")) after = ` ${after}`;
  if (before.length > CONTEXT_MAX) before = `…${before.slice(-CONTEXT_MAX).replace(/^\S*\s/, "")}`;
  if (after.length > CONTEXT_MAX) after = `${after.slice(0, CONTEXT_MAX).replace(/\s\S*$/, "")}…`;
  return cleanQuote({ text: text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1)}…` : text, before, after });
}

/** A quote as kept and sent: { text, before, after }, each cut short; null when it has no words. */
export function cleanQuote(q) {
  if (!q || typeof q !== "object" || typeof q.text !== "string" || !q.text.trim()) return null;
  return { text: q.text.slice(0, QUOTE_MAX), before: str(q.before).slice(-(CONTEXT_MAX + 2)), after: str(q.after).slice(0, CONTEXT_MAX + 2) };
}

/** A picture as kept and sent: { file, path?, caption?, alt?, width?, height? } (width and height: its own px); null
 *  without a file. */
export function cleanPicture(p) {
  if (!p || typeof p !== "object" || typeof p.file !== "string" || !p.file.trim()) return null;
  const cut = (s, n) => str(s).trim().slice(0, n);
  const px = (v) => (Number.isFinite(v) && v > 0 ? Math.round(Math.min(v, 100000)) : 0);
  const out = { file: cut(p.file, 120) };
  for (const k of ["path", "caption", "alt"]) if (cut(p[k], 120)) out[k] = cut(p[k], 120);
  if (px(p.width) && px(p.height)) Object.assign(out, { width: px(p.width), height: px(p.height) });
  return out;
}

const HALF_Y = ["top", "bottom"], HALF_X = ["left", "right"];
// Which part of a picture a box (fractions of it) is in: "the top right quarter", "the left half", "the middle"...
function partOf(b) {
  const half = (a, len) => (a + len <= 0.5 ? 0 : a >= 0.5 ? 1 : -1);
  if (!(b.w > 0 || b.h > 0)) {
    const t = (v) => Math.min(2, Math.floor(v * 3));
    const y = ["top", "middle", "bottom"][t(b.y)], x = ["left", "center", "right"][t(b.x)];
    return y === "middle" && x === "center" ? "near the middle" : y === "middle" ? `near the middle ${x}` : x === "center" ? `near the ${y} center` : `near the ${y} ${x}`;
  }
  if (b.w >= 0.9 && b.h >= 0.9) return "most of it";
  const y = half(b.y, b.h), x = half(b.x, b.w);
  if (y >= 0 && x >= 0) return `the ${HALF_Y[y]} ${HALF_X[x]} quarter`;
  if (y >= 0) return `the ${HALF_Y[y]} half`;
  if (x >= 0) return `the ${HALF_X[x]} half`;
  return "the middle";
}

/** A spot in a picture (fractions of it) in words, in the picture's own px when its size is known: "the 640×400 px
 *  area at x 640–1280, y 0–400 (the top right quarter)", "the point at x 900, y 120 (near the top right)"; else in
 *  percent of it. */
export function describeInPicture(b, pic) {
  const W = pic?.width ?? 0, H = pic?.height ?? 0, part = partOf(b);
  const r = (v) => Math.round(v);
  if (W && H) {
    return b.w > 0 || b.h > 0
      ? `the ${r(b.w * W)}×${r(b.h * H)} px area at x ${r(b.x * W)}–${r((b.x + b.w) * W)}, y ${r(b.y * H)}–${r((b.y + b.h) * H)} (${part})`
      : `the point at x ${r(b.x * W)}, y ${r(b.y * H)} (${part})`;
  }
  const pc = (v) => `${r(v * 100)}%`;
  return b.w > 0 || b.h > 0
    ? `the area from ${pc(b.x)} to ${pc(b.x + b.w)} across, ${pc(b.y)} to ${pc(b.y + b.h)} down (${part})`
    : `the point ${pc(b.x)} across, ${pc(b.y)} down (${part})`;
}

/** A picture note's spot as one line: "the top right quarter of picture “login.png” (1280×800)" (inside: its spot in
 *  it, describeInPicture), "picture “login.png” (1280×800)" for the whole picture. */
export function pictureSpot(pic, inside = "") {
  const name = `picture “${pic.file}”${pic.width && pic.height ? ` (${pic.width}×${pic.height})` : ""}`;
  return inside ? `${inside} of ${name}` : name;
}

/** The picture a spot of the layer is on, and the spot in it as fractions of the picture: a click inside one, or a
 *  drag mostly (60%+) inside one, clipped to it. pics: [{ x, y, w, h, ...picture }] in the layer's px. null: none. */
export function pictureUnder(pics, s) {
  const area = (s.w || 0) * (s.h || 0);
  for (const p of pics ?? []) {
    if (!(p?.w > 0 && p?.h > 0)) continue;
    const r = { x: p.x, y: p.y, w: p.w, h: p.h };
    if (area > 0 ? overlap(r, s) < 0.6 * area : !holds(r, { x: s.x, y: s.y })) continue;
    const x0 = Math.max(s.x, r.x), y0 = Math.max(s.y, r.y);
    const x1 = Math.min(s.x + (s.w || 0), r.x + r.w), y1 = Math.min(s.y + (s.h || 0), r.y + r.h);
    const spot = { x: frac((x0 - r.x) / r.w), y: frac((y0 - r.y) / r.h), w: area > 0 ? frac((x1 - x0) / r.w) : 0, h: area > 0 ? frac((y1 - y0) / r.h) : 0 };
    const { x: _x, y: _y, w: _w, h: _h, ...rest } = p;
    const picture = cleanPicture(rest);
    return picture ? { picture, spot } : null;
  }
  return null;
}

/** A picture's details from the recipe at a tag (an image block, a pair's side): { file, path, caption } or null. */
export function pictureAt(recipe, key) {
  const [place, part] = String(key ?? "").split("/");
  const b = blockAt(recipe, place);
  const x = part === "before" || part === "after" ? b?.[part] : part ? null : b;
  if (!x || typeof x.src !== "string" || mediaWord(x.src) !== "picture" || (!part && b.type !== "image")) return null;
  return cleanPicture({ file: fileOf(x.src), path: recipePath(key), caption: x.caption, width: x.w, height: x.h });
}

// ---- what a note is on, in a recipe (SHEP-113) ---------------------------------------------------------------------
// The renderers tag what they draw with its place in the recipe: a block by its place as core/translate.js blockPaths
// names it ("2", "2.c1.0" in a column, "3.t0.1" in a tab, "4.b.0" in details), a part of it after a slash ("3/rows.1",
// "5/items.0", "3/columns" for a table's header). The web reads the tags' boxes from the page (data-rp), the window's
// recipe view from the pointer's moves (recipeLayout). A note then names what it is on, so an agent needn't look.

/** At most this many blocks named per note; the rest are counted ("and 2 more"). */
export const BLOCKS_MAX = 5;

/** A tag's place as a path into recipe.json: "2.c1.0" is "blocks[2].columns[1][0]", "3.t0.1/rows.1"
 *  "blocks[3].tabs[0].blocks[1].rows[1]". */
export function recipePath(key) {
  const [place, part] = String(key ?? "").split("/");
  let out = "blocks";
  for (const s of place.split(".")) {
    if (/^\d+$/.test(s)) out += `[${s}]`;
    else if (/^c\d+$/.test(s)) out += `.columns[${s.slice(1)}]`;
    else if (/^t\d+$/.test(s)) out += `.tabs[${s.slice(1)}].blocks`;
    else if (s === "b") out += ".blocks";
  }
  for (const s of part ? part.split(".") : []) out += /^\d+$/.test(s) ? `[${s}]` : `.${s}`;
  return out;
}

/** The block at a place, or null. */
export function blockAt(recipe, place) {
  let list = recipe?.blocks, b = null;
  for (const s of String(place ?? "").split(".")) {
    if (/^\d+$/.test(s)) { b = Array.isArray(list) ? list[Number(s)] : null; list = null; }
    else if (/^c\d+$/.test(s)) list = b?.columns?.[Number(s.slice(1))];
    else if (/^t\d+$/.test(s)) list = b?.tabs?.[Number(s.slice(1))]?.blocks;
    else if (s === "b") list = b?.blocks;
    else return null;
    if (b === undefined || (b !== null && typeof b !== "object")) return null;
  }
  return b && typeof b === "object" ? b : null;
}

const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** A text cut to a short excerpt, its Markdown marks dropped: "Ship the **new** card" is "Ship the new card". */
export function excerpt(text, max = 80) {
  const t = str(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const fileOf = (src) => str(src).split("/").pop();
const labelOf = (c) => (typeof c === "string" ? c : str(c?.label ?? c?.name));
const KIND = { pdf: "PDF", pair: "before-and-after pair", audio: "sound" };

/** What a tag stands for: { path, kind, text, file? } (file: a picture's, a clip's or a document's name), or null when
 *  the recipe has nothing there. kind is the block's type in words, a part's with its number ("table row 2"). */
export function recipeTarget(recipe, key) {
  const [place, part] = String(key ?? "").split("/");
  const b = blockAt(recipe, place);
  if (!b) return null;
  const path = recipePath(key);
  const out = (kind, text, file) => ({ path, kind, text: excerpt(text), ...(file ? { file } : {}) });
  if (part) {
    const [field, n] = part.split(".");
    const i = Number(n), nth = Number.isInteger(i) ? i + 1 : 0;
    if (field === "rows" && Array.isArray(b.rows?.[i])) return out(`table row ${nth}`, b.rows[i].map(str).join(" | "));
    if (field === "columns" && b.type === "table") return out("table header", (b.columns ?? []).map(labelOf).join(" | "));
    if (field === "columns" && b.type === "columns" && Array.isArray(b.columns?.[i])) return out(`column ${nth}`, (b.columns[i] ?? []).map((x) => recipeTarget({ blocks: [x] }, "0")?.text).filter(Boolean).join(" · "));
    if (field === "items" && b.items?.[i] !== undefined) {
      const x = b.items[i];
      if (b.type === "list") return out(`list item ${nth}`, x);
      if (b.type === "stats") return out(`stat ${nth}`, `${str(x?.label)}: ${str(x?.value)}`);
      if (b.type === "buttons") return out(`button ${nth}`, x?.label);
    }
    if (field === "options" && b.options?.[i]) return out(`option ${nth}`, b.options[i].label);
    if (field === "fields" && b.fields?.[i]) return out(`form field ${nth}`, b.fields[i].label ?? b.fields[i].name);
    if (field === "tabs" && b.tabs?.[i]) return out(`tab ${nth}`, b.tabs[i].label);
    if ((field === "before" || field === "after") && b[field]) return out(`${field} ${mediaWord(b[field].src)}`, b[field].caption ?? (field === "before" ? "Before" : "After"), fileOf(b[field].src));
    return { ...recipeTarget(recipe, place), path };
  }
  switch (b.type) {
    case "heading": return out("heading", b.text);
    case "text": return out("text", b.md);
    case "list": return out(b.ordered ? "numbered list" : "list", (b.items ?? []).map(str).join("; "));
    case "table": return out("table", (b.columns ?? []).map(labelOf).join(" | "));
    case "chart": return out(`${str(b.kind) || "bar"} chart`, b.title ?? (b.labels ?? []).map(str).join(", "));
    case "stats": return out("stats", (b.items ?? []).map((x) => `${str(x?.label)}: ${str(x?.value)}`).join("; "));
    case "image": case "video": case "audio": case "pdf": return out(KIND[b.type] ?? b.type, b.caption, fileOf(b.src));
    case "pair": return out(KIND.pair, [b.before?.caption, b.after?.caption].filter(Boolean).join(" / "));
    case "code": return out(b.lang === "diff" ? "diff" : "code", str(b.text).split("\n").find((l) => l.trim()) ?? "");
    case "check": return out("check", b.summary || `$ ${str(b.command)}`);
    case "callout": return out("callout", b.title || b.md);
    case "columns": return out(`${(b.columns ?? []).length} columns`, "");
    case "tabs": return out("tabs", (b.tabs ?? []).map((x) => str(x?.label)).join(" | "));
    case "details": return out("details", b.summary);
    case "choice": return out("choice", b.question);
    case "form": return out("form", (b.fields ?? []).map((f) => str(f?.label ?? f?.name)).join(", "));
    case "button": return out("button", b.label);
    case "buttons": return out("buttons", (b.items ?? []).map((x) => str(x?.label)).join(" | "));
  }
  return out(str(b.type) || "block", "");
}

const mediaWord = (src) => (/\.(mp4|webm|mov)$/i.test(str(src)) ? "clip" : "picture");

/** The tag a tag sits in: a part's block, a nested block's block ("2.c1.0" is in "2"); null at the top. */
export function parentKey(key) {
  const k = String(key ?? "");
  if (k.includes("/")) return k.split("/")[0];
  const segs = k.split(".");
  // drop the index and what names the list it's in (c1, t0, b)
  return segs.length > 1 ? segs.slice(0, -2).join(".") || null : null;
}

// Document order of two tags: their places' numbers in turn, a block before its parts.
const segsOf = (k) => String(k).split(/[./]/).map((s) => (/^\d+$/.test(s) ? Number(s) : /^[ct]\d+$/.test(s) ? Number(s.slice(1)) : s === "b" ? 0 : s));
export function keyOrder(a, b) {
  const x = segsOf(a), y = segsOf(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (typeof x[i] === "number" && typeof y[i] === "number") return x[i] - y[i];
    return String(x[i]) < String(y[i]) ? -1 : 1;
  }
  return x.length - y.length;
}

const overlap = (r, s) => Math.max(0, Math.min(r.x + r.w, s.x + s.w) - Math.max(r.x, s.x)) * Math.max(0, Math.min(r.y + r.h, s.y + s.h) - Math.max(r.y, s.y));
const holds = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Which tags a spot is on, in document order. nodes: [{ key, x, y, w, h }], the boxes of the tags as drawn, in the
 *  spot's own px. A click: the innermost tag under it. A drag: each tag it covers (90% of it or more) whole, else the
 *  parts inside it the drag touches, else the tag itself. */
export function keysUnder(nodes, spot) {
  const list = (nodes ?? []).filter((n) => n && typeof n.key === "string" && n.w > 0 && n.h > 0);
  const depth = (k) => { let d = 0; for (let p = parentKey(k); p; p = parentKey(p)) d++; return d; };
  if (!(spot.w > 0 && spot.h > 0)) {
    const p = { x: spot.x + (spot.w || 0) / 2, y: spot.y + (spot.h || 0) / 2 };
    const hit = list.filter((n) => holds(n, p)).sort((a, b) => depth(b.key) - depth(a.key) || a.w * a.h - b.w * b.h)[0];
    return hit ? [hit.key] : [];
  }
  const touched = new Map();
  for (const n of list) { const o = overlap(n, spot); if (o > 0 && !touched.has(n.key)) touched.set(n.key, { n, o }); }
  // a tag's nearest touched ancestor (a column's box may be missing: skip to whichever is there)
  const up = (k) => { for (let p = parentKey(k); p; p = parentKey(p)) if (touched.has(p)) return p; return null; };
  const kids = new Map();
  for (const k of touched.keys()) { const p = up(k); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(k); }
  const out = [];
  const take = (k) => {
    const { n, o } = touched.get(k), inner = kids.get(k) ?? [];
    if (o >= 0.9 * n.w * n.h || !inner.length) out.push(k);
    else inner.forEach(take);
  };
  (kids.get(null) ?? []).forEach(take);
  return out.sort(keyOrder);
}

/** What a note is on, for its message: { blocks: [{ path, kind, text, file? }] (at most BLOCKS_MAX), more } or null
 *  when it's on nothing the recipe knows. */
export function noteOn(recipe, nodes, spot) {
  if (!recipe) return null;
  const all = keysUnder(nodes, spot).map((k) => recipeTarget(recipe, k)).filter(Boolean);
  return all.length ? { blocks: all.slice(0, BLOCKS_MAX), more: all.length - Math.min(all.length, BLOCKS_MAX) } : null;
}

/** A note's blocks as kept and sent: only well-formed ones, each field cut short; [] for none. */
export function cleanBlocks(v) {
  const cut = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
  return (Array.isArray(v) ? v : []).filter((b) => b && typeof b === "object" && typeof b.path === "string" && typeof b.kind === "string")
    .slice(0, BLOCKS_MAX)
    .map((b) => ({ path: cut(b.path, 120), kind: cut(b.kind, 40), text: cut(b.text, 120), ...(typeof b.file === "string" && b.file ? { file: cut(b.file, 120) } : {}) }));
}
const cleanMore = (v) => (Number.isInteger(v) && v > 0 ? Math.min(v, 999) : 0);

// ---- the window's recipe boxes (SHEP-113) ----------------------------------------------------------------------------
// GPUI tells a script where an element is only in its pointer events, so the window's recipe view (recipe-view.js)
// keeps each tag's box as the pointer moves over it (sawBox), and Mark up (markup.js) asks for them when a note is made
// (seenBoxes). A scroll or a new size makes every kept box stale (layoutMoved). Kept per place the artifact shows in
// ("viewer", "panel"), in case both copies share this module.

const layouts = new Map();
const layoutOf = (where) => {
  if (!layouts.has(where)) layouts.set(where, { recipe: null, boxes: new Map(), pics: new Map(), epoch: 0, seq: 0, at: null });
  return layouts.get(where);
};

/** The recipe the window's view draws there. */
export function setLayoutRecipe(where, recipe) { layoutOf(where).recipe = recipe ?? null; }

/** A pointer move over a tag: its box in window px (the event's bounds), and the pointer's place, so the boxes the
 *  last move crossed are known. */
export function sawBox(where, key, bounds, position) {
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return;
  const L = layoutOf(where);
  if (position && (!L.at || L.at.x !== position.x || L.at.y !== position.y)) { L.seq += 1; L.at = { x: position.x, y: position.y }; }
  L.boxes.set(key, { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height, epoch: L.epoch, seq: L.seq });
}

/** A pointer move over a picture of the recipe (SHEP-114): its box under its tag ("4", "7/before"), and its own size
 *  when the view knows it ({ w, h }), so a Mark up note on it names the picture and the spot in it. */
export function sawPicture(where, key, bounds, position, size) {
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return;
  const L = layoutOf(where);
  if (position && (!L.at || L.at.x !== position.x || L.at.y !== position.y)) { L.seq += 1; L.at = { x: position.x, y: position.y }; }
  L.pics.set(key, { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height, size: size?.w && size?.h ? size : null, epoch: L.epoch, seq: L.seq });
}

/** A pointer move over the recipe's whole content (SHEP-115): its box in window px, scrolled (its top above the view's)
 *  and as tall as all of it, so a note keeps its spot as fractions of the content. */
export function sawContent(where, bounds) {
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return;
  const L = layoutOf(where);
  L.content = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
}

/** The content's box as the pointer last saw it (a press always comes after a move over it), in px of a layer whose
 *  top left is at origin (window px), as placeNote's view ({ x, y, width, height, page }); null before any. */
export function contentView(where, origin) {
  const c = layoutOf(where).content, o = origin ?? { x: 0, y: 0 };
  return c ? { x: c.x - o.x, y: c.y - o.y, width: c.w, height: c.h, page: true } : null;
}

/** Scrolled or resized: the boxes kept so far are no longer where they were. */
export function layoutMoved(where) { const L = layoutOf(where); L.epoch += 1; L.boxes.clear(); L.pics.clear(); }

// The window draws a note inside what it marked (SHEP-115): the recipe view asks Mark up for the marks on each tag
// (key) and on its whole content (null) as it draws them, so they scroll and reflow with it.
const drawers = new Map();
/** Mark up's marks for one place: fn(key) gives the elements drawn on that tag (null: on the whole content). */
export function setMarksDrawer(where, fn) { drawers.set(where, fn); }
/** The marks on a tag (or the whole content, null) as Mark up draws them there now: [] for none. */
export function marksOn(where, key) { const f = drawers.get(where); return (f && f(key)) || []; }

/** The recipe and its kept boxes in the px of a layer whose top left is at origin (window px): for a click only the
 *  boxes the pointer's last move was over (fresh), for a drag every box seen since the last scroll. pics: the
 *  pictures' boxes the same way, each named from the recipe (pictureAt) with its own size when known. */
export function seenBoxes(where, origin, click) {
  const L = layoutOf(where), o = origin ?? { x: 0, y: 0 };
  const fresh = (b) => b.epoch === L.epoch && !(click && b.seq !== L.seq);
  const nodes = [], pics = [];
  for (const [key, b] of L.boxes) if (fresh(b)) nodes.push({ key, x: b.x - o.x, y: b.y - o.y, w: b.w, h: b.h });
  for (const [key, b] of L.pics) {
    const p = fresh(b) && pictureAt(L.recipe, key);
    if (p) pics.push({ key, x: b.x - o.x, y: b.y - o.y, w: b.w, h: b.h, ...p, ...(b.size && !p.width ? { width: b.size.w, height: b.size.h } : {}) });
  }
  return { recipe: L.recipe, nodes, pics };
}
