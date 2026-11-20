// Mark up, laid over every installed artifact by herdr-artifact (copied in as artifact-markup.js
// under a main.js that wraps the artifact's own; the source is mods/artifacts/markup.js).
// The Mark up button (the full-screen viewer's toolbar in mods/chat-image, the sidebar's header in
// mods/artifacts) sets shared "artifacts.markup" = { mod, where: "viewer" | "panel" }; the copies of
// that artifact there lay a layer over it (as Shepherdr's Mark up): click spots or drag over areas,
// each a numbered note with its own words (the card lists them: pick one to edit it, × deletes it),
// write about all of it if you like, and Send all gives everything to the agent that keeps the
// artifact as one message (`herdr-artifact note --notes`, SHEP-88) with the version, each spot in
// words and one picture of the panel with every numbered mark on it. One note alone goes as the
// single note it always was. The notes are kept per version on this computer until they went
// (closing Mark up keeps them). Esc closes the note being written, then ends.
// Its words, the spots in words and the drafts are core/markup.js (shared with the web app; copied
// in beside it, MARKUP_HELPERS).
// A custom panel (not a recipe) also leaves its picture for the web app each time it's shown (picture()).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, shared, setShared, props, exec, appHome, agents, readTextFile, checking } from "herdr";
import * as A from "./artifact.js";
import { dirs } from "./dirs.js";
import { MARKUP, NOTES_MAX, markupHint, markupSent, markupCount, toFrac, fromFrac, draftKey, draftText, readDraft, outgoing } from "./core/markup.js";

const KEY = "artifacts.markup";
const MOD = A.dir.slice("mods/".length);
const CLI = () => `${appHome()}/mods/artifacts/bin/herdr-artifact`;

// In the full-screen viewer (an overlay) or a panel (the sidebar, a tab, a window).
const where = () => (props()?.overlay ? "viewer" : "panel");
const isOn = () => { const s = shared(KEY); return Boolean(s && s.mod === MOD && s.where === where()); };
const stop = () => setShared(KEY, null);

// The keyboard: while Mark up is on, its boxes hold it (shared "keyboard.holder", as lib/keyholder.js writes it; this
// file is copied into each artifact on its own, so it can't import that), or the Assistant chat beside it, whose pane
// Herdr still counts as focused, takes it back to its own box. In the viewer (an overlay) it's held "over" the panes.
const HOLDER = "keyboard.holder", ME = "artifact.markup";
function holdKeys() {
  const h = shared(HOLDER), over = where() === "viewer";
  if (h?.who === ME && Boolean(h.over) === over) return;
  setShared(HOLDER, over ? { who: ME, at: Date.now(), over: true } : { who: ME, at: Date.now() });
}
const releaseKeys = () => { if (shared(HOLDER)?.who === ME) setShared(HOLDER, null); };
// The note being written, else the box about all of it.
const focusBox = (m) => { holdKeys(); (m.sel !== null ? m.note : m.input).focus(); };

// ---- drafts ------------------------------------------------------------------------------------

// One file per version: <artifacts>/markup-drafts/shepherdr.markup:<id>:v<n>.json, written a moment after a change.
const draftPath = () => `${dirs().artifacts}/markup-drafts/${draftKey(A.id, A.version)}.json`;

function loadDraft(m, cx) {
  if (checking()) return;
  cx.spawn(async (cx) => {
    const t = await readTextFile(draftPath()).catch(() => null);
    const d = readDraft(t);
    // what was marked before the draft came in wins
    if (m.notes.length || m.input.value() || (!d.notes.length && !d.general)) return;
    m.notes = d.notes;
    m.input.set_value(d.general);
    m.kept = t;
    cx.notify();
  });
}

function saveSoon(m, cx) {
  if (m.saving) return;
  m.saving = true;
  cx.timer.after(400, () => { m.saving = false; saveDraft(m); });
}

function saveDraft(m) {
  if (checking()) return;
  const t = draftText(m.notes, m.input.value());
  if (t === m.kept) return;
  m.kept = t;
  const p = draftPath();
  const r = t
    ? exec("sh", ["-c", 'mkdir -p "${1%/*}" && printf %s "$2" > "$1"', "draft", p, t])
    : exec("rm", ["-f", p]);
  r.catch(() => { m.kept = undefined; });
}

// ---- the mod's hooks ---------------------------------------------------------------------------

export function markupInit(cx) {
  const m = { notes: [], sel: null, press: null, origin: null, size: null, snap: false, sending: false, said: "", failed: false,
    was: false, pictured: false, kept: undefined, saving: false };
  m.input = InputState.new({ placeholder: MARKUP.placeholder });
  m.input.on("submit", (_e, cx) => send(m, cx));
  m.input.on("focus", (_e, cx) => { holdKeys(); if (m.sel !== null) { m.sel = null; cx.notify(); } });
  m.input.on("change", (_e, cx) => { fresh(m, cx); saveSoon(m, cx); });
  m.note = InputState.new({ placeholder: MARKUP.notePlaceholder });
  m.note.on("submit", (_e, cx) => { m.sel = null; cx.timer.after(0, () => focusBox(m)); cx.notify(); });
  m.note.on("focus", () => holdKeys());
  m.note.on("change", (_e, cx) => {
    if (m.sel !== null && m.notes[m.sel]) m.notes[m.sel].text = m.note.value();
    fresh(m, cx);
    saveSoon(m, cx);
  });
  loadDraft(m, cx);
  return m;
}

function fresh(m, cx) {
  if (m.said && !m.sending) { m.said = ""; m.failed = false; }
  cx.notify();
}

export function markupWrap(m, inner, cx) {
  if (!m) return inner;
  const on = isOn();
  if (on && !m.was) cx.timer.after(0, () => focusBox(m));
  // closed: the notes stay (kept as a draft), only what was half done goes
  if (!on && m.was) { Object.assign(m, { press: null, sel: null, snap: false, said: "", failed: false }); cx.timer.after(0, () => { releaseKeys(); saveDraft(m); }); }
  m.was = on;
  return v_flex().id("art-mark-root").relative().size_full()
    .on_size_change((size) => { m.size = size; })
    .when(Boolean(A.custom), (el) => el.on_mouse_move((e, cx) => {
      if (e.local_position) m.origin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
      picture(m, cx);
    }))
    .child(inner)
    .when(on, (el) => el.child(layer(m, theme())));
}

// ---- a custom panel's picture ---------------------------------------------------------------

// The web app can't run a custom panel: it shows the picture the window last took of it. Once per showing, a moment
// after the pointer first crosses it (its place in the window is known from the pointer only), the window's last
// frame is cut to the panel and kept beside this version (herdr-artifact picture). Not while Mark up lies over it.
function picture(m, cx) {
  if (m.pictured || !m.origin || !m.size || isOn()) return;
  m.pictured = true;
  cx.timer.after(700, () => {
    if (isOn()) { m.pictured = false; return; }
    const o = m.origin, s = m.size;
    const dir = `${dirs().artifacts}/notes`, file = `${dir}/shot-${Date.now()}.png`;
    exec("sh", ["-c", 'mkdir -p "$1" && exec herdr-app shot "$2"', "shot", dir, file])
      .then((r) => r.code === 0 && exec(CLI(), ["picture", A.id, "--version", String(A.version), "--shot", file,
        "--panel", [o.x, o.y, s.width, s.height].map(Math.round).join(","), "--json", ...(A.machine ? ["--from", A.machine] : [])]))
      .catch(() => {});
  });
}

// ---- the layer ---------------------------------------------------------------------------

const at = (e) => e.local_position ?? { x: 0, y: 0 };
const clampTo = (v, max) => Math.max(0, Math.min(max ?? v, v));

function layer(m, t) {
  const p = m.press;
  return div().id("art-mark-layer").absolute().top(0).left(0).size_full().cursor_crosshair()
    .border_2().border_dashed().border_color(t.accent)
    .on_mouse_move((e, cx) => {
      if (e.local_position) m.origin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
      if (!m.press) return;
      const q = at(e);
      m.press.x1 = clampTo(q.x, m.size?.width);
      m.press.y1 = clampTo(q.y, m.size?.height);
      if (Math.abs(m.press.x1 - m.press.x0) + Math.abs(m.press.y1 - m.press.y0) > 4) m.press.moved = true;
      cx.notify();
    })
    .on_mouse_down("left", (e, cx) => {
      cx.stop_propagation();
      if (m.sending) return;
      if (m.notes.length >= NOTES_MAX) { m.said = `At most ${NOTES_MAX} notes at once: send these first.`; m.failed = true; cx.notify(); return; }
      const q = at(e);
      if (e.local_position) m.origin = { x: e.position.x - q.x, y: e.position.y - q.y };
      m.press = { x0: q.x, y0: q.y, x1: q.x, y1: q.y, moved: false };
      m.said = ""; m.failed = false;
      holdKeys();
      cx.notify();
    })
    .on_mouse_up("left", (_e, cx) => pick(m, cx))
    .children(m.notes.map((n, i) => mark(m, fromFrac(n, m.size), i, t)))
    .when(Boolean(p), (el) => el.child(mark(m, p.moved ? box(p) : { x: p.x0, y: p.y0, w: 0, h: 0 }, m.notes.length, t)))
    // The card hides while you draw and while the picture for Send all is taken, so the picture shows the artifact.
    .when(!p && !m.snap, (el) => el.child(card(m, t)));
}

// The press as a rect (any drag direction).
function box(p) {
  return { x: Math.min(p.x0, p.x1), y: Math.min(p.y0, p.y1), w: Math.abs(p.x1 - p.x0), h: Math.abs(p.y1 - p.y0) };
}

// Released: a new numbered note (a point for a click, else the area), its box ready for words.
function pick(m, cx) {
  const p = m.press;
  if (!p) return;
  m.press = null;
  m.notes.push({ ...toFrac(p.moved ? box(p) : { x: p.x0, y: p.y0, w: 0, h: 0 }, m.size), text: "" });
  select(m, m.notes.length - 1, cx);
  saveSoon(m, cx);
}

function select(m, i, cx) {
  m.sel = i;
  if (i !== null) m.note.set_value(m.notes[i]?.text ?? "");
  cx.timer.after(0, () => focusBox(m));
  cx.notify();
}

function remove(m, i, cx) {
  m.notes.splice(i, 1);
  if (m.sel === i) m.sel = null;
  else if (m.sel !== null && m.sel > i) m.sel -= 1;
  saveSoon(m, cx);
  cx.notify();
}

const tintOf = (t, a) => (/^#[0-9a-f]{6}$/i.test(t.accent) ? `${t.accent}${a}` : `#2f81f7${a}`);

function badge(t, n, id, on) {
  return div().id(id).h(20).min_w(20).px(5).rounded(10).flex().items_center().justify_center()
    .bg(t.accent).text_color(t.accent_foreground).text_size(11).font_semibold().child(String(n))
    .when(on, (el) => el.border_2().border_color(t.background));
}

// A note's mark on the artifact: its number, and its area outlined and tinted. A press on the number picks that note.
function mark(m, r, i, t) {
  const real = i < m.notes.length;
  const b = div().absolute().left(r.x - 10).top(r.y - 10).child(badge(t, i + 1, `art-mark-badge-${i}`, real && m.sel === i))
    .when(real, (el) => el.cursor_pointer()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); select(m, i, cx); })
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation()));
  const el = div().absolute().left(0).top(0).size_full();
  if (!r.w && !r.h) return el.child(b);
  return el.child(div().absolute().left(r.x).top(r.y).w(r.w).h(r.h).rounded(4).border_2().border_color(t.accent)
    .bg(tintOf(t, m.sel === i ? "33" : "1f"))).child(b);
}

// Who gets it: the agent that made it, by its program's name.
function keeperName(address) {
  const a = agents().find((x) => x.address === (address ?? A.agent));
  return a?.program?.name ?? "the agent";
}

function card(m, t) {
  const out = outgoing(m.notes, m.input.value(), m.size);
  const cur = m.sel !== null ? m.notes[m.sel] : null;
  const line = m.said || (cur ? (cur.w || cur.h ? MARKUP.area : MARKUP.spot) : m.notes.length ? MARKUP.more : markupHint(keeperName()));
  const n = m.notes.length;
  return v_flex().id("art-mark-card").absolute().left(10).right(10).bottom(10).p(8).gap(6).rounded(10)
    .bg(t.popover).border_1().border_color(t.border).shadow_lg().cursor_default().text_size(12)
    // A press anywhere on the card (a box, its padding) puts the keyboard in a box at once.
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); focusBox(m); })
    .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .on_key_down((e, cx) => {
      holdKeys();
      if (e.keystroke !== "escape" && e.key !== "escape") return;
      cx.stop_propagation();
      if (m.sel !== null) select(m, null, cx); else stop();
    })
    // The hint wraps, so it's never cut at a narrow width.
    .child(h_flex().min_h(16).gap(8).items_start().px(2)
      .child(div().flex_1().min_w(0).text_color(m.failed ? t.blocked : t.muted).child(line))
      .when(n > 0, (el) => el.child(div().flex_none().text_color(t.muted).child(markupCount(n)))))
    .when(n > 0, (el) => el.child(v_flex().id("art-mark-notes").max_h(132).overflow_y_scrollbar().gap(2)
      .children(m.notes.map((x, i) => row(m, x, i, t)))))
    .child(h_flex().gap(6).items_center()
      .child(Input.new(m.input).flex_1().min_w(0).h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background)
        .text_size(13).text_color(t.foreground))
      .child(div().id("art-mark-send").h(32).flex_none().flex().items_center().justify_center().gap(4).rounded(8)
        .when(n > 0, (el) => el.px(10)).when(n === 0, (el) => el.w(32))
        .bg(t.solid).text_color(t.solid_foreground).text_size(12).font_medium()
        .when(!out || m.sending, (el) => el.opacity(0.45))
        .when(Boolean(out) && !m.sending, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
        .on_click((_e, cx) => send(m, cx))
        .child(svg("mods/artifacts/send.svg").size(16))
        .when(n > 0, (el) => el.child(MARKUP.sendAll))));
}

// One note in the card: its number, its words (the box while it's picked) and × to delete it.
function row(m, x, i, t) {
  const on = m.sel === i;
  return h_flex().id(`art-mark-row-${i}`).gap(6).items_center().px(2).py(1).rounded(6)
    .when(on, (el) => el.bg(t.selected))
    .child(badge(t, i + 1, `art-mark-num-${i}`, false))
    .child(on
      ? Input.new(m.note).flex_1().min_w(0).h(28).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background)
        .text_size(13).text_color(t.foreground)
      : div().id(`art-mark-text-${i}`).flex_1().min_w(0).truncate().cursor_pointer()
        .text_color(x.text.trim() ? t.foreground : t.muted).hover((s) => s.underline())
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); select(m, i, cx); })
        .child(x.text.trim() || MARKUP.notePlaceholder))
    .child(div().id(`art-mark-del-${i}`).flex_none().size(20).flex().items_center().justify_center().rounded(4)
      .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => remove(m, i, cx))
      .child("×"));
}

// ---- sending -------------------------------------------------------------------------------

// Send all: with marks on it, the card hides a moment so the window's picture shows the artifact with every numbered
// mark, then it all goes as one message.
function send(m, cx) {
  const out = outgoing(m.notes, m.input.value(), m.size);
  if (!out || m.sending) return;
  m.sending = true;
  m.said = MARKUP.sending;
  m.failed = false;
  m.sel = null;
  if (out.kind === "say") { cx.notify(); return deliver(m, out, null, cx); }
  m.snap = true;
  cx.notify();
  cx.timer.after(120, () => {
    const dir = `${dirs().artifacts}/notes`, file = `${dir}/shot-${Date.now()}.png`;
    cx.spawn(async (cx) => {
      let shot = null;
      try { const r = await exec("sh", ["-c", 'mkdir -p "$1" && exec herdr-app shot "$2"', "shot", dir, file]); if (r.code === 0) shot = file; } catch {}
      m.snap = false;
      cx.notify();
      deliver(m, out, shot, cx);
    });
  });
}

function deliver(m, out, shot, cx) {
  const args = ["note", A.id, "--version", String(A.version), "--json"];
  if (out.kind === "notes") {
    args.push("--notes", JSON.stringify(out.notes));
    if (out.text) args.push("--text", out.text);
  } else args.push("--text", out.text);
  if (out.kind === "note") args.push("--spot", out.spot);
  if (shot && m.origin && m.size) {
    const o = m.origin;
    args.push("--shot", shot, "--panel", [o.x, o.y, m.size.width, m.size.height].join(","));
    // one note: its spot outlined, as before
    if (out.kind === "note") {
      const s = fromFrac(m.notes[0], m.size);
      args.push("--area", [o.x + s.x, o.y + s.y, s.w, s.h].join(","));
    }
  }
  if (A.machine) args.push("--from", A.machine);
  cx.spawn(async (cx) => {
    let res = null, err = null;
    try {
      const r = await exec(CLI(), args);
      try { res = JSON.parse(r.stdout.trim().split("\n").pop() || "null"); } catch {}
      if (r.code !== 0 || !res || res.error) err = res?.error || r.stderr.trim() || MARKUP.failed;
    } catch (e) { err = String(e?.message ?? e); }
    m.sending = false;
    if (err) { m.said = err; m.failed = true; }
    else {
      m.notes = [];
      m.sel = null;
      m.input.set_value("");
      m.note.set_value("");
      m.said = markupSent(keeperName(res.to));
      saveDraft(m);
    }
    cx.notify();
  });
}
