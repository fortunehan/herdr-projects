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
mock.module("herdr", () => fakeHerdr({
  props: () => given,
  theme: () => theme,
  appHome: () => home,
  settings: () => ({ zoom: 1 }),
  exec: async () => ({ code: 1, stdout: "", stderr: "" }),
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
writeFileSync(join(mod, "artifact.js"), "export const id = \"m\"; export const version = 1; export const machine = null; export const asset = (s) => `mods/art-m/${s}`; export const reply = async () => true; export const answer = async () => true; export const answers = async () => ({});\n");
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
  const all = keys("panel").map(([, k]) => k);
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
  const blocksUnder = new Function("seenBoxes", "noteOn", "where", `${body}; return blocksUnder;`)(M.seenBoxes, M.noteOn, () => "panel");
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
  expect(src).toContain('args.push("--blocks", JSON.stringify({ blocks: out.blocks, more: out.more ?? 0 }))');
  expect(src).toContain('args.push("--notes", JSON.stringify(out.notes))');
  expect(src).toContain("...blocksUnder(m, s, !p.moved)");
});
