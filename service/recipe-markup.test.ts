// SHEP-113: a Mark up note on a recipe in the window names the blocks it is on. GPUI tells a script where an element is
// only in its pointer events, so the recipe view (mods/artifacts/recipe-view.js) keeps each block's and part's box as
// the pointer moves over it, and Mark up (mods/artifacts/markup.js) reads them when a note is made.
// No window runs here: the view is installed as herdr-artifact installs it, gpui and herdr are stand-ins.
import { expect, mock, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { built, element, fakeGpuiBase, fakeGpuiKit, handler, type Call } from "./fake-gpui";

const theme = new Proxy({}, { get: () => "#000000" });
const home = mkdtempSync(join(tmpdir(), "recipe-markup-"));
let given: Record<string, unknown> = {};
const sharedState: Record<string, unknown> = {};
let run = async (_cmd: string, _args: string[]) => ({ code: 1, stdout: "", stderr: "" });
mock.module("herdr", () => fakeHerdr({
  props: () => given,
  theme: () => theme,
  appHome: () => home,
  home: () => home,
  settings: () => ({ zoom: 1 }),
  exec: (cmd: string, args: string[]) => run(cmd, args),
  shared: (k: string) => sharedState[k] ?? null,
  setShared: (k: string, v: unknown) => { sharedState[k] = v; },
  checking: () => true,
  agents: () => [],
}));
mock.module("gpui-kit", () => fakeGpuiKit());
const TextView = Object.assign(() => element("TextView"), { markdown: (_id: string, md: string) => element(`TextView:${md}`) });
mock.module("gpui-base", () => fakeGpuiBase({ TextView }));

const RECIPE = {
  recipe: 1,
  blocks: [
    { type: "heading", id: "h", text: "Release plan" },
    { type: "text", id: "t", md: "Some words" },
    { type: "columns", id: "c", columns: [[{ type: "callout", title: "Heads up" }], [{ type: "list", items: ["One", "Two"] }]] },
    { type: "table", id: "tb", columns: ["Name", "Count"], rows: [["Alpha", "12"], ["Beta", "9"]] },
    { type: "image", id: "im", src: "login.png", caption: "Sign-in screen" },
    { type: "stats", id: "st", items: [{ label: "Lines", value: "92%" }] },
    { type: "choice", id: "ch", question: "Which?", options: [{ label: "A" }, { label: "B" }] },
    { type: "pair", id: "pr", before: { src: "a.png" }, after: { src: "b.png" } },
  ],
};

const mod = join(home, "mods", "art-m");
mkdirSync(join(mod, "core"), { recursive: true });
copyFileSync(join(import.meta.dir, "../mods/artifacts/recipe-view.js"), join(mod, "recipe-view.js"));
for (const f of ["recipe.js", "translate.js", "paths.js"]) copyFileSync(join(import.meta.dir, "../mods/artifacts/core", f), join(mod, f));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/markup.js"), join(mod, "core", "markup.js"));
writeFileSync(join(mod, "recipe-data.js"), `export default ${JSON.stringify(RECIPE)};\n`);
writeFileSync(join(mod, "artifact.js"), "export const id = \"m\"; export const version = 1; export const machine = null; export const dir = \"mods/art-m\"; export const custom = false; export const agent = null; export const asset = (s) => `mods/art-m/${s}`; export const reply = async () => true; export const answer = async () => true; export const answers = async () => ({});\n");
// Mark up as herdr-artifact copies it in beside the view (artifact-markup.js and MARKUP_HELPERS)
copyFileSync(join(import.meta.dir, "../mods/artifacts/markup.js"), join(mod, "artifact-markup.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/dirs.js"), join(mod, "dirs.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/paths.js"), join(mod, "core", "paths.js"));
const { default: RecipeView } = await import(join(mod, "recipe-view.js"));
// the copy Mark up imports beside it: the same module as the view's
const M = await import(join(mod, "core", "markup.js"));

const cx: any = new Proxy({ spawn: () => undefined }, { get: (t, k) => (t as any)[k] ?? (() => {}) });

function drawn() {
  const v = new RecipeView();
  v.init({}, cx);
  built.length = 0;
  v.render(cx);
  return built.filter((e) => e.calls.some(([n]: Call) => n === "on_mouse_move"));
}

// Each tagged element's key: every one told a box of its own (x = its index) once, then read back.
function keys(where: string) {
  const els = drawn();
  M.layoutMoved(where);
  els.forEach((e, i) => handler(e, "on_mouse_move")!({ position: { x: 0, y: 0 }, bounds: { x: i, y: 0, width: 1, height: 1 } }));
  const byX = new Map<number, string>(M.seenBoxes(where, { x: 0, y: 0 }, false).nodes.map((n: any) => [n.x, n.key]));
  return els.map((e, i) => [e, byX.get(i)] as const);
}

test("every block and its parts keep their box under their place in the recipe", () => {
  given = {};
  // a picture keeps its box apart (SHEP-114): not among the blocks
  const all = keys("panel").map(([, k]) => k).filter((k) => k !== undefined);
  for (const k of ["0", "1", "2", "2/columns.0", "2/columns.1", "2.c0.0", "2.c1.0", "2.c1.0/items.1", "3", "3/columns", "3/rows.0", "3/rows.1", "4", "5/items.0", "6/options.1", "7/before", "7/after"]) {
    expect(all).toContain(k);
  }
  // each tag names something in the recipe
  for (const k of all) expect(M.recipeTarget(RECIPE, k)).not.toBeNull();
});

test("a click on a table row and a drag over the heading and picture name them, from the boxes the pointer crossed", () => {
  given = {};
  const tagged = new Map(keys("panel").map(([e, k]) => [k, e]));
  M.layoutMoved("panel");
  // the layer sits at (200, 100) in the window; the pointer crosses the heading, then the table's second row
  const move = (k: string, b: { x: number; y: number; width: number; height: number }, at: { x: number; y: number }) =>
    handler(tagged.get(k), "on_mouse_move")!({ position: at, bounds: b });
  move("0", { x: 216, y: 116, width: 600, height: 24 }, { x: 300, y: 120 });
  move("4", { x: 216, y: 400, width: 300, height: 200 }, { x: 300, y: 450 });
  move("3", { x: 216, y: 200, width: 600, height: 96 }, { x: 300, y: 280 });
  move("3/rows.1", { x: 216, y: 264, width: 600, height: 32 }, { x: 300, y: 280 });
  // markup.js's own blocksUnder, run as written with the window's place and the layer's origin
  const src = readFileSync(join(import.meta.dir, "../mods/artifacts/markup.js"), "utf8");
  const body = src.slice(src.indexOf("function blocksUnder("), src.indexOf("function select("));
  const blocksUnder = new Function("seenBoxes", "noteOn", "pictureUnder", "where", `${body}; return blocksUnder;`)(M.seenBoxes, M.noteOn, M.pictureUnder, () => "panel");
  const m = { origin: { x: 200, y: 100 } };
  expect(blocksUnder(m, { x: 100, y: 180, w: 0, h: 0 }, true)).toEqual({ on: { blocks: [{ path: "blocks[3].rows[1]", kind: "table row 2", text: "Beta | 9" }], more: 0 } });
  expect(blocksUnder(m, { x: 0, y: 0, w: 700, h: 520 }, false).on.blocks.map((b: any) => b.kind)).toEqual(["heading", "table", "image"]);
  // a click off every block: no blocks, only the spot
  expect(blocksUnder(m, { x: 700, y: 10, w: 0, h: 0 }, true)).toEqual({});
  // scrolled: what was kept is stale
  const root = built.find((e) => e.calls.some(([n, a]: Call) => n === "id" && a[0] === "recipe"));
  handler(root, "on_scroll_wheel")!({});
  expect(blocksUnder(m, { x: 0, y: 0, w: 700, h: 520 }, false)).toEqual({});
});

test("the viewer's copy keeps its own boxes", () => {
  given = { overlay: "o1" };
  keys("viewer");
  given = {};
  M.layoutMoved("panel");
  expect(M.seenBoxes("panel", { x: 0, y: 0 }, false).nodes).toEqual([]);
  expect(M.seenBoxes("viewer", { x: 0, y: 0 }, false).nodes.length).toBeGreaterThan(10);
});

test("Mark up sends a single note's blocks with --blocks, and several notes' inside --notes", () => {
  const src = readFileSync(join(import.meta.dir, "../mods/artifacts/markup.js"), "utf8");
  expect(src).toContain('args.push("--blocks", JSON.stringify({ blocks: out.blocks ?? [], more: out.more ?? 0, ...(out.picture ? { picture: out.picture } : {}) }))');
  expect(src).toContain('args.push("--notes", JSON.stringify(out.notes))');
  expect(src).toContain("...blocksUnder(m, s, !p.moved)");
});

// SHEP-114: GPUI's TextView can't tell a script what words are selected (gpui-kit.d.ts: selectable() and nothing to
// read it), so the window has no notes on selected words; a Mark up note on a picture names the picture and the spot
// in it, from the picture's box the pointer crossed.
test("a click or a drag on a picture in the window's Mark up names the picture and the spot in it", () => {
  given = {};
  const v = new RecipeView();
  v.init({}, cx);
  built.length = 0;
  v.render(cx);
  const pic = (src: string) => built.find((e) => e.calls.some(([n, a]: Call) => n === "id" && a[0] === `pic-${src}`));
  M.layoutMoved("panel");
  // the layer at (200, 100); the image block's picture drawn 400×250 at (216, 400), the pair's before 300×200 below
  handler(pic("login.png"), "on_mouse_move")!({ position: { x: 300, y: 450 }, bounds: { x: 216, y: 400, width: 400, height: 250 } });
  handler(pic("a.png"), "on_mouse_move")!({ position: { x: 300, y: 700 }, bounds: { x: 216, y: 680, width: 300, height: 200 } });
  const src = readFileSync(join(import.meta.dir, "../mods/artifacts/markup.js"), "utf8");
  const body = src.slice(src.indexOf("function blocksUnder("), src.indexOf("function select("));
  const blocksUnder = new Function("seenBoxes", "noteOn", "pictureUnder", "where", `${body}; return blocksUnder;`)(M.seenBoxes, M.noteOn, M.pictureUnder, () => "panel");
  const m = { origin: { x: 200, y: 100 } };
  // a click on the last move's picture: the pair's before, its spot in it
  expect(blocksUnder(m, { x: 166, y: 630, w: 0, h: 0 }, true)).toEqual({ picture: { file: "a.png", path: "blocks[7].before", spot: { x: 0.5, y: 0.25, w: 0, h: 0 } } });
  // a drag over the image block's top right quarter: its spot in it, sent in percent (no size known here)
  const note = blocksUnder(m, { x: 216, y: 300, w: 200, h: 125 }, false);
  expect(note).toEqual({ picture: { file: "login.png", path: "blocks[4]", caption: "Sign-in screen", spot: { x: 0.5, y: 0, w: 0.5, h: 0.5 } } });
  const out = M.outgoing([{ ...M.toFrac({ x: 216, y: 300, w: 200, h: 125 }, { width: 800, height: 900 }), text: "Too dark", ...note }], "", { width: 800, height: 900 });
  expect(out).toEqual({ kind: "note", text: "Too dark", spot: "the area from 50% to 100% across, 0% to 50% down (the top right quarter) of picture “login.png”",
    picture: { file: "login.png", path: "blocks[4]", caption: "Sign-in screen", spot: "the area from 50% to 100% across, 0% to 50% down (the top right quarter)" } });
  // off the pictures: blocks as before
  expect(blocksUnder(m, { x: 700, y: 10, w: 0, h: 0 }, true)).toEqual({});
  expect(src).toContain("cur.picture ? MARKUP.picture");
});

// SHEP-115: the recipe scrolls under the still Mark up layer, so a note can't stay in the layer's px. Made on a recipe,
// it keeps its spot as fractions of the content and of the tag it starts on, and the recipe view draws it inside that
// tag (in percent of it): it moves with the tag as the recipe scrolls or reflows. A sent note stays there, faded.
test("a window note is drawn inside the tag it marked, before and after Send all", async () => {
  given = {};
  sharedState["artifacts.markup"] = { mod: "art-m", where: "panel" };
  const { markupInit, markupWrap } = await import(join(mod, "artifact-markup.js"));
  const wcx: any = new Proxy({ spawn: (f: (c: unknown) => unknown) => f(wcx), timer: { after: (_ms: number, f: () => void) => f() } }, { get: (t, k) => (t as any)[k] ?? (() => {}) });
  const v = new RecipeView();
  v.init({}, wcx);
  const m = markupInit(wcx);
  const frame = () => { built.length = 0; return markupWrap(m, v.render(wcx), wcx); };
  const byIdNow = (id: string) => built.find((e) => e.calls.some(([c, a]: Call) => c === "id" && a[0] === id));
  // the element tagged key in the last frame (each tagged element told a box at x = its index, then read back)
  const tagged = (key: string) => {
    const els = built.filter((e) => e.calls.some(([c]: Call) => c === "on_mouse_move") && e !== byIdNow("recipe-body") && e !== byIdNow("art-mark-layer"));
    M.layoutMoved("panel");
    els.forEach((e, i) => handler(e, "on_mouse_move")!({ position: { x: 0, y: 0 }, bounds: { x: i, y: 0, width: 1, height: 1 } }));
    const i = M.seenBoxes("panel", { x: 0, y: 0 }, false).nodes.find((n: any) => n.key === key).x;
    return els[i];
  };
  frame();
  const row = tagged("3/rows.1");
  const body = byIdNow("recipe-body");
  const layer = byIdNow("art-mark-layer");
  expect(layer).toBeDefined();
  // the layer at (200, 100) in the window; the recipe scrolled 300 px: its content's top at y -200, 1500 tall; the
  // pointer crosses the table's second row (window y 264–296), presses at layer (100, 180) and drags to (300, 190)
  M.layoutMoved("panel");
  handler(body, "on_mouse_move")!({ position: { x: 300, y: 280 }, bounds: { x: 216, y: -200, width: 600, height: 1500 } });
  handler(row, "on_mouse_move")!({ position: { x: 300, y: 280 }, bounds: { x: 216, y: 264, width: 600, height: 32 } });
  handler(layer, "on_mouse_move")!({ position: { x: 300, y: 280 }, local_position: { x: 100, y: 180 } }, wcx);
  handler(layer, "on_mouse_down")!({ position: { x: 300, y: 280 }, local_position: { x: 100, y: 180 } }, wcx);
  handler(layer, "on_mouse_move")!({ position: { x: 500, y: 290 }, local_position: { x: 300, y: 190 } }, wcx);
  handler(layer, "on_mouse_up")!({ position: { x: 500, y: 290 } }, wcx);
  const n = m.notes[0];
  // on the row: from 84 px of its 600, half way down its 32, 200×10 px
  expect(n.anchor.key).toBe("3/rows.1");
  expect([n.anchor.x, n.anchor.y, n.anchor.w, n.anchor.h].map((x: number) => +x.toFixed(4))).toEqual([0.14, 0.5, 0.3333, 0.3125]);
  // and on the whole content: y 480 of its 1500 (scrolled 300 + 180), x 84 of its 600
  expect(n.y).toBeCloseTo(480 / 1500);
  expect(n.x).toBeCloseTo(84 / 600);
  // Send all describes it in the content's px
  expect(M.outgoing(m.notes.map((x: any) => ({ ...x, text: "Say Friday" })), "", { width: 600, height: 1500, page: true }).spot)
    .toBe("the 200×10 px area at x 84–284, y 480–490 of the 600×1500 page (near the top left)");
  // drawn again: the mark is a child of the row, in percent of it, and none is on the layer
  frame();
  const pct = (el: any) => el?.kids?.find((k: any) => k?.calls?.some(([c, a]: Call) => c === "left" && String(a[0]).endsWith("%")));
  const onRow = pct(tagged("3/rows.1"));
  expect(onRow.calls.filter(([c]: Call) => ["left", "top", "w", "h"].includes(c)).map(([, a]: Call) => a[0])).toEqual(["14%", "50%", "33.33%", "31.25%"]);
  expect(byIdNow("art-mark-layer").kids).toEqual([byIdNow("art-mark-card")]);
  // Send all goes; the note stays on the row, faded with a tick for its number
  run = async (cmd: string) => (cmd.endsWith("herdr-artifact") ? { code: 0, stdout: '{"ok":true,"to":"a1"}', stderr: "" } : { code: 1, stdout: "", stderr: "" });
  m.notes[0].text = "Say Friday";
  handler(byIdNow("art-mark-send"), "on_click")!({}, wcx);
  for (let i = 0; i < 5 && m.notes.length; i++) await Bun.sleep(1);
  expect(m.notes).toEqual([]);
  expect(m.sent.length).toBe(1);
  frame();
  const sent = pct(tagged("3/rows.1"));
  expect(sent.calls.some(([c]: Call) => c === "opacity")).toBe(true);
  expect(byIdNow("art-mark-sent-s0")).toBeDefined();
  // Mark up off: nothing drawn on the recipe
  sharedState["artifacts.markup"] = null;
  frame();
  expect(pct(tagged("3/rows.1"))).toBeUndefined();
});
