// SHEP-109: the window's chat draws its rows with a virtual list, whose rows take no handlers (gpui-kit.d.ts: "no
// handlers and no retained state inside it"). SHEP-99 put a link handler on every agent reply there, and every chat's
// message list drew blank. Each kind of row is built here as the list builds it, from texts shaped like a real
// Assistant log (a 35 KB brief, replies full of paths and URLs, code), with gpui stand-ins that note any on_* call and
// keep the element tree, so a test reads the words on the elements a row really returns. The list's own renderer is
// main.js's code, run as written.
import { describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";
import { marked } from "marked";

const handlers: string[] = [];
/** Every markdown a TextView was given (what could hold a link). */
const mds: string[] = [];
const KIDS = Symbol("kids");
function el(md?: string): any {
  const kids: unknown[] = md === undefined ? [] : [md];
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === KIDS) return kids;
      if (k === "then") return undefined;
      if (k === "when") return (c: unknown, f: (e: any) => any) => (c ? f(self) : self);
      if (typeof k === "string" && k.startsWith("on_")) return () => { handlers.push(k); return self; };
      if (k === "child") return (c: unknown) => { kids.push(c); return self; };
      if (k === "children") return (cs: unknown[]) => { kids.push(...cs); return self; };
      return () => self;
    },
  });
  return self;
}
/** The words on an element and everything under it: plain strings and TextViews' markdown, in order. */
function words(e: any): string {
  if (typeof e === "string") return e;
  if (!e || typeof e !== "object") return "";
  return (e[KIDS] ?? []).map(words).filter(Boolean).join("\n");
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
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: el, h_flex: el, v_virtual_list: el, Scrollbar: el, TextView: { markdown: (_id: string, md: string) => { mds.push(md); return el(md); } } }));
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

  test("each message's words are on the row it returns: a reply, the person's words, the 35 KB brief", () => {
    const c = chat();
    const shown = (x: any) => words(c.safeRow(x, theme, "v0-"));
    expect(shown(ROWS[5])).toContain("SHEP-99 is ready.");
    expect(shown(ROWS[5])).toContain("`/tmp/shep99/index.html`, the code in ~/dev/shop/src/app.ts:12, docs [https://x.y/z](https://x.y/z)");
    expect(shown(ROWS[3])).toContain("看看 /tmp/a.png");
    // the brief is longer than one frame's budget: the first frame may show it as written, never empty
    const brief = shown(ROWS[2]);
    expect(brief.length).toBeGreaterThan(30000);
    expect(brief).toContain("You are the coordinator of one space in Herdr.");
  });

  test("past a frame's budget the rest show as written, ask for a redraw, and get their links on it", () => {
    const c = chat();
    const shown = (x: any) => words(c.safeRow(x, theme, "v0-"));
    c.linkSpent = 1e9;
    const x = { kind: "agent", id: "a9", text: "See https://example.com/late" };
    expect(shown(x)).toContain("See https://example.com/late");
    expect(shown(x)).not.toContain("](https://example.com/late)");
    expect(c.linkWaiting).toBe(true);
    c.linkSpent = 0;
    expect(shown(x)).toContain("[https://example.com/late](https://example.com/late)");
  });

  /** The one code block a fallback row shows: its text, exactly as written, and no link in it (marked as TextView). */
  const codeOnly = (md: string) => {
    const toks: any[] = [];
    marked.walkTokens(marked.lexer(md), (t: any) => { toks.push(t); });
    expect(toks.filter((t) => t.type === "link" || t.type === "html")).toEqual([]);
    return toks.filter((t) => t.type === "code").map((t) => t.text);
  };

  test("a message too long to rework shows as written, in one code block, never reworked", () => {
    const c = chat();
    const huge = "B1 = <yours>\nsecond line [r](file:///tmp/r.pdf) ```x```\n" + "x\n".repeat(30000);
    for (const kind of ["agent", "user"]) {
      c.linkSpent = 0;
      mds.length = 0;
      c.safeRow({ kind, id: "h", text: huge }, theme, "v0-");
      const body = mds.filter((m) => m.includes("B1"));
      expect(body).toHaveLength(1);
      expect(codeOnly(body[0])).toEqual([huge]);
      expect(c.linkWaiting).toBeFalsy();
      expect(c.preps?.size ?? 0).toBe(0); // never reworked: no mentions, links or breaks made for it
    }
  });

  test("while it waits on the budget a message shows as written too: no link in it, < as typed", () => {
    const c = chat();
    c.linkSpent = 1e9;
    for (const kind of ["agent", "user"]) {
      mds.length = 0;
      const text = "B1 = <yours>\n[r](file:///tmp/r.pdf)";
      c.safeRow({ kind, id: `w-${kind}`, text }, theme, "v0-");
      const body = mds.filter((m) => m.includes("B1"));
      expect(body).toHaveLength(1);
      expect(codeOnly(body[0])).toEqual([text]);
    }
  });

  test("a long message's code block is made once and within the budget: past it, its start for now, whole on the redraw", () => {
    const c = chat();
    const long = "start `a` " + "x `y` ".repeat(10000);
    c.linkSpent = 1e9;
    mds.length = 0;
    c.safeRow({ kind: "user", id: "l1", text: long }, theme, "v0-");
    const first = mds.find((m) => m.includes("start"))!;
    expect(first.length).toBeLessThan(2100);
    expect(first).toContain("\n…\n");
    expect(c.linkWaiting).toBe(true);
    c.linkSpent = 0;
    mds.length = 0;
    c.safeRow({ kind: "user", id: "l1", text: long }, theme, "v0-");
    expect(codeOnly(mds.find((m) => m.includes("start"))!)).toEqual([long]);
    // kept: the next frame, even past its budget, gets the whole block without making it again
    c.linkSpent = 1e9;
    c.linkWaiting = false;
    mds.length = 0;
    c.safeRow({ kind: "user", id: "l1", text: long }, theme, "v0-");
    expect(codeOnly(mds.find((m) => m.includes("start"))!)).toEqual([long]);
    expect(c.linkWaiting).toBe(false);
  });

  test("the list's renderer, as main.js has it: every row's words, a throwing row plain, the row after it whole", () => {
    const src = require("node:fs").readFileSync(require.resolve("../mods/chat/main.js"), "utf8") as string;
    const at = src.indexOf('v_virtual_list("chat-rows", rows.length, sizes, (i) => rows[i].id, ');
    const from = src.indexOf("(range) => {", at);
    const to = src.indexOf("\n        })\n          .track_scroll(this.scroll)", from);
    expect(at > 0 && from > at && to > from).toBe(true);
    const renderer = new Function("rows", "sizes", "lit", "current", "t", "div", "scrollEstimate",
      `return ${src.slice(from, to + "\n        }".length)};`);
    const c = chat();
    const real = c.row.bind(c);
    c.row = (x: any, ...a: any[]) => { if (x.id === "bad") throw new Error("boom"); return real(x, ...a); };
    Object.assign(c, { measureGen: 0, flash: null, scrollTop: 0 });
    const rows = [ROWS[5], { kind: "agent", id: "bad", text: "the broken one" }, { kind: "agent", id: "next", text: "the next one" }];
    const fn = renderer.call(c, rows, rows.map(() => 80), new Set(), null, theme, el, (_s: unknown, _r: unknown, top: number) => top);
    const out = fn({ start: 0, end: rows.length }).map(words);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("SHEP-99 is ready.");
    expect(out[1]).toContain("the broken one");
    expect(out[2]).toContain("the next one");
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
