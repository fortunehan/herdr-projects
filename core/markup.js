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
// panel (near the top left)".
export function describe(s, size) {
  const W = Math.round(size?.width ?? 0), H = Math.round(size?.height ?? 0);
  const r = (v) => Math.round(v);
  const third = (v, n) => Math.min(2, Math.max(0, Math.floor((v / Math.max(1, n)) * 3)));
  const yx = [REGION_Y[third(s.y + s.h / 2, H)], REGION_X[third(s.x + s.w / 2, W)]];
  const near = yx[0] === "middle" && yx[1] === "center" ? "the middle" : yx[0] === "middle" ? `the middle ${yx[1]}` : yx[1] === "center" ? `the ${yx[0]} center` : `the ${yx[0]} ${yx[1]}`;
  const of = W && H ? ` of the ${W}×${H} panel` : "";
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

/** Where a device keeps its draft for one version of an artifact (the web's localStorage key; the window's file name). */
export const draftKey = (id, v) => `shepherdr.markup:${id}:v${v}`;

/** A draft as text to keep: its notes ({x, y, w, h} fractions and words) and the general words; null when there's
 *  nothing to keep (the draft goes). */
export function draftText(notes, general) {
  const list = (notes ?? []).map((n) => ({ x: frac(n.x), y: frac(n.y), w: frac(n.w), h: frac(n.h), text: String(n.text ?? "") }));
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
    .map((n) => ({ x: frac(n.x), y: frac(n.y), w: frac(n.w), h: frac(n.h), text: typeof n.text === "string" ? n.text : "" }));
  return { notes, general: typeof d.general === "string" ? d.general : "" };
}

/** What Send all sends, for the layer's size now (null: nothing to send yet):
 *  - no notes, general words: { kind: "say", text } (today's note about all of it);
 *  - one note with words and no general words: { kind: "note", text, spot } (today's single note);
 *  - else { kind: "notes", notes: [{ text, spot }], text }: numbered as on the artifact, a note without words says so. */
export function outgoing(notes, general, size) {
  const g = String(general ?? "").trim();
  const list = (notes ?? []).slice(0, NOTES_MAX).map((n) => ({ text: String(n.text ?? "").trim(), spot: describe(fromFrac(n, size), size) }));
  if (!list.length) return g ? { kind: "say", text: g } : null;
  if (list.length === 1 && !g) return list[0].text ? { kind: "note", text: list[0].text, spot: list[0].spot } : null;
  if (!g && !list.some((n) => n.text)) return null;
  return { kind: "notes", notes: list.map((n) => ({ text: n.text || MARKUP.noWords, spot: n.spot })), text: g };
}
