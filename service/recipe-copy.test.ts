// SHEP-228: in the window's recipe view (mods/artifacts/recipe-view.js), every code box has a Copy button that puts
// its whole text on the clipboard: a code block, and a fenced block inside a text, a list item or a callout. The window
// binds no copy key to a page's selected text, so a command an agent asks the person to run had to be retyped.
// No window runs here: the view is installed as herdr-artifact installs it (recipe-view.js, recipe.js, recipe-data.js
// and a stub artifact.js in one folder), gpui and herdr are stand-ins, and a click runs the button's real handler.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, dispatch, element, fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({ theme: () => theme }));
mock.module("gpui-kit", () => fakeGpuiKit());
const TextView = Object.assign(() => element("TextView"), { markdown: (_id: string, md: string) => element(`TextView:${md}`) });
mock.module("gpui-base", () => fakeGpuiBase({ TextView }));

const RECIPE = {
  recipe: 1,
  blocks: [
    { type: "code", id: "cmd", text: "herdr-task list\n  --all" },
    { type: "text", id: "t", md: "Run this:\n\n```sh\nbun install && bun run build\n```\n\nThen reload." },
    { type: "list", id: "l", items: ["Plain step", "Then:\n  ```\n  git pull --rebase\n  ```"] },
    { type: "callout", id: "c", tone: "warn", title: "Before you go", md: "~~~\nexport A=1\necho $A\n~~~" },
    { type: "text", id: "p", md: "Just words, with `inline code`." },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "recipe-copy-"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/recipe-view.js"), join(dir, "recipe-view.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/recipe.js"), join(dir, "recipe.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/translate.js"), join(dir, "translate.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/paths.js"), join(dir, "paths.js"));
// what Mark up reads its boxes from (SHEP-113), as herdr-artifact installs it
mkdirSync(join(dir, "core"), { recursive: true });
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/markup.js"), join(dir, "core", "markup.js"));
writeFileSync(join(dir, "recipe-data.js"), `export default ${JSON.stringify(RECIPE)};\n`);
writeFileSync(join(dir, "artifact.js"), "export const id = \"x\"; export const version = 1; export const machine = null; export const asset = (s) => s; export const reply = async () => true; export const answer = async () => true; export const answers = async () => ({});\n");
const { default: RecipeView } = await import(join(dir, "recipe-view.js"));

let clipboard: string[] = [];
let timers: [number, (cx: any) => void][] = [];
const cx: any = new Proxy({
  write_to_clipboard: (s: string) => clipboard.push(s),
  timer: { after: (ms: number, f: (cx: any) => void) => timers.push([ms, f]) },
}, { get: (t, k) => (t as any)[k] ?? (() => {}) });

const draw = (v: any) => { built.length = 0; return v.render(cx); };
const copyIds = () => built.flatMap((e) => e.calls.filter(([n, a]: any) => n === "id" && String(a[0]).startsWith("copy-")).map(([, a]: any) => a[0]));
const label = (id: string) => byId(id)!.kids.filter((k: unknown) => typeof k === "string").pop();

describe("Copy buttons on code in the window's recipe view (SHEP-228)", () => {
  let v: any;
  beforeEach(() => { clipboard = []; timers = []; v = new RecipeView(); v.init({}, cx); draw(v); });

  test("every code box has one: a code block, and fences in a text, a list item and a callout", () => {
    expect(copyIds()).toEqual(["copy-cmd", "copy-t-c1", "copy-l-1-c1", "copy-c-c0"]);
  });

  test("a click copies the box's whole text, as written (the fence's indent and marks left out)", () => {
    for (const id of copyIds()) dispatch(byId(id)!, "on_click", cx);
    expect(clipboard).toEqual(["herdr-task list\n  --all", "bun install && bun run build", "git pull --rebase", "export A=1\necho $A"]);
  });

  test("the words around a fence still show as Markdown, and plain text is drawn as before", () => {
    const md = built.map((e) => e.kind).filter((k: string) => k.startsWith("TextView:"));
    expect(md).toContain("TextView:Run this:\n");
    expect(md).toContain("TextView:\nThen reload.");
    expect(md).toContain("TextView:Then:");
    expect(md).toContain("TextView:Just words, with `inline code`.");
    expect(md.some((k: string) => k.includes("```") || k.includes("~~~"))).toBe(false);
  });

  test("the button says Copied a moment, then Copy again; the click goes no further", () => {
    expect(label("copy-t-c1")).toBe("Copy");
    const ran = dispatch(byId("copy-t-c1")!, "on_click", cx);
    expect(ran.length).toBe(1);
    draw(v);
    expect(label("copy-t-c1")).toBe("Copied");
    expect(label("copy-cmd")).toBe("Copy");
    expect(timers.map(([ms]) => ms)).toEqual([1500]);
    timers[0][1](cx);
    draw(v);
    expect(label("copy-t-c1")).toBe("Copy");
  });

  test("an older box's timer doesn't clear a newer box's Copied", () => {
    dispatch(byId("copy-cmd")!, "on_click", cx);
    dispatch(byId("copy-c-c0")!, "on_click", cx);
    timers[0][1](cx);
    draw(v);
    expect(label("copy-c-c0")).toBe("Copied");
  });
});

// SHEP-87: the window's view keeps the person's answers (artifact.js answer/answers: herdr-artifact note --answer and
// answers), shows a kept pick with when, lets a choice change, and draws check blocks and coloured diffs.
const RECIPE2 = {
  recipe: 1,
  blocks: [
    { type: "choice", id: "ship", question: "Ship it?", options: [{ label: "Ship" }, { label: "Wait" }] },
    { type: "check", id: "ok", command: "bun test", exit: 0, summary: "12 pass", output: "all good" },
    { type: "check", id: "bad", command: "make", exit: 2 },
    { type: "code", id: "d", lang: "diff", text: "@@ -1 +1 @@\n-old\n+new" },
  ],
};
const dir2 = mkdtempSync(join(tmpdir(), "recipe-answers-"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/recipe-view.js"), join(dir2, "recipe-view.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/recipe.js"), join(dir2, "recipe.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/translate.js"), join(dir2, "translate.js"));
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/paths.js"), join(dir2, "paths.js"));
// what Mark up reads its boxes from (SHEP-113), as herdr-artifact installs it
mkdirSync(join(dir2, "core"), { recursive: true });
copyFileSync(join(import.meta.dir, "../mods/artifacts/core/markup.js"), join(dir2, "core", "markup.js"));
writeFileSync(join(dir2, "recipe-data.js"), `export default ${JSON.stringify(RECIPE2)};\n`);
writeFileSync(join(dir2, "artifact.js"), `export const id = "y"; export const version = 1; export const machine = null; export const asset = (s) => s;
export const sent = [];
export let kept = { ship: { value: "Ship", at: ${new Date(2026, 0, 1, 9, 5).getTime()}, by: "web" } };
export const answer = async (key, value, text) => { sent.push([key, value, text]); return true; };
export const answers = async () => kept;
`);
const { default: RecipeView2 } = await import(join(dir2, "recipe-view.js"));
const art2: any = await import(join(dir2, "artifact.js"));

describe("Answers, check blocks and diffs in the window's recipe view (SHEP-87)", () => {
  const cx2: any = new Proxy({ spawn: (f: (cx: any) => unknown) => f(cx2), timer: { after: () => {} } }, { get: (t, k) => (t as any)[k] ?? (() => {}) });
  const texts = () => built.flatMap((e) => e.kids.filter((k: unknown) => typeof k === "string")) as string[];
  let v: any;
  beforeEach(async () => { art2.sent.length = 0; v = new RecipeView2(); v.init({}, cx2); await Bun.sleep(0); draw2(); });
  const draw2 = () => { built.length = 0; return v.render(cx2); };

  test("a kept pick shows picked, with when it was chosen", () => {
    expect(texts()).toContain("✓ Ship");
    expect(texts()).toContain("Wait");
    expect(texts().some((s) => /^You chose this (at|on) .*09:05$/.test(s))).toBe(true);
  });

  test("another option can be chosen: kept and sent with its key and value; the picked one does nothing", async () => {
    dispatch(byId("ch-ship-0")!, "on_click", cx2);
    expect(art2.sent).toEqual([]);
    dispatch(byId("ch-ship-1")!, "on_click", cx2);
    await Bun.sleep(0);
    expect(art2.sent).toEqual([["ship", "Wait", "Ship it?: Wait"]]);
    draw2();
    expect(texts()).toContain("✓ Wait");
    expect(texts()).toContain("Ship");
  });

  test("a check says Passed or Failed with its exit code; its output folds", () => {
    expect(texts()).toContain("Passed");
    expect(texts()).toContain("Failed · exit 2");
    expect(texts()).toContain("$ bun test");
    expect(texts()).toContain("▸ Output");
    dispatch(byId("out-ok")!, "on_click", cx2);
    draw2();
    expect(texts()).toContain("▾ Output");
    expect(texts()).toContain("all good");
  });

  test("a diff's lines each in their colour", () => {
    expect(texts()).toEqual(expect.arrayContaining(["@@ -1 +1 @@", "-old", "+new"]));
  });
});
