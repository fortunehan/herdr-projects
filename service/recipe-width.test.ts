// SHEP-107: the window's recipe view (mods/artifacts/recipe-view.js) takes the whole width it is given, so a full-screen
// artifact fills the window; before, the whole recipe stopped at 860 px. Words keep a reading width.
// No window runs here: the view is installed as herdr-artifact installs it, gpui and herdr are stand-ins.
import { describe, expect, mock, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, element, fakeGpuiBase, fakeGpuiKit, type Call } from "./fake-gpui";

const theme = new Proxy({}, { get: () => "#000000" });
const home = mkdtempSync(join(tmpdir(), "recipe-width-"));
// SHEP-111: the viewer's props (artview.js artifactContent gives { full: true } full screen)
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
    { type: "text", id: "t", md: "Some words" },
    { type: "columns", id: "c", columns: [[{ type: "text", md: "left" }], [{ type: "text", md: "right" }]] },
    { type: "table", id: "tb", columns: ["A", "B"], rows: [["1", "2"]] },
    { type: "image", id: "im", src: "small.png" },
    { type: "image", id: "iw", src: "big.png", w: 300, h: 100 },
  ],
};

const mod = join(home, "mods", "art-w");
mkdirSync(mod, { recursive: true });
copyFileSync(join(import.meta.dir, "../mods/artifacts/recipe-view.js"), join(mod, "recipe-view.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/recipe.js"), join(mod, "recipe.js"));
// its Translate lines (SHEP-102), as herdr-artifact installs them beside recipe.js
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/translate.js"), join(mod, "translate.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/paths.js"), join(mod, "paths.js"));
// what Mark up reads its boxes from (SHEP-113), as herdr-artifact installs it
mkdirSync(join(mod, "core"), { recursive: true });
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/markup.js"), join(mod, "core", "markup.js"));
// a PNG's first bytes: its signature and IHDR (width, height), all imageSize reads
const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
writeFileSync(join(mod, "small.png"), png(700, 20));
writeFileSync(join(mod, "big.png"), png(1600, 900));
writeFileSync(join(mod, "recipe-data.js"), `export default ${JSON.stringify(RECIPE)};\n`);
writeFileSync(join(mod, "artifact.js"), "export const id = \"w\"; export const version = 1; export const machine = null; export const asset = (s) => `mods/art-w/${s}`; export const reply = async () => true; export const answer = async () => true; export const answers = async () => ({});\n");
const { default: RecipeView } = await import(join(mod, "recipe-view.js"));

let spawned: Promise<unknown>[] = [];
const cx: any = new Proxy({ spawn: (f: (cx: any) => Promise<unknown>) => spawned.push(f(cx)) }, { get: (t, k) => (t as any)[k] ?? (() => {}) });
const maxW = (e: any) => e.calls.filter(([n]: Call) => n === "max_w").map(([, a]: Call) => a[0]);
const parent = (e: any) => built.find((p) => p.kids.includes(e));

describe("the window's recipe view fills a full-screen artifact (SHEP-107)", () => {
  test("the recipe's column has the whole width, no cap", async () => {
    const v = new RecipeView();
    v.init({}, cx);
    await Promise.all(spawned);
    built.length = 0;
    v.render(cx);
    const body = byId("recipe-body")!;
    expect(body.calls.some(([n]: Call) => n === "w_full")).toBe(true);
    expect(maxW(body)).toEqual([]);
    // each block, and the blocks of the columns, are as wide as the body
    expect(maxW(byId("blk-c"))).toEqual([]);
    expect(maxW(byId("blk-tb"))).toEqual([]);
  });

  test("words keep a reading width", async () => {
    const v = new RecipeView();
    v.init({}, cx);
    await Promise.all(spawned);
    built.length = 0;
    v.render(cx);
    const words = built.filter((e) => e.kind === "TextView:Some words").map(parent);
    expect(words.length).toBe(1);
    expect(maxW(words[0])).toEqual([760]);
  });
});

describe("full screen, the window's recipe is centred, words at most 1000 px, pictures at most their own size (SHEP-111)", () => {
  const draw = async (props: Record<string, unknown>) => {
    given = props;
    spawned = [];
    const v = new RecipeView();
    v.init({}, cx);
    await Promise.all(spawned);
    built.length = 0;
    v.render(cx);
    given = {};
  };
  const has = (e: any, n: string) => e.calls.some(([m]: Call) => m === n);

  test("full screen: the body centres its blocks; words and tables stop at 1000, pictures and columns don't", async () => {
    await draw({ full: true });
    expect(has(byId("recipe-body"), "items_center")).toBe(true);
    expect(maxW(byId("blk-t"))).toEqual([1000]);
    expect(maxW(byId("blk-tb"))).toEqual([1000]);
    expect(maxW(byId("blk-c"))).toEqual([]);
    expect(maxW(byId("blk-im"))).toEqual([]);
    const words = built.filter((e) => e.kind === "TextView:Some words").map(parent);
    expect(maxW(words[0])).toEqual([1000]);
  });

  test("full screen: a picture is drawn at most as wide as its file (the recipe's w first), centred", async () => {
    await draw({ full: true });
    expect(maxW(byId("pic-small.png"))).toEqual([700]);
    expect(maxW(byId("pic-big.png"))).toEqual([300]);
    expect(has(parent(byId("pic-small.png")), "items_center")).toBe(true);
  });

  test("not full screen: today's layout", async () => {
    await draw({});
    expect(has(byId("recipe-body"), "items_center")).toBe(false);
    expect(maxW(byId("blk-t"))).toEqual([]);
    expect(maxW(byId("pic-small.png"))).toEqual([]);
    const words = built.filter((e) => e.kind === "TextView:Some words").map(parent);
    expect(maxW(words[0])).toEqual([760]);
  });
});
