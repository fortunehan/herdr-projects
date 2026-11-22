// SHEP-99: the window's chat draws an agent's paths and URLs as links, and a click on one opens it (core/chat-links.js).
// The agent row is built as the window builds it, with gpui and herdr as stand-ins that keep the markdown it was given
// and its link handler, then the handler is run as a click would run it.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

let views: { id: string; text: string; click?: (url: string, cx: any) => unknown }[] = [];
function el(): any {
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "when") return (c: unknown, f: (e: any) => any) => (c ? f(self) : self);
      return () => self;
    },
  });
  return self;
}
function markdown(id: string, text: string) {
  const v: (typeof views)[number] = { id, text };
  views.push(v);
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "on_link_click") return (f: any) => { v.click = f; return self; };
      return () => self;
    },
  });
  return self;
}
const theme = new Proxy({}, { get: () => "#000000" });
let ran: [string, string[]][] = [];
let toasts: any[] = [];
let platform = "macos";
const HOME = "/h/me";
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom: 1 }), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => ({}), window: () => ({ platform }),
  home: () => HOME, appHome: () => "/nonexistent-app", layout: () => undefined,
  notify: (n: any) => { toasts.push(n); },
  exec: async (prog: string, args: string[]) => {
    ran.push([prog, args]);
    // the opener's own exit: 3 for a path that isn't there
    return { code: String(args.at(-1)).includes("gone") ? 3 : 0, stdout: "", stderr: "" };
  },
  hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: el, svg: el, image: el }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: el, h_flex: el, v_virtual_list: el, Scrollbar: el, TextView: { markdown } }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Chat } = await import("../mods/chat/main.js");

function chat(machine: string | null = null) {
  const c: any = Object.create(Chat.prototype);
  Object.assign(c, { width: 600, listW: { laid: 600 }, finding: false, machine, reach: null });
  return c;
}
const opened: string[] = [];
const cx: any = { open_url: (u: string) => opened.push(u), notify: () => {}, stop_propagation: () => {} };
const EXAMPLE = "三个方案的 HTML 预览做好了，在 `/tmp/sds18-mock/index.html`，可以直接在浏览器打开。";

function drawn(c: any, text: string) {
  views = [];
  c.rowBare({ kind: "agent", id: "a1", text }, theme);
  expect(views.length).toBe(1);
  return views[0];
}

describe("the window's chat: paths and links in an agent's reply (SHEP-99)", () => {
  beforeEach(() => { ran = []; toasts = []; opened.length = 0; platform = "macos"; });

  test("the person's example: the path in inline code is a link, the sentence around it as it was", () => {
    const v = drawn(chat(), EXAMPLE);
    expect(v.text).toBe("三个方案的 HTML 预览做好了，在 [`/tmp/sds18-mock/index.html`](file:///tmp/sds18-mock/index.html)，可以直接在浏览器打开。");
    expect(typeof v.click).toBe("function");
  });

  test("a click on a page opens it in the default browser (the opener's browser branch)", async () => {
    const v = drawn(chat(), EXAMPLE);
    await v.click!("file:///tmp/sds18-mock/index.html", cx);
    expect(ran).toHaveLength(1);
    const [prog, args] = ran[0];
    expect(prog).toBe("sh");
    expect(args.slice(2)).toEqual(["open-path", "browser", "/tmp/sds18-mock/index.html"]);
    expect(args[1]).toContain("URLForApplicationToOpenURL");
    expect(toasts).toEqual([]);
  });

  test("a click on a source file or folder shows it in Finder; ~/ is this machine's home", async () => {
    const v = drawn(chat(), "Changed ~/dev/shop/src/app.ts:12 and /h/me/dev/shop/");
    expect(v.text).toBe("Changed [\\~/dev/shop/src/app.ts:12](file:///h/me/dev/shop/src/app.ts) and [/h/me/dev/shop/](file:///h/me/dev/shop/)");
    await v.click!("file:///h/me/dev/shop/src/app.ts", cx);
    await v.click!("file:///h/me/dev/shop/", cx);
    expect(ran.map(([, a]) => a.slice(3))).toEqual([["reveal", "/h/me/dev/shop/src/app.ts"], ["reveal", "/h/me/dev/shop/"]]);
  });

  test("a URL goes to the default browser", async () => {
    const v = drawn(chat(), "See https://example.com/docs。");
    expect(v.text).toBe("See [https://example.com/docs](https://example.com/docs)。");
    await v.click!("https://example.com/docs", cx);
    expect(opened).toEqual(["https://example.com/docs"]);
    expect(ran).toEqual([]);
  });

  test("a missing path says so in a toast", async () => {
    const v = drawn(chat(), "`/tmp/gone/index.html`");
    await v.click!("file:///tmp/gone/index.html", cx);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: "Couldn't open it in the browser", body: "/tmp/gone/index.html isn't there.", level: "error" });
  });

  test("a fenced code block isn't linked", () => {
    const v = drawn(chat(), "Run:\n\n```\nopen /tmp/a/b.html\n```");
    expect(views.map((x) => x.text).join("")).not.toContain("file://");
    expect(v).toBeDefined();
  });

  test("another machine's agent: URLs are links, its paths stay plain", async () => {
    const c = chat("mini");
    const v = drawn(c, "At `/tmp/a/index.html`, docs https://x.y/z");
    expect(v.text).toBe("At `/tmp/a/index.html`, docs [https://x.y/z](https://x.y/z)");
    await v.click!("/tmp/a/index.html", cx);
    expect(ran).toEqual([]);
    expect(toasts[0]).toMatchObject({ title: "That path is on another machine", body: "It's on mini: open it there." });
  });

  test("Windows: a file that isn't there is told before anything runs; one that is opens with explorer", async () => {
    platform = "windows";
    const dir = mkdtempSync(join(tmpdir(), "chat-links-win-"));
    const page = join(dir, "index.html");
    writeFileSync(page, "");
    await chat().openPath(join(dir, "gone.html"));
    expect(ran).toEqual([]);
    expect(toasts[0].body).toContain("isn't there");
    await chat().openPath(page);
    expect(ran).toEqual([["explorer", [page]]]);
  });

  test("find's bold marks words, never a link's target", () => {
    const c = chat();
    c.finding = true;
    c.findBox = { value: () => "tmp" };
    const v = drawn(c, "at /tmp/a/b.html");
    expect(v.text).toBe("at [/**tmp**/a/b.html](file:///tmp/a/b.html)");
  });
});
