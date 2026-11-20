// SHEP-90: a picture in the window's recipe view (mods/artifacts/recipe-view.js) opens the window's picture viewer
// (mods/chat-image), on every picture in the recipe from the clicked one, each by its file in the artifact's folder,
// so the viewer's copy, open and show-in-folder act on a file that is there. Before, a click on a picture did nothing.
// No window runs here: the view is installed as herdr-artifact installs it, gpui and herdr are stand-ins.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, dispatch, element, fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const theme = new Proxy({}, { get: () => "#000000" });
const opened: any[] = [];
const home = mkdtempSync(join(tmpdir(), "recipe-pictures-"));
mock.module("herdr", () => fakeHerdr({
  theme: () => theme,
  appHome: () => home,
  settings: () => ({ zoom: 1 }),
  openOverlay: (spec: unknown) => { opened.push(spec); return "o1"; },
  exec: async () => ({ code: 1, stdout: "", stderr: "" }),
}));
mock.module("gpui-kit", () => fakeGpuiKit());
const TextView = Object.assign(() => element("TextView"), { markdown: (_id: string, md: string) => element(`TextView:${md}`) });
mock.module("gpui-base", () => fakeGpuiBase({ TextView }));

const RECIPE = {
  recipe: 1,
  blocks: [
    { type: "image", id: "a", src: "shots/after.png", caption: "After" },
    { type: "pair", id: "p", before: { src: "old.webp" }, after: { src: "clip.mp4" } },
    { type: "image", id: "s", src: "icon.svg" },
  ],
};

const mod = join(home, "mods", "art-x");
mkdirSync(join(mod, "shots"), { recursive: true });
copyFileSync(join(import.meta.dir, "../web/public/splash/375x812@3-dark.png"), join(mod, "shots/after.png"));
copyFileSync(join(import.meta.dir, "../assets/shepherdr-launch.webp"), join(mod, "old.webp"));
copyFileSync(join(import.meta.dir, "../mods/chat-image/zoom-in.svg"), join(mod, "icon.svg"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/recipe-view.js"), join(mod, "recipe-view.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/recipe.js"), join(mod, "recipe.js"));
writeFileSync(join(mod, "recipe-data.js"), `export default ${JSON.stringify(RECIPE)};\n`);
writeFileSync(join(mod, "artifact.js"), "export const asset = (s) => `mods/art-x/${s}`; export const reply = async () => true; export const answer = async () => true; export const answers = async () => ({});\n");
const { default: RecipeView } = await import(join(mod, "recipe-view.js"));

let spawned: Promise<unknown>[] = [];
const cx: any = new Proxy({ spawn: (f: (cx: any) => Promise<unknown>) => spawned.push(f(cx)) }, { get: (t, k) => (t as any)[k] ?? (() => {}) });
const draw = (v: any) => { built.length = 0; return v.render(cx); };
const click = async (id: string) => { dispatch(byId(id)!, "on_click", cx); await Promise.all(spawned); };

describe("a picture in the window's recipe view opens the picture viewer (SHEP-90)", () => {
  let v: any;
  beforeEach(async () => { opened.length = 0; spawned = []; v = new RecipeView(); v.init({}, cx); await Promise.all(spawned); spawned = []; draw(v); });

  test("every picture is clickable, a clip is not", () => {
    expect(byId("pic-shots/after.png")).toBeTruthy();
    expect(byId("pic-old.webp")).toBeTruthy();
    expect(byId("pic-icon.svg")).toBeTruthy();
    expect(byId("pic-clip.mp4")).toBeUndefined();
  });

  test("a click opens chat-image over the window on all the pictures, from the clicked one, each with its size and file", async () => {
    await click("pic-old.webp");
    expect(opened.length).toBe(1);
    const o = opened[0];
    expect(o).toMatchObject({ mod: "chat-image", kind: "dialog", frame: "none" });
    expect(o.props.index).toBe(1);
    expect(o.props.images).toEqual([
      { rel: "mods/art-x/shots/after.png", w: 1125, h: 2436, name: "After", path: join(mod, "shots/after.png") },
      { rel: "mods/art-x/old.webp", w: 720, h: 720, name: "Before", path: join(mod, "old.webp") },
      { rel: "mods/art-x/icon.svg", w: 24, h: 24, name: "icon.svg", path: join(mod, "icon.svg") },
    ]);
    expect(o.props.width).toBe(o.width);
    expect(o.props.height).toBe(o.height);
  });

  test("a second click while it opens doesn't open it twice", async () => {
    dispatch(byId("pic-icon.svg")!, "on_click", cx);
    dispatch(byId("pic-icon.svg")!, "on_click", cx);
    await Promise.all(spawned);
    expect(opened.length).toBe(1);
    expect(opened[0].props.index).toBe(2);
  });
});
