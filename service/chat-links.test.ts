// SHEP-99: the window's chat draws an agent's paths and URLs as links (core/chat-links.js). The agent row is built as
// the window builds it, with gpui and herdr as stand-ins that keep the markdown it was given. SHEP-109: the row carries
// no link handler (rows are drawn by the virtual list, which takes none: one there blanked every chat); TextView
// opens a link itself, a URL in the browser and a file:// path with the system's opener.
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

describe("the window's chat: paths and links in an agent's reply (SHEP-99)", () => {
  beforeEach(() => { ran = []; });

  test("the person's example: the path in inline code is a link, the sentence around it as it was", () => {
    const v = drawn(chat(), EXAMPLE);
    expect(v.text).toBe("三个方案的 HTML 预览做好了，在 [`/tmp/sds18-mock/index.html`](file:///tmp/sds18-mock/index.html)，可以直接在浏览器打开。");
  });

  test("the row carries no link handler: TextView opens the link itself (SHEP-109)", () => {
    expect(drawn(chat(), EXAMPLE).click).toBeUndefined();
    expect(drawn(chat(), "See https://example.com/docs").click).toBeUndefined();
    expect(ran).toEqual([]);
  });

  test("a URL, and a path a viewer opens, are links; ~/ is this machine's home", () => {
    expect(drawn(chat(), "See https://example.com/docs。").text).toBe("See [https://example.com/docs](https://example.com/docs)。");
    expect(drawn(chat(), "Proof at ~/proof/shot.png and `/tmp/r.pdf`").text)
      .toBe("Proof at [\\~/proof/shot.png](file:///h/me/proof/shot.png) and [`/tmp/r.pdf`](file:///tmp/r.pdf)");
  });

  // SHEP-109 review: the system's opener runs what it's given, so nothing a click could launch or run is a link
  test("a folder, a source file, an app or a script stays words, also when the agent linked it", () => {
    expect(drawn(chat(), "Changed ~/dev/shop/src/app.ts:12 and /h/me/dev/shop/ in /Applications/Preview.app").text)
      .toBe("Changed ~/dev/shop/src/app.ts:12 and /h/me/dev/shop/ in /Applications/Preview.app");
    expect(drawn(chat(), "[run it](file:///tmp/go.command) and [the page](/tmp/a.html)").text)
      .toBe("run it and [the page](file:///tmp/a.html)");
    expect(drawn(chat(), "[app][a]\n\n[a]: /Applications/Preview.app").text).toBe("[app][a]\n\n\\[a]: /Applications/Preview.app");
    expect(drawn(chat(), "<file:///tmp/go.sh>").text).toBe("\\<file:///tmp/go.sh\\>");
  });

  test("a fenced code block isn't linked", () => {
    const v = drawn(chat(), "Run:\n\n```\nopen /tmp/a/b.html\n```");
    expect(views.map((x) => x.text).join("")).not.toContain("file://");
    expect(v).toBeDefined();
  });

  test("another machine's agent: URLs are links, its paths stay plain", () => {
    const v = drawn(chat("mini"), "At `/tmp/a/index.html`, docs https://x.y/z");
    expect(v.text).toBe("At `/tmp/a/index.html`, docs [https://x.y/z](https://x.y/z)");
  });

  test("another machine's agent: a file link it wrote never opens this machine's file of that name (SHEP-109)", () => {
    const c = chat("mini");
    expect(drawn(c, "[report][r]\n\n[r]: file:///tmp/report.txt").text).toBe("[report][r]\n\n\\[r]: file:///tmp/report.txt");
    expect(drawn(c, "[report](file:///tmp/report.txt) <file:///tmp/report.txt>").text).toBe("report \\<file:///tmp/report.txt\\>");
  });

  test("find's bold marks words, never a link's target", () => {
    const c = chat();
    c.finding = true;
    c.findBox = { value: () => "tmp" };
    const v = drawn(c, "at /tmp/a/b.html");
    expect(v.text).toBe("at [/**tmp**/a/b.html](file:///tmp/a/b.html)");
  });
});
