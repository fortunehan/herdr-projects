// SHEP-99/109: the window's chat draws an agent's URLs as links (core/chat-links.js), never its paths. The agent row is
// built as the window builds it, with gpui and herdr as stand-ins that keep the markdown it was given. The row carries
// no link handler (rows are drawn by the virtual list, which takes none: one there blanked every chat); TextView opens
// a link itself, whatever it leads to, so no path is made a link (the Terminal view's Cmd-click opens paths).
import { beforeEach, describe, expect, mock, test } from "bun:test";
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
const HOME = "/h/me";
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom: 1 }), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => ({}), window: () => ({ platform: "macos" }),
  home: () => HOME, appHome: () => "/nonexistent-app", layout: () => undefined,
  notify: () => {},
  exec: async (prog: string, args: string[]) => { ran.push([prog, args]); return { code: 0, stdout: "", stderr: "" }; },
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
const EXAMPLE = "三个方案的 HTML 预览做好了，在 `/tmp/sds18-mock/index.html`，可以直接在浏览器打开。";

function drawn(c: any, text: string) {
  views = [];
  c.rowBare({ kind: "agent", id: "a1", text }, theme);
  expect(views.length).toBe(1);
  return views[0];
}

describe("the window's chat: URLs in an agent's reply are links, paths are words (SHEP-99, SHEP-109)", () => {
  beforeEach(() => { ran = []; });

  test("the person's example: the path stays as written, no link", () => {
    expect(drawn(chat(), EXAMPLE).text).toBe(EXAMPLE);
  });

  test("the row carries no link handler: TextView opens a URL itself (SHEP-109)", () => {
    expect(drawn(chat(), EXAMPLE).click).toBeUndefined();
    expect(drawn(chat(), "See https://example.com/docs").click).toBeUndefined();
    expect(ran).toEqual([]);
  });

  test("a URL is a link", () => {
    expect(drawn(chat(), "See https://example.com/docs。").text).toBe("See [https://example.com/docs](https://example.com/docs)。");
  });

  test("no path becomes a link: files, folders, apps, ~/", () => {
    const words = "Changed ~/dev/shop/src/app.ts:12, /h/me/dev/shop/, /tmp/r.pdf and /Applications/Preview.app";
    expect(drawn(chat(), words).text).toBe(words);
  });

  test("a path link the agent wrote shows its words only; a URL link it wrote stays", () => {
    expect(drawn(chat(), "[run it](file:///tmp/go.command), [the page](/tmp/a.html), [docs](https://x.y/d)").text)
      .toBe("run it, the page, [docs](https://x.y/d)");
  });

  test("a fenced code block isn't linked", () => {
    const v = drawn(chat(), "Run:\n\n```\nopen https://x.y/a\n```");
    expect(views.map((x) => x.text).join("")).not.toContain("](https://x.y/a)");
    expect(v).toBeDefined();
  });

  test("another machine's agent: the same", () => {
    expect(drawn(chat("mini"), "At `/tmp/a/index.html`, docs https://x.y/z").text).toBe("At `/tmp/a/index.html`, docs [https://x.y/z](https://x.y/z)");
  });

  test("find's bold marks words, never a link's target", () => {
    const c = chat();
    c.finding = true;
    c.findBox = { value: () => "example" };
    expect(drawn(c, "at https://example.com/a").text).toBe("at [https://**example**.com/a](https://example.com/a)");
  });
});
