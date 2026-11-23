// An artifact's recipe (recipe.json, core/recipe.js) drawn natively in the window: the GPUI side of the one file the
// web app draws as HTML (web/src/screens/Recipe.tsx). herdr-artifact copies this file, recipe.js and a main.js that
// its recipe (recipe-data.js, from recipe.json) into each recipe artifact it installs, so the viewer, its versions and Mark up stay as they are.
// Colors from theme() only; text 12-15 px; works from 320 px wide. A choice, a form or a button sends its words to
// the agent that keeps it (artifact.js answer), from a click only, kept with the version first (answers.json,
// SHEP-87): reopened, the chosen option shows picked with when, and a choice or a form can be changed.
// A click on a picture opens the window's picture viewer (mods/chat-image: zoom, copy, open, show in folder, previous
// and next through every picture in the recipe, SHEP-90).
// Mark up names the blocks a note is on (SHEP-113): each block and its parts (a list's items, a table's rows...) keep
// their box as the pointer moves over them (core/markup.js sawBox), the only place GPUI tells a script where it is.
// Its notes are drawn here, on the tag each one marked (or on the whole content), so they scroll and reflow with what
// they mark instead of staying still on the screen (SHEP-115, core/markup.js marksOn).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input } from "gpui-base";
import { image } from "gpui-kit";
import { theme, shared, setShared, props, openOverlay, appHome, exec, settings } from "herdr";
import * as fs from "fs/promises";
import { asset, answer, answers, id as ART_ID, version as ART_V, machine as ART_M } from "./artifact.js";
import { blockPaths, WORDS as TW } from "./translate.js";
import data from "./recipe-data.js";
import { sawBox, sawPicture, sawContent, layoutMoved, setLayoutRecipe, marksOn } from "./core/markup.js";
import { answerLine, answerOf, chartShapes, checkStatus, choiceReply, diffLines, formReply, FULL_TEXT, fullWide, imageSize, isDiff, isLink, mdParts, mediaKind, pictureMax, pictures, withIds } from "./recipe.js";

// A form field holds the keyboard while the person types in it (shared "keyboard.holder", as lib/keyholder.js writes
// it; this file is copied into each artifact on its own, so it can't import that), or the Assistant chat beside it,
// whose pane Herdr still counts as focused, takes it back to its own box. In the viewer (an overlay) it's held "over".
const HOLDER = "keyboard.holder", ME = "artifact.form";
function holdKeys() {
  const h = shared(HOLDER), over = Boolean(props()?.overlay);
  if (h?.who === ME && Boolean(h.over) === over) return;
  setShared(HOLDER, over ? { who: ME, at: Date.now(), over: true } : { who: ME, at: Date.now() });
}

const TONE = { info: "surface", good: "done", warn: "working", bad: "blocked" };
// SHEP-107: words keep a reading width while columns, tables and pictures take the whole width (full screen on a
// wide window; before, the whole recipe stopped at 860 px). The web's recipe view does the same (screens/Recipe.tsx).
const PROSE = 760;
// SHEP-111: full screen (the viewer tells it, artview.js artifactContent) the recipe is centred, words at most FULL_TEXT
// wide, each picture at most its own size; elsewhere as before. The web's recipe view does the same.
const isFull = () => Boolean(props()?.full);

// Where this copy shows (as Mark up's markup.js names it), and el keeping its box under its tag ("2", "2.c1.0",
// "3/rows.1") for Mark up, with the Mark up notes on it.
const where = () => (props()?.overlay ? "viewer" : "panel");
const withMarks = (el, key) => { const marks = marksOn(where(), key); return marks.length ? el.relative().children(marks) : el; };
const tag = (el, key) => withMarks(el.on_mouse_move((e) => sawBox(where(), key, e.bounds, e.position)), key);

// Translate (SHEP-102): this version's translation as the bar asked for it (lib/artifact-translate.js), by its texts'
// places (core/translate.js recipeUnits); a Retry sets it to "retry" and the bar asks again.
const TR_KEY = "artifacts.translate";
const trKey = () => `${ART_M ?? ""}|${ART_ID}|${ART_V}`;
const translation = () => { const s = (shared(TR_KEY) ?? {})[trKey()]; return s?.shown ? s : null; };
const retryTranslation = () => { const all = shared(TR_KEY) ?? {}, s = all[trKey()]; if (s) setShared(TR_KEY, { ...all, [trKey()]: { ...s, state: "retry" } }); };

// A picture file's first bytes, for its size (recipe.js imageSize): fs when it gives bytes, else od, which every Mac and
// Linux has. null when neither can read it.
async function head(path) {
  try {
    const b = await fs.readFile(path);
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
  } catch {}
  const r = await exec("od", ["-An", "-v", "-tu1", "-N", "131072", path]).catch(() => null);
  if (!r || r.code !== 0) return null;
  return Uint8Array.from(String(r.stdout).trim().split(/\s+/).filter(Boolean).map(Number));
}

// The window's size for an overlay (at zoom 1, as artview.js sizes its modal).
function windowSize() {
  let v = null;
  try { v = globalThis.window?.viewport_size?.(); } catch {}
  const zoom = Number(settings()?.zoom) || 1;
  return v?.width > 0 && v?.height > 0 ? { width: Math.round(v.width / zoom), height: Math.round(v.height / zoom) } : { width: 1200, height: 800 };
}

export default class RecipeView extends View {
  init(_props, cx) {
    this.recipe = null;
    this.error = null;
    this.tab = new Map();      // a tabs block's picked tab
    this.open = new Set();     // details blocks unfolded
    this.sending = new Set();  // a block's answer on its way
    this.answers = {};         // this version's kept answers (answers.json): { key: { value, at, by } }
    this.inputs = new Map();   // a form field's InputState
    this.checks = new Map();   // a form checkbox's value
    this.copied = null;        // the code box just copied, for its "Copied" a moment
    try { this.recipe = withIds(data); } catch { this.error = "This artifact's recipe can't be read."; }
    // every form field's InputState now: GPUI refuses InputState.new during render (#1026)
    const walk = (bs) => (Array.isArray(bs) ? bs : []).forEach((b) => {
      if (b?.type === "form") (b.fields ?? []).forEach((f) => f.kind !== "checkbox" && this.input(b, f));
      else if (b?.type === "columns") (b.columns ?? []).forEach(walk);
      else if (b?.type === "tabs") (b.tabs ?? []).forEach((x) => walk(x?.blocks));
      else if (b?.type === "details") walk(b.blocks);
    });
    walk(this.recipe?.blocks);
    this.pics = pictures(this.recipe);
    this.paths = this.recipe ? blockPaths(this.recipe) : new Map();
    setLayoutRecipe(where(), this.recipe);
    // full screen: each picture's own size, read from its file, so none is drawn past it
    this.sizes = new Map();
    if (isFull() && this.pics.length) cx?.spawn?.(async (cx) => {
      for (const p of this.pics) this.sizes.set(p.src, imageSize(await head(`${appHome()}/${asset(p.src)}`)));
      cx.notify();
    });
    // the answers kept with this version, then its forms' fields as sent
    cx?.spawn?.(async (cx) => {
      this.answers = { ...(await answers()), ...this.answers };
      this.fill(this.recipe?.blocks);
      cx.notify();
    });
  }

  // a form answered before: its fields as sent
  fill(blocks) {
    (Array.isArray(blocks) ? blocks : []).forEach((b) => {
      if (b?.type === "form") {
        const a = answerOf(this.answers, b.id);
        if (a && a.value && typeof a.value === "object") (b.fields ?? []).forEach((f) => {
          if (f.kind === "checkbox") this.checks.set(`${b.id}:${f.name}`, Boolean(a.value[f.name]));
          else this.input(b, f).set_value?.(String(a.value[f.name] ?? ""));
        });
      } else if (b?.type === "columns") (b.columns ?? []).forEach((c) => this.fill(c));
      else if (b?.type === "tabs") (b.tabs ?? []).forEach((x) => this.fill(x?.blocks));
      else if (b?.type === "details") this.fill(b.blocks);
    });
  }

  async close() {
    if (shared(HOLDER)?.who === ME) setShared(HOLDER, null);
  }

  // A picture: a click opens it in the picture viewer, at its place among the recipe's pictures. Its box is kept under
  // its tag (key) as the pointer crosses it, so a Mark up note on it names the picture (SHEP-114).
  picture(src, el, b = null, key = null) {
    const max = isFull() ? pictureMax(b, this.sizes?.get(src)) : null;
    return div().id(`pic-${src}`).w_full().min_w(0).when(Boolean(max), (e) => e.max_w(max)).cursor_pointer()
      .when(key !== null, (e) => e.on_mouse_move((ev) => sawPicture(where(), key, ev.bounds, ev.position, this.sizes?.get(src))))
      .on_click((_e, cx) => { cx.stop_propagation(); this.openPicture(src, cx); }).child(el);
  }

  // The window's picture viewer (mods/chat-image) over the whole window, on every picture in the recipe from this one:
  // each by its file in this mod's folder, so copy, open and show in folder act on it.
  openPicture(src, cx) {
    if (this.opening) return;
    this.opening = true;
    cx.spawn(async () => {
      try {
        const home = appHome();
        const images = await Promise.all(this.pics.map(async (p) => {
          const rel = asset(p.src), path = `${home}/${rel}`;
          const size = imageSize(await head(path)) ?? { w: 1200, h: 800 };
          return { rel, w: size.w, h: size.h, name: p.caption || p.src.split("/").pop(), path };
        }));
        const index = Math.max(0, this.pics.findIndex((p) => p.src === src));
        const { width, height } = windowSize();
        openOverlay({ mod: "chat-image", kind: "dialog", frame: "none", width, height, props: { images, index, width, height } });
      } finally { this.opening = false; }
    });
  }

  // Markdown words; each fenced code block in them gets its own code box with a Copy button (core/recipe.js mdParts).
  md(id, text, t, b = null, field = "md") {
    const words = (key, w) => div().w_full().min_w(0).max_w(isFull() ? FULL_TEXT : PROSE).text_size(13).text_color(t.foreground).child(TextView.markdown(key, w).selectable(true));
    // translated: each paragraph, then its translation under it (as the chat's), in the parts the service made from
    // marked's own parse (this window has none)
    const parts0 = b ? translation()?.mdParts?.[`${this.paths.get(b)}.${field}`] : null;
    if (Array.isArray(parts0)) {
      return v_flex().w_full().min_w(0).gap(2).children(parts0.map((x, i) => x.type === "code" ? this.code(`${id}-tc${i}`, x.code, t)
        : x.type === "table" ? this.trTable(`${id}-tt${i}`, x, t)
        : x.type === "tr" ? this.trLine(`${id}-t${i}`, x.text, t) : x.type === "fail" ? this.trLine(`${id}-t${i}`, null, t) : words(`md-${id}-tm${i}`, x.text)));
    }
    const parts = mdParts(text);
    if (!parts.some((x) => "code" in x)) return words(`md-${id}`, String(text ?? " "));
    return v_flex().w_full().min_w(0).gap(8).children(parts.map((x, i) => "code" in x ? this.code(`${id}-c${i}`, x.code, t) : words(`md-${id}-${i}`, x.md)));
  }

  // One translation line (SHEP-102): a step dimmer, a thin rule on its left; null text: it failed (Retry asks again).
  trLine(key, text, t) {
    const el = div().id(`tr-${key}`).w_full().min_w(0).mt(2).pl(8).border_l(2).border_color(t.border).text_size(13);
    if (text === null) return el.cursor_pointer().text_color(t.blocked).on_click((_e, cx) => { retryTranslation(); cx.notify(); }).child(`${TW.blockFailed} \u00b7 ${TW.retry}`);
    return el.text_color(t.muted).child(TextView.markdown(`trmd-${key}`, text || " ").selectable(true));
  }

  // A markdown table translated (core/translate.js windowParts): its cells as they were, each one's translation under
  // its words inside the cell.
  trTable(key, g, t) {
    return v_flex().w_full().rounded(8).border_1().border_color(t.border).overflow_hidden()
      .children(g.rows.map((r, ri) => h_flex().w_full().px(10).py(6).gap(10).items_start().when(ri > 0, (e) => e.border_t_1().border_color(t.border)).when(ri === 0, (e) => e.bg(t.surface))
        .children(r.map((c, ci) => v_flex().flex_1().min_w(0).text_size(ri === 0 ? 12 : 13).when(ri === 0, (e) => e.font_medium().text_color(t.muted))
          .child(TextView.markdown(`trc-${key}-${ri}-${ci}`, c.text || " ").selectable(true))
          .when(Boolean(c.tr), (e) => e.child(this.trLine(`${key}-${ri}-${ci}`, c.tr, t)))
          .when(!c.tr && c.fail, (e) => e.child(this.trLine(`${key}-${ri}-${ci}`, null, t)))))));
  }

  // A chart's or tabs' labels that couldn't be translated: one line with Retry under them, or el as it is.
  withFail(el, b, t) {
    const s = translation(), at = ["tab.", "label.", "series."].map((f) => `${this.paths.get(b)}.${f}`);
    return s && (s.failed ?? []).some((k) => at.some((a) => k.startsWith(a))) ? v_flex().w_full().min_w(0).child(el).child(this.trLine(`${b.id}-fail`, null, t)) : el;
  }

  // A block's text's translation (field: its place in the block, as recipeUnits names it), or null.
  tr(b, field, t) {
    const s = translation();
    if (!s) return null;
    const k = `${this.paths.get(b)}.${field}`;
    if (s.units?.[k]) return this.trLine(`${b.id}-${field}`, s.units[k], t);
    return (s.failed ?? []).includes(k) ? this.trLine(`${b.id}-${field}`, null, t) : null;
  }

  // el with the translation of the block's field under it, when it has one.
  withTr(el, b, field, t) {
    const line = this.tr(b, field, t);
    return line ? v_flex().w_full().min_w(0).child(el).child(line) : el;
  }

  // A code box: its text, and a Copy button at its top right that puts all of it on the clipboard (the
  // window binds no copy key to a page's selected text, so this is how a command gets out whole). "Copied" a moment.
  code(key, text, t) {
    const done = this.copied === key;
    return h_flex().w_full().min_w(0).p(10).gap(8).items_start().rounded(8).bg(t.surface)
      .child(div().flex_1().min_w(0).font_family("JetBrains Mono").text_size(12).whitespace_normal().child(String(text)))
      .child(div().id(`copy-${key}`).flex_none().h(22).px(8).flex().items_center().rounded(6).border_1().border_color(t.border)
        .bg(t.background).text_size(12).text_color(done ? t.foreground : t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.copy(key, text, cx))
        .child(done ? "Copied" : "Copy"));
  }

  copy(key, text, cx) {
    cx.stop_propagation();
    cx.write_to_clipboard(String(text));
    this.copied = key;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === key) { this.copied = null; cx.notify(); } });
  }

  // an answer: kept with the version and sent to the agent (artifact.js answer); shown as answered at once, taken
  // back when it didn't go
  send(key, value, text, cx) {
    if (this.sending.has(key)) return;
    const was = this.answers[key];
    this.sending.add(key);
    this.answers = { ...this.answers, [key]: { value, at: Date.now(), by: "window" } };
    cx.notify();
    cx.spawn(async (cx) => {
      const ok = await answer(key, value, text);
      this.sending.delete(key);
      if (!ok) { const next = { ...this.answers }; if (was) next[key] = was; else delete next[key]; this.answers = next; }
      cx.notify();
    });
  }

  // when the person answered, under its block: "You chose this at 14:05"
  answered(kind, key, t) {
    const a = answerOf(this.answers, key);
    return a ? div().text_size(12).text_color(t.muted).child(answerLine(kind, a.at)) : null;
  }

  // a diff's lines, + and - in their own colour, @@ dim
  diff(b, t) {
    const color = { add: t.done, del: t.blocked, hunk: t.muted, file: t.foreground };
    return v_flex().w_full().min_w(0).p(10).rounded(8).bg(t.surface).font_family("JetBrains Mono").text_size(12)
      .children(diffLines(b.text).map((l) => div().w_full().min_w(0).whitespace_normal()
        .text_color(color[l.kind] ?? t.foreground).when(l.kind === "file", (e) => e.font_semibold())
        .child(l.text || " ")));
  }

  // a command that ran: its status (green Passed, red Failed · exit N), the command, its summary; its output folded
  check(b, t) {
    const s = checkStatus(b), c = s.ok ? t.done : t.blocked, open = this.open.has(b.id);
    return v_flex().w_full().min_w(0).gap(4)
      .child(v_flex().w_full().min_w(0).gap(6).p(10).rounded(8).bg(t.surface)
        .child(h_flex().w_full().min_w(0).flex_wrap().gap(8).items_center()
          .child(h_flex().flex_none().gap(6).items_center().px(8).h(20).rounded(10).border_1().border_color(c)
            .child(div().size(7).rounded(4).bg(c))
            .child(div().text_size(12).font_medium().text_color(c).child(s.label)))
          .when(!!b.summary, (e) => e.child(div().min_w(0).text_size(13).whitespace_normal().child(String(b.summary)))))
        .child(div().w_full().min_w(0).font_family("JetBrains Mono").text_size(12).text_color(t.muted).whitespace_normal().child(`$ ${b.command}`))
        .when(!!b.output, (e) => e
          .child(div().id(`out-${b.id}`).cursor_pointer().text_size(12).text_color(t.muted).hover((x) => x.text_color(t.foreground))
            .on_click((_e, cx) => { if (open) this.open.delete(b.id); else this.open.add(b.id); cx.notify(); })
            .child(`${open ? "▾" : "▸"} Output`))
          .when(open, (e) => e.child(this.code(`${b.id}-out`, b.output, t)))))
      .when(!!b.caption, (e) => e.child(div().text_size(12).text_color(t.muted).whitespace_normal().child(String(b.caption))));
  }

  // a form field's InputState, made in init() (render only reads it)
  input(b, f) {
    const k = `${b.id}:${f.name}`;
    if (!this.inputs.has(k)) {
      const state = InputState.new({ placeholder: f.label ?? f.name, ...(f.kind === "textarea" ? { multi_line: true } : {}) });
      state.on("focus", () => holdKeys());
      this.inputs.set(k, state);
    }
    return this.inputs.get(k);
  }

  chart(b, t) {
    const s = chartShapes(b);
    // a legend's words with their translation beside them (SHEP-102)
    const tw = (field, words) => { const x = translation()?.units?.[`${this.paths.get(b)}.${field}`]; return x ? `${words} \u00b7 ${x}` : words; };
    const colors = [t.accent, t.working, t.done, t.blocked, t.muted];
    if (b.kind === "pie") {
      // one bar of shares, then its legend: the same numbers as the web's pie, readable at any width
      return v_flex().gap(8)
        .child(h_flex().w_full().h(14).rounded(7).overflow_hidden()
          .children(s.slices.map((x, i) => div().h_full().flex_basis(`${Math.max(0.5, x.share * 100)}%`).flex_grow(0).bg(colors[i % colors.length]))))
        .children(s.slices.map((x, i) => h_flex().gap(8).items_center()
          .child(div().size(10).rounded(5).bg(colors[i % colors.length]))
          .child(div().text_size(13).child(tw(`label.${i}`, String(x.label))))
          .child(div().text_size(12).text_color(t.muted).child(`${Math.round(x.share * 100)}%`))));
    }
    if (b.kind === "line") {
      // each series' points, joined by their order: dots on a plot, a value's height from the bottom
      // its labels under the plot, each with its translation under it (SHEP-102)
      const tl = (i) => translation()?.units?.[`${this.paths.get(b)}.label.${i}`];
      return v_flex().w_full().gap(6)
        .child(div().relative().w_full().h(140).border_b_1().border_color(t.border)
          .children(s.lines.flatMap((l, li) => l.points.map((p, i) => div().absolute().size(6).rounded(3).bg(colors[li % colors.length])
            .left(`${p.x * 96}%`).bottom(`${p.y * 92}%`)))))
        .when((b.labels ?? []).length > 0, (e) => e.child(h_flex().w_full().children((b.labels ?? []).map((l, i) => v_flex().flex_1().min_w(0).items_center()
          .child(div().w_full().text_size(11).text_color(t.muted).text_center().truncate().child(String(l)))
          .when(Boolean(tl(i)), (x) => x.child(div().w_full().text_size(11).text_color(t.foreground).text_center().truncate().child(String(tl(i) ?? ""))))))));
    }
    // bars: each label's group, a bar per series, its height from the biggest value
    const series = b.series ?? [], groups = (b.labels ?? []).length || Math.max(0, ...series.map((x) => x.values.length));
    return v_flex().gap(6)
      .child(h_flex().w_full().h(140).items_end().gap(4).border_b_1().border_color(t.border)
        .children(Array.from({ length: groups }, (_, gi) => h_flex().flex_1().h_full().items_end().justify_center().gap(2)
          .children(series.map((x, si) => div().flex_1().max_w(28).h(`${Math.max(1, (Math.max(0, x.values[gi] ?? 0) / s.max) * 100)}%`)
            .rounded_t(2).bg(colors[si % colors.length]))))))
      .child(h_flex().w_full().children((b.labels ?? []).map((l, i) => v_flex().flex_1().min_w(0).items_center()
        .child(div().w_full().text_size(11).text_color(t.muted).text_center().truncate().child(String(l)))
        // its translation under it (SHEP-102)
        .when(Boolean(translation()?.units?.[`${this.paths.get(b)}.label.${i}`]), (e) => e.child(div().w_full().text_size(11).text_color(t.foreground).text_center().truncate()
          .child(String(translation()?.units?.[`${this.paths.get(b)}.label.${i}`] ?? "")))))))
      .when(series.length > 1, (e) => e.child(h_flex().flex_wrap().gap(10).children(series.map((x, si) => h_flex().gap(6).items_center()
        .child(div().size(10).rounded(5).bg(colors[si % colors.length])).child(div().text_size(12).child(tw(`series.${si}`, String(x.name ?? ""))))))));
  }

  // A clip, a sound or a PDF: the window's player can't play them, so it shows the clip's poster (or a tile) and says
  // where to play it: the web app (the same artifact on the phone and in a browser plays it).
  media(b, t, mark, what, poster) {
    return v_flex().w_full().min_w(0).gap(4)
      .child(poster ? image(asset(poster)).w_full().rounded(6).border_1().border_color(t.border)
        : v_flex().w_full().h(96).rounded(6).bg(t.surface).items_center().justify_center().gap(2)
          .child(div().text_size(17).text_color(t.muted).child(mark))
          .child(div().text_size(12).text_color(t.muted).child(what)))
      .child(div().text_size(12).text_color(t.muted).whitespace_normal().child(`${String(b.caption ?? b.src ?? what)} · plays in the web app`));
  }

  // A block inside columns, tabs or details, keeping its box under its own place.
  nested(b, t, cx) {
    return tag(v_flex().w_full().min_w(0).child(this.block(b, t, cx)), this.paths.get(b));
  }

  block(b, t, cx) {
    const p = this.paths.get(b);
    switch (b.type) {
      case "heading": return this.withTr(div().text_size((b.level ?? 2) <= 1 ? 17 : 15).font_semibold().whitespace_normal().child(b.text), b, "text", t);
      case "text": return this.md(b.id, b.md, t, b);
      case "list": return v_flex().gap(4).children(b.items.map((x, i) => tag(h_flex().gap(8).items_start(), `${p}/items.${i}`)
        .child(div().flex_none().w(16).text_size(13).text_color(t.muted).child(b.ordered ? `${i + 1}.` : "•"))
        .child(this.withTr(this.md(`${b.id}-${i}`, x, t), b, `items.${i}`, t))));
      case "table": return v_flex().w_full().rounded(8).border_1().border_color(t.border).overflow_hidden()
        .child(tag(h_flex().w_full().px(10).py(6).bg(t.surface), `${p}/columns`).children(b.columns.map((c, i) => div().flex_1().min_w(0).text_size(12).font_medium().text_color(t.muted)
          .when((c.align ?? "") === "right", (e) => e.text_right()).child(String(c.label ?? c)).when(Boolean(this.tr(b, `col.${i}`, t)), (e) => e.child(this.tr(b, `col.${i}`, t))))))
        .children(b.rows.map((r, ri) => tag(h_flex().w_full().px(10).py(6).border_t_1().border_color(t.border), `${p}/rows.${ri}`)
          .children(r.map((c, i) => div().flex_1().min_w(0).text_size(13).whitespace_normal().when(b.columns[i]?.align === "right", (e) => e.text_right()).child(String(c ?? ""))
            .when(Boolean(this.tr(b, `cell.${ri}.${i}`, t)), (e) => e.child(this.tr(b, `cell.${ri}.${i}`, t)))))));
      case "chart": return this.withFail(this.chart(b, t), b, t);
      case "stats": return h_flex().flex_wrap().gap(8).children(b.items.map((x, i) => tag(v_flex().min_w(120).flex_1().p(10).gap(2).rounded(8).bg(t.surface), `${p}/items.${i}`)
        .child(this.withTr(div().text_size(12).text_color(t.muted).child(String(x.label)), b, `label.${i}`, t))
        .child(div().text_size(17).font_semibold().child(String(x.value)))
        .when(!!x.note, (e) => e.child(this.withTr(div().text_size(12).text_color(t.dim).child(String(x.note)), b, `note.${i}`, t)))));
      case "video": return this.withTr(this.media(b, t, "▶", "Video", b.poster ? b.poster : null), b, "caption", t);
      case "audio": return this.withTr(this.media(b, t, "♪", "Sound", null), b, "caption", t);
      case "pdf": return this.withTr(this.media(b, t, "PDF", "PDF", null), b, "caption", t);
      case "image": return v_flex().gap(4).when(isFull(), (e) => e.w_full().items_center())
        .child(this.picture(b.src, image(asset(b.src)).w_full().when(!!b.w && !!b.h, (e) => e.max_w(b.w)).rounded(6).border_1().border_color(t.border), b, p))
        .when(!!b.caption, (e) => e.child(div().text_size(12).text_color(t.muted).whitespace_normal().child(b.caption)))
        .when(Boolean(this.tr(b, "caption", t)), (e) => e.child(this.tr(b, "caption", t)));
      case "pair": return h_flex().flex_wrap().gap(10).when(isFull(), (e) => e.w_full().justify_center()).children([["Before", b.before], ["After", b.after]].map(([w, x]) => tag(v_flex().flex_1().min_w(240).gap(4), `${p}/${w.toLowerCase()}`).when(isFull(), (e) => e.items_center())
        .child(mediaKind(x.src) === "video" ? this.media(x, t, "▶", "Clip", x.poster ?? null)
          : this.picture(x.src, image(asset(x.src)).w_full().rounded(6).border_1().border_color(t.border), x, `${p}/${w.toLowerCase()}`))
        .child(this.withTr(div().text_size(12).text_color(t.muted).child(x.caption ?? w), b, w === "Before" ? "before" : "after", t))));
      case "code": return isDiff(b) ? this.diff(b, t) : this.code(b.id, b.text, t);
      case "check": return this.withTr(this.withTr(this.check(b, t), b, "summary", t), b, "caption", t);
      case "callout": return v_flex().gap(4).p(12).rounded(8).bg(t[TONE[b.tone ?? "info"]] ? t.surface : t.surface).border_l(3).border_color(t[TONE[b.tone ?? "info"]] ?? t.border)
        .when(!!b.title, (e) => e.child(this.withTr(div().text_size(13).font_semibold().child(b.title), b, "title", t)))
        .when(!!b.md, (e) => e.child(this.md(b.id, b.md, t, b)));
      case "columns": return h_flex().flex_wrap().gap(16).items_start().children(b.columns.map((c, i) => tag(v_flex().flex_1().min_w(240).gap(14), `${p}/columns.${i}`).children(c.map((x) => this.nested(x, t, cx)))));
      case "tabs": {
        const on = this.tab.get(b.id) ?? 0;
        return this.withFail(v_flex().gap(12)
          .child(h_flex().gap(4).flex_wrap().children(b.tabs.map((x, i) => tag(div().id(`tab-${b.id}-${i}`), `${p}/tabs.${i}`).h(26).px(10).flex().items_center().rounded(6).cursor_pointer()
            .bg(i === on ? t.surface : t.background).border_1().border_color(i === on ? t.border : t.background)
            .on_click((_e, cx) => { this.tab.set(b.id, i); layoutMoved(where()); cx.notify(); })
            .child(div().text_size(13).text_color(i === on ? t.foreground : t.muted).child((() => { const w = translation()?.units?.[`${this.paths.get(b)}.tab.${i}`]; return w ? `${x.label} \u00b7 ${w}` : x.label; })())))))
          .child(v_flex().gap(14).children((b.tabs[on]?.blocks ?? []).map((x) => this.nested(x, t, cx)))), b, t);
      }
      case "details": {
        const open = this.open.has(b.id);
        return v_flex().gap(10)
          .child(div().id(`det-${b.id}`).cursor_pointer().text_size(13).font_medium().text_color(t.muted)
            .on_click((_e, cx) => { if (open) this.open.delete(b.id); else this.open.add(b.id); layoutMoved(where()); cx.notify(); })
            .child(`${open ? "▾" : "▸"} ${b.summary}`))
          .when(Boolean(this.tr(b, "summary", t)), (e) => e.child(this.tr(b, "summary", t)))
          .when(open, (e) => e.child(v_flex().gap(14).pl(14).children(b.blocks.map((x) => this.nested(x, t, cx)))));
      }
      case "divider": return div().w_full().h(1).bg(t.border);
      case "choice": {
        // the kept pick, picked (another can still be chosen: it replaces it and goes to the agent too)
        const chosen = answerOf(this.answers, b.id)?.value ?? null, busy = this.sending.has(b.id);
        const note = this.answered("choice", b.id, t);
        return v_flex().gap(6)
          .child(this.withTr(div().text_size(13).font_semibold().whitespace_normal().child(b.question), b, "question", t))
          .children(b.options.map((o, i) => {
            const on = chosen === o.label, live = !on && !busy;
            return tag(v_flex().id(`ch-${b.id}-${i}`), `${p}/options.${i}`).p(10).gap(2).rounded(8).border_1().border_color(on ? t.foreground : t.border)
              .bg(on ? t.surface : t.background).when(live, (e) => e.cursor_pointer().hover((s) => s.bg(t.surface)))
              .on_click((_e, cx) => { if (live) this.send(b.id, o.label, choiceReply(b, o.label), cx); })
              .child(div().text_size(13).font_medium().child(on ? `✓ ${o.label}` : o.label))
              .when(!!o.description, (e) => e.child(div().text_size(12).text_color(t.muted).whitespace_normal().child(o.description)));
          }))
          .when(!!note, (e) => e.child(note));
      }
      case "form": {
        const kept = answerOf(this.answers, b.id), busy = this.sending.has(b.id);
        const note = this.answered("form", b.id, t);
        return v_flex().gap(8)
          .children(b.fields.map((f, i) => f.kind === "checkbox"
            ? tag(h_flex().id(`cb-${b.id}-${f.name}`), `${p}/fields.${i}`).gap(8).items_center().cursor_pointer()
              .on_click((_e, cx) => { this.checks.set(`${b.id}:${f.name}`, !this.checks.get(`${b.id}:${f.name}`)); cx.notify(); })
              .child(div().size(14).rounded(3).border_1().border_color(t.border).when(!!this.checks.get(`${b.id}:${f.name}`), (e) => e.bg(t.accent)))
              .child(div().text_size(13).child(f.label ?? f.name))
            : tag(v_flex().gap(4), `${p}/fields.${i}`).child(div().text_size(12).text_color(t.muted).child(f.label ?? f.name))
              .child(div().px(8).py(5).rounded(6).border_1().border_color(t.border).child(Input.new(this.input(b, f)).w_full().text_size(13)))))
          .child(h_flex().flex_wrap().gap(10).items_center()
            .child(div().id(`fs-${b.id}`).self_start().px(12).py(6).rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(13)
              .when(!busy, (e) => e.cursor_pointer()).on_click((_e, cx) => {
                if (busy) return;
                const values = Object.fromEntries(b.fields.map((f) => [f.name, f.kind === "checkbox" ? !!this.checks.get(`${b.id}:${f.name}`) : this.input(b, f).value()]));
                this.send(b.id, values, formReply(b, values), cx);
              }).child(busy ? "Sending…" : kept ? "Send again" : b.submit ?? "Send"))
            .when(!!note, (e) => e.child(note)));
      }
      case "button": return this.button(b, b.id, t).self_start();
      case "buttons": return h_flex().flex_wrap().gap(8).items_center().children(b.items.map((x, i) => tag(this.button(x, `${b.id}-${i}`, t), `${p}/items.${i}`)));
    }
    return div();
  }

  // A button: a press sends its reply, once; with an href (https only) it opens that page in the browser each press, a
  // plain link the person acts on themselves. quiet: the softer look, beside the one to press.
  button(b, key, t) {
    const link = isLink(b.href) ? b.href : null;
    const sent = Boolean(answerOf(this.answers, key)) || this.sending.has(key);
    const answers = typeof b.reply === "string";
    const live = link || !sent;
    return div().id(`bt-${key}`).px(12).py(6).rounded(6).text_size(13)
      .when(!b.quiet, (e) => e.bg(t.solid).text_color(t.solid_foreground))
      .when(!!b.quiet, (e) => e.border_1().border_color(t.border).text_color(t.foreground))
      .when(live, (e) => e.cursor_pointer()).on_click((_e, cx) => {
        if (link) cx.open_url(link);
        if (answers && !sent) this.send(key, b.label, b.reply, cx);
      }).child(sent && !link ? `${b.label} · Sent` : link ? `${b.label} ↗` : b.label);
  }

  render(cx) {
    const t = theme(), full = isFull();
    const tr = translation();
    // the whole version's translation on its way, or why it failed (a press asks again)
    const head = !tr || tr.state === "done" ? [] : [div().id("tr-head").w_full().pl(8).border_l(2).border_color(t.border).text_size(13)
      .when(tr.state === "error", (e) => e.cursor_pointer().text_color(t.blocked).on_click((_e, cx) => { retryTranslation(); cx.notify(); }))
      .when(tr.state !== "error", (e) => e.text_color(t.dim))
      .child(tr.state === "error" ? `${tr.error || TW.failed("")} \u00b7 ${TW.retry}` : TW.translating)];
    const body = this.error ? [div().text_size(13).text_color(t.muted).child(this.error)]
      : !this.recipe ? [] : [...head, ...this.recipe.blocks.map((b) => tag(v_flex().id(`blk-${b.id}`), this.paths.get(b)).w_full().min_w(0)
        // full screen: words at most FULL_TEXT wide; the window shows a clip as its poster, so it keeps that width too
        .when(full && (!fullWide(b) || b.type === "video"), (e) => e.max_w(FULL_TEXT)).child(this.block(b, t, cx)))];
    // scrolled or resized: the boxes Mark up kept are stale
    return v_flex().id("recipe").size_full().overflow_y_scrollbar().bg(t.background).text_color(t.foreground)
      .on_scroll_wheel(() => layoutMoved(where())).on_size_change(() => layoutMoved(where()))
      .child(withMarks(v_flex().id("recipe-body").w_full().p(16).gap(14).when(full, (e) => e.items_center())
        .on_mouse_move((e) => sawContent(where(), e.bounds)), null).children(body));
  }
}
