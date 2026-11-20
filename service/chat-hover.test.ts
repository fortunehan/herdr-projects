// SHEP-94: moving the pointer over a long message in the window's chat made it shake. The list redraws every 6 px the
// pointer moves (rows' hover styles), and each redraw measures the rows on screen again; a settled row reported a
// different height then went straight to the list, and, following the newest, sent it back to its end. The measuring
// rows' handlers are run here as the window would, with gpui and herdr as stand-ins that keep the handlers given.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const handlers: Record<string, ((...a: any[]) => void)[]> = {};
function el(): any {
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "when") return (c: unknown, f: (e: any) => any) => (c ? f(self) : self);
      if (k === "on_size_change") return (f: any) => { (handlers.size ??= []).push(f); return self; };
      return () => self;
    },
  });
  return self;
}
const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom: 1 }), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => ({}), window: () => ({ platform: "linux" }),
  home: () => "/nonexistent-home", appHome: () => "/nonexistent-app",
  exec: async () => ({ code: 1, stdout: "", stderr: "" }), hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: el, svg: el, image: el }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: el, h_flex: el, v_virtual_list: el, Scrollbar: el, TextView: { markdown: el } }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Chat } = await import("../mods/chat/main.js");
const resize: any = await import("../mods/chat/core/chat-resize.js");

// A chat following the newest, its long message (1600 px, measured long ago) on screen.
const rows = [{ id: "u1", kind: "user", text: "hi" }, { id: "a1", kind: "agent", text: "long ".repeat(4000) }, { id: "e", kind: "end" }];
const keys = rows.map((r) => r.id);
function chat() {
  const c: any = Object.create(Chat.prototype);
  const long = Date.now() - 60_000;
  Object.assign(c, {
    heights: new Map([["u1", 50], ["a1", 1600], ["e", 10]]), prevHeights: new Map(),
    measuredAt: new Map(keys.map((k) => [k, long])), measureGen: 0, width: 600, range: { start: 1, end: 3 },
    pinned: true, stick: false, cardW: new Map(), hoverBand: null,
  });
  if (resize.HoverHold) c.hold = new resize.HoverHold();
  c.row = () => el();
  return c;
}
const cx: any = { notify: () => {} };
const sizes = (c: any) => keys.map((k) => c.heights.get(k));
// One redraw: the measuring rows are built, and the long one reports the height it came out at this time.
function redraw(c: any, longH: number) {
  for (const k of Object.keys(handlers)) delete handlers[k];
  c.measurer(rows, keys, theme);
  handlers.size[keys.indexOf("a1")]({ width: 600, height: longH }, cx);
}

describe("hovering a long message moves nothing (SHEP-94)", () => {
  beforeEach(() => { for (const k of Object.keys(handlers)) delete handlers[k]; });

  test("redraws while the pointer moves over it keep every row's size, and the list where it is", () => {
    const c = chat();
    const before = sizes(c);
    const seen: string[] = [];
    // The pointer crosses ten 6 px bands; the long row comes out a few px different on alternate redraws.
    for (let band = 40; band < 50; band++) {
      c.hoverBand = band;
      redraw(c, band % 2 ? 1612 : 1600);
      seen.push(`${sizes(c).join(",")} stick=${c.stick}`);
      c.stick = false;
    }
    console.log(seen.join("\n"));
    expect(seen.every((s) => s === `${before.join(",")} stick=false`)).toBe(true);
  });

  test("the pointer leaving the list lets the last height in, once", () => {
    const c = chat();
    c.hoverBand = 41;
    redraw(c, 1612);
    expect(c.heights.get("a1")).toBe(1600);
    c.hoverBand = null;
    c.letGo();
    expect(c.heights.get("a1")).toBe(1612);
    expect(c.stick).toBe(true);
  });

  test("without the pointer on the list a new height goes to the list at once", () => {
    const c = chat();
    redraw(c, 1612);
    expect(c.heights.get("a1")).toBe(1612);
    expect(c.stick).toBe(true);
  });

  test("a row measured just now still settles while the pointer is on it", () => {
    const c = chat();
    c.measuredAt.set("a1", Date.now());
    c.hoverBand = 41;
    redraw(c, 1612);
    expect(c.heights.get("a1")).toBe(1612);
  });
});
