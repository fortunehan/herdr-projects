// The window's model menu (mods/chat-models) opens on what runs now (SHEP-74): the agent's tab, its model checked and
// scrolled into view, and no other row lit (the keys' cursor sat on row 0 and drew like a hover, so the first model
// always looked chosen). The list is worked out once per change, not on every render (hovering lagged).
import { beforeEach, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, fakeGpuiBase, fakeGpuiKit, handler } from "./fake-gpui";

let p: any;
const none = async () => ({ code: 1, stdout: "", stderr: "" });
mock.module("herdr", () => fakeHerdr({
  props: () => p, theme: () => new Proxy({}, { get: (_t, k) => String(k) }), home: () => "/nonexistent-home", exec: none, hc: none,
  readTextFile: async () => null, writeTextFile: async () => {}, setShared: () => {}, closeOverlay: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase());

const { default: ModelMenu } = await import("../mods/chat-models/main.js");
const cx: any = new Proxy({ timer: { after: () => {}, every: () => {} } }, { get: (t, k) => (t as any)[k] ?? (() => ({ focus: () => {} })) });
const model = (id: string) => ({ id, name: id, efforts: ["high"] });
const menus = {
  claude: { name: "Claude Code", models: ["opus", "sonnet"].map(model), perms: [] },
  "claude-magpie": { name: "Claude Magpie", models: Array.from({ length: 40 }, (_, i) => model(`m${i}`)), perms: [] },
};

beforeEach(() => {
  built.length = 0;
  p = { pane: "x", current: { agent: "claude", launcher: "magpie", model: "m25", effort: "high", fast: false, perm: null }, menus, permDefault: {} };
});

const open = () => {
  const m: any = new ModelMenu();
  m.init({}, cx);
  const scrolled: unknown[][] = [];
  m.scroll = { scroll_to_item: (...a: unknown[]) => scrolled.push(a), release: () => {} };
  m.render(cx);
  return { m, scrolled };
};
const press = (m: any, key: string) => handler(byId("model-menu-area"), "on_key_down")!({ key }, cx);
const lit = (el: any) => el.calls.some(([n, a]: [string, unknown[]]) => n === "bg" && a[0] === "selected");
const bold = (el: any) => el.calls.some(([n]: [string]) => n === "font_medium");

test("it opens on the agent that runs, its model scrolled into view, and no row lit", () => {
  const { m, scrolled } = open();
  expect(m.tab).toBe("claude-magpie");
  expect(m.cursor).toBeNull();
  // the list has a heading first, so the model at row 25 is item 26
  expect(scrolled).toEqual([[26]]);
  const rows = m.sections().flatMap((s: any) => s.rows);
  expect(lit(m.modelRow({ selected: "selected" }, rows[0], false))).toBe(false);
  expect(bold(m.modelRow({ selected: "selected" }, rows[0], false))).toBe(false);
  expect(bold(m.modelRow({ selected: "selected" }, rows[25], false))).toBe(true);
});

test("the arrow keys start from the chosen model", () => {
  const { m } = open();
  press(m, "down");
  expect(m.cursor).toBe(25);
  press(m, "down");
  expect(m.cursor).toBe(26);
  m.render(cx);
  press(m, "up");
  expect(m.cursor).toBe(25);
});

test("another tab leaves the cursor off until a key moves it", () => {
  const { m } = open();
  press(m, "down");
  m.render(cx);
  press(m, "tab");
  expect(m.cursor).toBeNull();
});

test("the list is worked out again only when what it shows changes", () => {
  const { m } = open();
  const first = m.sections();
  m.render(cx);
  expect(m.sections()).toBe(first);
  m.tab = "claude";
  expect(m.sections()).not.toBe(first);
});
