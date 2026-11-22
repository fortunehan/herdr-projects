// SHEP-109: the window's chat draws its rows with a virtual list, whose rows take no handlers (gpui-kit.d.ts: "no
// handlers and no retained state inside it"). SHEP-99 put a link handler on every agent reply there, and every chat's
// message list drew blank. Each kind of row is built here as the list builds it, from texts shaped like a real
// Assistant log (a 35 KB brief, replies full of paths and URLs, code), with gpui stand-ins that note any on_* call.
import { describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const handlers: string[] = [];
/** The words a row shows: each TextView's markdown and each plain child string, in order. */
const shown: string[] = [];
function el(): any {
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "when") return (c: unknown, f: (e: any) => any) => (c ? f(self) : self);
      if (typeof k === "string" && k.startsWith("on_")) return () => { handlers.push(k); return self; };
      if (k === "child") return (c: unknown) => { if (typeof c === "string") shown.push(c); return self; };
      return () => self;
    },
  });
  return self;
}
const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom: 1 }), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => ({}), window: () => ({ platform: "macos" }),
  home: () => "/h/me", appHome: () => "/nonexistent-app", layout: () => undefined, notify: () => {},
  exec: async () => ({ code: 0, stdout: "", stderr: "" }), hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: el, svg: el, image: el }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: el, h_flex: el, v_virtual_list: el, Scrollbar: el, TextView: { markdown: (_id: string, md: string) => { shown.push(md); return el(); } } }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Chat } = await import("../mods/chat/main.js");

const BRIEF = "You are the coordinator of one space in Herdr.\n" + "- Keep `~/.config/herdr-app` safe; see /tmp/a/b.md and https://example.com/x.\n".repeat(480);
const REPLY = "SHEP-99 is ready. The proof is at `/tmp/shep99/index.html`, the code in ~/dev/shop/src/app.ts:12, docs https://x.y/z。\n\n"
  + "| # | what |\n|---|---|\n| 1 | [link](https://example.com) |\n\n```sh\nopen /tmp/a/b.html\n```\n";

function chat(machine: string | null = null) {
  const c: any = Object.create(Chat.prototype);
  Object.assign(c, { width: 760, listW: { laid: 760 }, finding: false, machine, reach: null, opened: new Set(["b2"]), copied: null,
    results: new Map(), heights: new Map() });
  return c;
}
const bar = (side: string, text: string) => ({ id: `b:${side}`, of: side, target: text, text, side, at: Date.now(), pills: [], acts: ["copy", "react"] });
const ROWS: any[] = [
  { kind: "top", id: "top" },
  { kind: "day", id: "day:1", text: "Today" },
  { kind: "user", id: "u1", text: BRIEF },
  { kind: "user", id: "u2", text: "看看 /tmp/a.png 和 https://example.com", bar: bar("user", "x") },
  { kind: "band", id: "ab:u2", h: 30, bar: bar("user", "x") },
  { kind: "agent", id: "a1", text: REPLY, bar: bar("agent", REPLY) },
  { kind: "agent", id: "a2", text: REPLY.repeat(20), clip: 300 },
  { kind: "codehead", id: "a3:h0", lang: "sh", code: "open /tmp/a/b.html" },
  { kind: "code", id: "a3:c0", lang: "sh", code: "open /tmp/a/b.html" },
  { kind: "brief", id: "b1", label: "New session", text: BRIEF },
  { kind: "brief", id: "b2", label: "Message from SHEP-4", text: REPLY, who: "SHEP-4", at: Date.now() },
  { kind: "pending", id: "p1", text: "on its way", delivered: true },
  { kind: "note", id: "n1", text: "a note" },
  { kind: "end", id: "end" },
];

describe("the window chat's list rows take no handlers (SHEP-109)", () => {
  for (const machine of [null, "mini"]) {
    test(`every kind of row, ${machine ? "another machine's" : "this machine's"} agent`, () => {
      const c = chat(machine);
      const built: string[] = [];
      for (const x of ROWS) {
        handlers.length = 0;
        c.safeRow(x, theme, "v0-");
        built.push(`${x.kind}:${handlers.join(",")}`);
      }
      expect(built).toEqual(ROWS.map((x) => `${x.kind}:`));
    });
  }

  test("each message's words are on its row: a reply, the person's words, the 35 KB brief", () => {
    const c = chat();
    const words = (x: any) => { shown.length = 0; c.safeRow(x, theme, "v0-"); return shown.join("\n"); };
    expect(words(ROWS[5])).toContain("SHEP-99 is ready.");
    expect(words(ROWS[5])).toContain("[`/tmp/shep99/index.html`](file:///tmp/shep99/index.html)");
    expect(words(ROWS[3])).toContain("看看 /tmp/a.png");
    // the brief is longer than one frame's budget: the first frame may show it as written, never empty
    const brief = words(ROWS[2]);
    expect(brief.length).toBeGreaterThan(30000);
    expect(brief).toContain("You are the coordinator of one space in Herdr.");
  });

  test("past a frame's budget the rest show as written, ask for a redraw, and get their links on it", () => {
    const c = chat();
    const words = (x: any) => { shown.length = 0; c.safeRow(x, theme, "v0-"); return shown.join("\n"); };
    c.linkSpent = 1e9;
    const x = { kind: "agent", id: "a9", text: "See https://example.com/late" };
    expect(words(x)).toContain("See https://example.com/late");
    expect(words(x)).not.toContain("](https://example.com/late)");
    expect(c.linkWaiting).toBe(true);
    c.linkSpent = 0;
    expect(words(x)).toContain("[https://example.com/late](https://example.com/late)");
  });

  test("a row that throws shows its words plain, and the next row still draws", () => {
    const c = chat();
    const real = c.row.bind(c);
    c.row = (x: any, ...a: any[]) => { if (x.id === "bad") throw new Error("boom"); return real(x, ...a); };
    shown.length = 0;
    expect(() => c.safeRow({ kind: "agent", id: "bad", text: "the broken one" }, theme, "v0-")).not.toThrow();
    expect(shown).toContain("the broken one");
    shown.length = 0;
    c.safeRow({ kind: "agent", id: "next", text: "the next one" }, theme, "v0-");
    expect(shown.join("\n")).toContain("the next one");
  });

  test("init() runs a timer that redraws once rows are waiting, also ones drawn from inside layout", () => {
    const src = require("node:fs").readFileSync(require.resolve("../mods/chat/main.js"), "utf8") as string;
    const init = src.slice(src.indexOf("  init(_props, cx) {"), src.indexOf("    this.inner = _props?.inner === true;") + 2000);
    expect(init).toMatch(/cx\.timer\.every\(\d+, \(cx\) => \{ if \(this\.linkWaiting\) \{ this\.linkWaiting = false; cx\.notify\(\); \} \}\)/);
  });

  test("the main.js list renderer draws rows only through safeRow", () => {
    const src = require("node:fs").readFileSync(require.resolve("../mods/chat/main.js"), "utf8") as string;
    const list = src.slice(src.indexOf('v_virtual_list("chat-rows"'), src.indexOf(".track_scroll(this.scroll)"));
    expect(list).toContain("this.safeRow(x, t,");
    expect(list).not.toMatch(/this\.row\(/);
    expect(list).not.toMatch(/\.on_[a-z_]+\(/);
  });
});
