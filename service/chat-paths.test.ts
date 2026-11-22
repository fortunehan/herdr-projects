// SHEP-110: the window chat's Paths action. An agent reply that names paths gets a Paths icon in its band (the row
// under it with Reply and Copy); a press on it (clickRow, the list's on_item_click: rows take no handlers, SHEP-109)
// lists the reply's paths under the band, one row each, and a press on one opens it with core/chat-links.js's rules.
// The rows are built and drawn by main.js's own code, with gpui and herdr as stand-ins that note on_* calls, every exec
// and every toast.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const handlers: string[] = [];
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
function words(e: any): string {
  if (typeof e === "string") return e;
  if (!e || typeof e !== "object") return "";
  return (e[KIDS] ?? []).map(words).filter(Boolean).join("\n");
}
const theme = new Proxy({}, { get: () => "#000000" });
let ran: [string, string[]][] = [];
let toasts: { title: string; body?: string; level?: string }[] = [];
let code = 0;
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom: 1 }), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => ({}), window: () => ({ platform: "macos" }),
  home: () => "/h/me", appHome: () => "/nonexistent-app", layout: () => undefined,
  notify: (n: any) => { toasts.push(n); },
  exec: async (prog: string, args: string[]) => { ran.push([prog, args]); return { code, stdout: "", stderr: "" }; },
  hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: el, svg: el, image: el }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: el, h_flex: el, v_virtual_list: el, Scrollbar: el, TextView: { markdown: (_id: string, md: string) => el(md) } }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Chat } = await import("../mods/chat/main.js");

const REPLY = "SHEP-99 is ready. The proof is at `/tmp/shep99/index.html`, the code in ~/dev/shop/src/app.ts:12, the app "
  + "/Applications/Preview.app and docs https://x.y/z。\n\n```sh\nopen /tmp/only-in-code/b.html\n```\n";
const URLS = "Docs at https://example.com/a/b and https://x.y/z.";

/** A chat with one conversation of agent replies, built by main.js's rows() with the rest of its inputs stubbed. */
function chat(machine: string | null = null, texts = [REPLY, URLS]) {
  const c: any = Object.create(Chat.prototype);
  Object.assign(c, { width: 760, listW: { laid: 760 }, finding: false, machine, reach: null, opened: new Set(), copied: null,
    results: new Map(), heights: new Map(), unfolded: new Set(), myReacts: new Map(), views: {}, arts: [], askEnds: [], pending: [],
    queue: [], replied: [], asks: [], cardW: new Map(), start: 0, kind: "claude", t: null, addr: "t1" });
  c.conv = { items: texts.map((text, i) => ({ kind: "agent", id: `a${i}`, text, at: Date.now() - 1000 * (texts.length - i) })), reactions: new Map() };
  Object.assign(c, { status: (): string => "idle", resolveArts: () => new Map(), newsLines: () => ({ extra: [], inline: new Map() }),
    loadAskEnds: () => {}, workerTasks: () => new Map(), timelineCards: () => [] });
  return c;
}
/** The press the list hands clickRow: on a band, at the named action's place (barLayout()). */
function pressOn(c: any, rows: any[], id: string, what: string | null = null) {
  const row = rows.find((r) => r.id === id);
  const part = what ? c.barLayout(row.bar).parts.find((p: any) => p.what === what) : null;
  c.press = { x: part ? part.x + part.w / 2 : 100, at: Date.now() };
  c.clickRow(id, rows, { notify: () => {}, write_to_clipboard: () => {}, timer: { after: () => {} } }, rows.map(() => 30));
}
const built = (c: any) => c.spaced(c.rows());

describe("the window chat's Paths action (SHEP-110)", () => {
  beforeEach(() => { ran = []; toasts = []; code = 0; handlers.length = 0; });

  test("a reply that names paths gets Paths in its band; one with only URLs doesn't", () => {
    const rows = built(chat());
    expect(rows.find((r: any) => r.id === "ab:a0").bar.acts).toEqual(["reply", "copy", "paths", "fork"]);
    expect(rows.find((r: any) => r.id === "ab:a1").bar.acts).toEqual(["reply", "copy", "fork"]);
  });

  test("pressing Paths lists the reply's paths under its band, never one only in a code block; again closes it", () => {
    const c = chat();
    let rows = built(c);
    pressOn(c, rows, "ab:a0", "paths");
    rows = built(c);
    const at = rows.findIndex((r: any) => r.id === "ab:a0");
    const picks = rows.filter((r: any) => r.kind === "pathpick");
    expect(picks.map((r: any) => r.path)).toEqual(["/tmp/shep99/index.html", "/h/me/dev/shop/src/app.ts", "/Applications/Preview.app"]);
    expect(rows[at + 1].id).toBe("pp:a0:0");
    expect(picks.every((r: any) => r.blk === "a0")).toBe(true);
    pressOn(c, rows, "ab:a0", "paths");
    expect(built(c).some((r: any) => r.kind === "pathpick")).toBe(false);
    expect(ran).toEqual([]);
  });

  test("each path's row shows the path and what a press does, and takes no handler", () => {
    const c = chat();
    pressOn(c, built(c), "ab:a0", "paths");
    const rows = built(c);
    const drawn = rows.filter((r: any) => r.kind === "pathpick").map((r: any) => words(c.safeRow(r, theme, "v0-")));
    // its icon (a page or a folder), the path, what a press does
    expect(drawn).toEqual(["mods/chat/file.svg\n/tmp/shep99/index.html\nOpen in browser", "mods/chat/folder-open.svg\n/h/me/dev/shop/src/app.ts\nShow in Finder",
      "mods/chat/folder-open.svg\n/Applications/Preview.app\nShow in Finder"]);
    for (const r of rows) c.safeRow(r, theme, "v0-");
    expect(handlers).toEqual([]);
  });

  test("a picked page opens in the default browser, a source file and an app are shown in Finder", async () => {
    const c = chat();
    pressOn(c, built(c), "ab:a0", "paths");
    const rows = built(c);
    for (const id of ["pp:a0:0", "pp:a0:1", "pp:a0:2"]) pressOn(c, rows, id);
    await new Promise((r) => setTimeout(r, 10));
    expect(ran.map(([prog, args]) => [prog, ...args.slice(2)])).toEqual([
      ["sh", "open-path", "browser", "/tmp/shep99/index.html"],
      ["sh", "open-path", "reveal", "/h/me/dev/shop/src/app.ts"],
      ["sh", "open-path", "reveal", "/Applications/Preview.app"],
    ]);
    expect(toasts).toEqual([]);
  });

  test("a path that isn't there says so in a toast", async () => {
    const c = chat();
    pressOn(c, built(c), "ab:a0", "paths");
    code = 3;
    pressOn(c, built(c), "pp:a0:0");
    await new Promise((r) => setTimeout(r, 10));
    expect(toasts).toEqual([{ title: "Couldn't open it in the browser", body: "/tmp/shep99/index.html isn't there.", level: "error" }]);
  });

  test("another machine's agent: Paths says the paths are there, lists and opens nothing", () => {
    const c = chat("mini");
    pressOn(c, built(c), "ab:a0", "paths");
    expect(built(c).some((r: any) => r.kind === "pathpick")).toBe(false);
    expect(toasts).toEqual([{ title: "Those paths are on another machine", body: "They're on mini: open them there.", level: "info" }]);
    expect(ran).toEqual([]);
  });

  test("a reply whose only path is in a code block: Paths says there's none", () => {
    const c = chat(null, ["Run:\n\n```sh\nopen /tmp/a/b.html\n```"]);
    const rows = built(c);
    expect(rows.find((r: any) => r.id === "ab:a0").bar.acts).toContain("paths");
    pressOn(c, rows, "ab:a0", "paths");
    expect(built(c).some((r: any) => r.kind === "pathpick")).toBe(false);
    expect(toasts.map((t) => t.title)).toEqual(["No paths to open"]);
  });

  test("the first look is kept per message: rows built again don't scan the reply again", () => {
    const c = chat();
    built(c);
    const kept = new Map(c.pathy);
    built(c);
    expect(c.pathy).toEqual(kept);
    expect([...kept.values()]).toEqual([true, false]);
  });
});
