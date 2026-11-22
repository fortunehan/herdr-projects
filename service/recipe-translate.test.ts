// SHEP-102: the window's recipe view (mods/artifacts/recipe-view.js) draws an artifact's translation under each text
// block once the bar's Translate shows it (shared "artifacts.translate", lib/artifact-translate.js), code untouched, and
// a failure's Retry asks again through the same key. Installed as herdr-artifact installs it (recipe-view.js, recipe.js,
// translate.js, paths.js, recipe-data.js and a stub artifact.js), with gpui and herdr stand-ins.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, dispatch, element, fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const theme = new Proxy({}, { get: () => "#000000" });
let store: Record<string, any> = {};
mock.module("herdr", () => fakeHerdr({ theme: () => theme, shared: (k: string) => store[k], setShared: (k: string, v: unknown) => { store[k] = v; } }));
mock.module("gpui-kit", () => fakeGpuiKit());
const TextView = Object.assign(() => element("TextView"), { markdown: (_id: string, md: string) => element(`TextView:${md}`) });
mock.module("gpui-base", () => fakeGpuiBase({ TextView }));

const RECIPE = {
  recipe: 1,
  blocks: [
    { type: "heading", text: "合并现在会等检查通过" },
    { type: "text", md: "接受任务后才合并。\n\n```\nherdr-task ready\n```" },
    { type: "table", columns: ["步骤"], rows: [["检查通过"]] },
    { type: "code", text: "bun test" },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "recipe-translate-"));
for (const f of ["recipe-view.js"]) copyFileSync(join(import.meta.dir, "../mods/artifacts", f), join(dir, f));
for (const f of ["recipe.js", "translate.js", "paths.js"]) copyFileSync(join(import.meta.dir, "../mods/artifacts/core", f), join(dir, f));
writeFileSync(join(dir, "recipe-data.js"), `export default ${JSON.stringify(RECIPE)};\n`);
writeFileSync(join(dir, "artifact.js"), 'export const id = "art1"; export const version = 2; export const machine = null; export const asset = (s) => s; export const reply = async () => true; export const answer = async () => true; export const answers = async () => ({});\n');
const { default: RecipeView } = await import(join(dir, "recipe-view.js"));

const cx: any = new Proxy({}, { get: (t, k) => (t as any)[k] ?? (() => {}) });
const draw = (v: any) => { built.length = 0; return v.render(cx); };
const words = () => built.map((e) => e.kind).filter((k: string) => k.startsWith("TextView:")).map((k: string) => k.slice(9));
const texts = () => built.flatMap((e) => e.kids.filter((k: unknown) => typeof k === "string"));

describe("an artifact's translation in the window's recipe view (SHEP-102)", () => {
  let v: any;
  beforeEach(() => { store = {}; v = new RecipeView(); v.init({}, cx); });

  test("nothing until the bar's Translate shows it", () => {
    draw(v);
    expect(words().some((w) => w.includes("Merging"))).toBe(false);
  });

  test("each text's translation under it; code as it is", () => {
    store["artifacts.translate"] = { "|art1|2": { shown: true, state: "done", failed: [],
      units: { "0.text": "Merging now waits for the checks", "1.md.0": "It merges only after you accept.", "2.col.0": "Step", "2.cell.0.0": "Checks pass" } } };
    draw(v);
    expect(words()).toEqual(expect.arrayContaining(["Merging now waits for the checks", "接受任务后才合并。", "It merges only after you accept.", "Step", "Checks pass"]));
    // the original stays, before its translation
    expect(words().indexOf("接受任务后才合并。")).toBeLessThan(words().indexOf("It merges only after you accept."));
    expect(texts()).toContain("合并现在会等检查通过");
    expect(texts()).toContain("bun test");
    expect(texts()).toContain("herdr-task ready");
  });

  test("hidden again: the originals only", () => {
    store["artifacts.translate"] = { "|art1|2": { shown: false, state: "done", units: { "0.text": "Merging now waits for the checks" } } };
    draw(v);
    expect(words().some((w) => w.includes("Merging"))).toBe(false);
  });

  test("another version's translation isn't this one's", () => {
    store["artifacts.translate"] = { "|art1|1": { shown: true, state: "done", units: { "0.text": "Old words" } } };
    draw(v);
    expect(words()).not.toContain("Old words");
  });

  test("a failure is one line with Retry; a press asks again through the bar", () => {
    store["artifacts.translate"] = { "|art1|2": { shown: true, state: "error", error: "Couldn't translate: the endpoint refused the key (401)" } };
    draw(v);
    expect(texts().some((t: string) => t.includes("refused the key") && t.includes("Retry"))).toBe(true);
    dispatch(byId("tr-head")!, "on_click", cx);
    expect(store["artifacts.translate"]["|art1|2"].state).toBe("retry");
  });

  test("a block that failed alone says so under it", () => {
    store["artifacts.translate"] = { "|art1|2": { shown: true, state: "done", units: {}, failed: ["0.text"] } };
    draw(v);
    expect(texts().some((t: string) => t.startsWith("Couldn't translate this part"))).toBe(true);
  });
});
