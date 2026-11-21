// SHEP-99: paths and links in an agent's reply are clickable (core/chat-links.js).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as L from "./chat-links.js";

const HOME = "/Users/me";
const md = (s, o = {}) => L.linkify(s, { home: HOME, ...o });

describe("finding links in a reply", () => {
  test("a path in inline code in a Chinese sentence (the person's example)", () => {
    expect(md("三个方案的 HTML 预览做好了，在 `/tmp/sds18-mock/index.html`，可以直接在浏览器打开。"))
      .toBe("三个方案的 HTML 预览做好了，在 [`/tmp/sds18-mock/index.html`](file:///tmp/sds18-mock/index.html)，可以直接在浏览器打开。");
  });

  test("full-width punctuation and CJK text end a plain path", () => {
    for (const end of ["，", "。", "）", "：", "；", "！", "」", "”", "、", "里"]) {
      const f = L.find(`在/tmp/a/b.html${end}好`);
      expect(f.map((x) => x.text)).toEqual(["/tmp/a/b.html"]);
    }
    expect(L.find("（见 ~/dev/x/）").map((x) => x.path)).toEqual(["~/dev/x/"]);
  });

  test("ASCII punctuation after a path or URL is the sentence's", () => {
    expect(L.find("See /tmp/a/b.pdf.").map((x) => x.path)).toEqual(["/tmp/a/b.pdf"]);
    expect(L.find('Open "/tmp/a/b.svg", then (/tmp/c/d.png)!').map((x) => x.path)).toEqual(["/tmp/a/b.svg", "/tmp/c/d.png"]);
    expect(L.find("Docs: https://example.com/x.").map((x) => x.url)).toEqual(["https://example.com/x"]);
    expect(L.find("(see https://example.com/y)").map((x) => x.url)).toEqual(["https://example.com/y"]);
    expect(L.find("https://en.wikipedia.org/wiki/A_(b), ok").map((x) => x.url)).toEqual(["https://en.wikipedia.org/wiki/A_(b)"]);
    // a URL keeps its CJK path and [] query; full-width punctuation still ends it
    expect(L.find("网址 https://example.com/中文，好").map((x) => x.url)).toEqual(["https://example.com/中文"]);
    expect(L.find("见 https://example.com/?tag[]=a。").map((x) => x.url)).toEqual(["https://example.com/?tag[]=a"]);
    expect(L.find("[see https://x.y/z]").map((x) => x.url)).toEqual(["https://x.y/z"]);
  });

  test("a line and column suffix is kept in the words, not the target", () => {
    const [f] = L.find("at /Users/me/src/a.ts:12:3, then");
    expect(f).toMatchObject({ text: "/Users/me/src/a.ts:12:3", path: "/Users/me/src/a.ts", line: 12, col: 3 });
    expect(L.find("~/x/y.py:7。")[0]).toMatchObject({ text: "~/x/y.py:7", path: "~/x/y.py", line: 7, col: null });
    expect(md("at `/Users/me/src/a.ts:12`")).toBe("at [`/Users/me/src/a.ts:12`](file:///Users/me/src/a.ts)");
  });

  test("home paths and file URLs", () => {
    expect(md("in ~/dev/shop/README.md")).toBe("in [\\~/dev/shop/README.md](file:///Users/me/dev/shop/README.md)");
    expect(L.find("file:///tmp/a%20b/c.svg")[0].path).toBe("/tmp/a b/c.svg");
    expect(md("file:///tmp/a%20b/c.svg")).toBe("[file:///tmp/a%20b/c.svg](file:///tmp/a%20b/c.svg)");
  });

  test("what isn't a path stays plain", () => {
    for (const s of ["run /model now", "and/or", "1/2/3", "a/b/c", "~/", "http://", "src/a.ts", "x.com/a/b"]) expect(L.find(s)).toEqual([]);
  });

  test("fenced code blocks are left as they are, inline code only when it is the path alone", () => {
    const s = "Built:\n```sh\nopen /tmp/a/b.html\n```\nthen `ls /tmp/x/y` and /tmp/c/d.pdf";
    expect(md(s)).toBe("Built:\n```sh\nopen /tmp/a/b.html\n```\nthen `ls /tmp/x/y` and [/tmp/c/d.pdf](file:///tmp/c/d.pdf)");
    expect(md("~~~\n/tmp/a/b\n~~~")).toBe("~~~\n/tmp/a/b\n~~~");
    // an unclosed fence runs to the end
    expect(md("```\n/tmp/a/b")).toBe("```\n/tmp/a/b");
  });

  test("URL links the agent wrote, pictures and HTML stay whole", () => {
    expect(md("[docs](https://x.y/z) and <https://x.y/z> and ![p](/tmp/p/q.png)")).toBe("[docs](https://x.y/z) and <https://x.y/z> and ![p](/tmp/p/q.png)");
  });

  test("a path link the agent wrote opens the same way; where paths aren't links, just its words", () => {
    expect(md("[the page](/tmp/a/b.html) and [code](~/x/a.ts:3)")).toBe("[the page](file:///tmp/a/b.html) and [code](file:///Users/me/x/a.ts)");
    expect(md("[the page](/tmp/a/b.html)", { paths: false })).toBe("the page");
  });

  test("inline code holding only a path takes it whole: spaces, CJK, the top folders", () => {
    expect(md("`/tmp/My Report/index.html`")).toBe("[`/tmp/My Report/index.html`](file:///tmp/My%20Report/index.html)");
    expect(md("`/tmp/中文/index.html`")).toBe("[`/tmp/中文/index.html`](file:///tmp/%E4%B8%AD%E6%96%87/index.html)");
    expect(md("`/tmp` and `~/`")).toBe("[`/tmp`](file:///tmp) and [`~/`](file:///Users/me)");
    // a slash command or a command line isn't a path
    expect(md("`/model` and `/usr/bin/open -R x` and `/bin/ls -la`")).toBe("`/model` and `/usr/bin/open -R x` and `/bin/ls -la`");
  });

  test("a file URL's parts are decoded once, its #fragment dropped", () => {
    expect(L.find("file:///tmp/a%23b.html")[0].path).toBe("/tmp/a#b.html");
    expect(md("Open file:///tmp/build.html#preview.")).toBe("Open [file:///tmp/build.html#preview](file:///tmp/build.html).");
  });

  test("code in a quote or a list, and indented code, is left as it is", () => {
    expect(md("> ~~~sh\n> cat /tmp/a/b.txt\n> ~~~")).toBe("> ~~~sh\n> cat /tmp/a/b.txt\n> ~~~");
    expect(md("- Example\n\n    ~~~sh\n    cat /tmp/a/b.txt\n    ~~~")).toBe("- Example\n\n    ~~~sh\n    cat /tmp/a/b.txt\n    ~~~");
    expect(md("Run:\n\n    open /tmp/a/b.html\n\nthen /tmp/c/d.pdf")).toBe("Run:\n\n    open /tmp/a/b.html\n\nthen [/tmp/c/d.pdf](file:///tmp/c/d.pdf)");
  });

  test("URLs: link words escaped, brackets in the target encoded", () => {
    expect(md("see https://example.com/a_(b) now")).toBe("see [https://example.com/a\\_(b)](https://example.com/a_%28b%29) now");
    expect(md("**https://x.y/z**")).toBe("**[https://x.y/z](https://x.y/z)**");
  });

  test("another machine's agent, or a phone: URLs only", () => {
    expect(md("at /tmp/a/b.html or https://x.y/z", { paths: false })).toBe("at /tmp/a/b.html or [https://x.y/z](https://x.y/z)");
    expect(L.linkify("~/a/b", { home: null })).toBe("~/a/b");
  });

  test("the web app's own targets: ~/ kept for the agent's machine", () => {
    const pathHref = (p) => `#path=${encodeURIComponent(p)}`;
    expect(L.linkify("see ~/a/b.html", { home: "~", pathHref })).toBe("see [\\~/a/b.html](#path=~%2Fa%2Fb.html)");
  });
});

describe("a clicked link's target", () => {
  test("URLs, file URLs and paths", () => {
    expect(L.fromHref("https://x.y/z?q=1", HOME)).toEqual({ kind: "url", url: "https://x.y/z?q=1" });
    expect(L.fromHref("file:///tmp/a%20b/c.svg", HOME)).toEqual({ kind: "path", path: "/tmp/a b/c.svg" });
    expect(L.fromHref("file://localhost/tmp/x", HOME)).toEqual({ kind: "path", path: "/tmp/x" });
    expect(L.fromHref("/tmp/a/b.ts:12", HOME)).toEqual({ kind: "path", path: "/tmp/a/b.ts" });
    expect(L.fromHref("~/a", HOME)).toEqual({ kind: "path", path: "/Users/me/a" });
    expect(L.fromHref("~/a", null)).toBe(null);
    expect(L.fromHref("javascript:alert(1)", HOME)).toBe(null);
    expect(L.fromHref("mailto:a@b.c", HOME)).toBe(null);
    expect(L.fromHref("src/a.ts", HOME)).toBe(null);
  });
});

describe("what a click does", () => {
  test("pages, pictures, PDFs, text and JSON go to the browser; the rest to Finder", () => {
    for (const p of ["/a/x.html", "/a/x.HTM", "/a/x.svg", "/a/x.pdf", "/a/x.png", "/a/x.jpg", "/a/x.jpeg", "/a/x.gif", "/a/x.webp", "/a/x.txt", "/a/x.json"])
      expect(L.actionOf(p)).toBe("browser");
    for (const p of ["/a/x.md", "/a/x.ts", "/a/folder", "/a/folder/", "/a/x.html/", "/a/Makefile"]) expect(L.actionOf(p)).toBe("reveal");
  });

  test("the hover words", () => {
    expect(L.label("url", "macos")).toBe("Open in browser");
    expect(L.label("browser", "linux")).toBe("Open in browser");
    expect(L.label("reveal", "macos")).toBe("Show in Finder");
    expect(L.label("reveal", "windows")).toBe("Show in folder");
    expect(L.label("reveal", "linux")).toBe("Show in folder");
  });

  test("Windows: explorer opens it or shows it, never cmd (it would read & in the path)", () => {
    expect(L.command("browser", "windows", "C:/a&calc/b.html")).toEqual(["explorer", ["C:/a&calc/b.html"]]);
    expect(L.command("reveal", "windows", "C:/a/b.ts")).toEqual(["explorer", ["/select,C:/a/b.ts"]]);
    // explorer exits 1 even when it worked
    expect(L.problem("reveal", "windows", "C:/a", { code: 1 })).toBe(null);
    expect(L.problem("browser", "windows", "C:/a.html", { code: 1 })).toBe(null);
  });

  test("failures in plain words", () => {
    expect(L.problem("browser", "macos", "/tmp/x.html", { code: 3 })).toEqual({ title: "Couldn't open it in the browser", body: "/tmp/x.html isn't there." });
    expect(L.problem("reveal", "macos", "/x", { code: 5 }).body).toBe("Only paths in your home folder or /tmp open from here.");
    expect(L.problem("reveal", "linux", "/x", null).title).toBe("Couldn't show it in its folder");
    expect(L.problem("reveal", "macos", "/x", { code: 0 })).toBe(null);
  });
});

// The opener script itself, with uname, open and osascript as logging stand-ins first on PATH.
describe("the opener script", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-links-"));
  const bin = join(root, "bin"), home = join(root, "home"), log = join(root, "log");
  mkdirSync(bin); mkdirSync(join(home, "site"), { recursive: true });
  mkdirSync(join(home, "Evil.app", "Contents"), { recursive: true }); mkdirSync(join(home, "page.html"));
  writeFileSync(join(home, "site", "index.html"), "<p>hi</p>");
  writeFileSync(join(home, "site", "main.ts"), "");
  const fake = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake("uname", "echo Darwin");
  fake("open", `printf 'open %s\\n' "$*" >> "${log}"`);
  fake("osascript", "echo '/Applications/Firefox.app'");
  const run = (action, p, guard = false) => {
    writeFileSync(log, "");
    const [prog, args] = L.command(action, "macos", p, guard);
    const r = spawnSync(prog, args, { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } });
    return { code: r.status, ran: readFileSync(log, "utf8").trim() };
  };

  test("a page opens in the default browser's app, not the file type's", () => {
    expect(run("browser", "~/site/index.html")).toEqual({ code: 0, ran: `open -a /Applications/Firefox.app ${home}/site/index.html` });
  });
  test("a source file is revealed in Finder, a folder opened there", () => {
    expect(run("reveal", `${home}/site/main.ts`)).toEqual({ code: 0, ran: `open -R ${home}/site/main.ts` });
    expect(run("reveal", `${home}/site`)).toEqual({ code: 0, ran: `open ${home}/site` });
  });
  test("an app (a folder with an extension) is only shown in Finder, never run", () => {
    expect(run("reveal", `${home}/Evil.app`)).toEqual({ code: 0, ran: `open -R ${home}/Evil.app` });
    expect(run("browser", `${home}/page.html/`)).toEqual({ code: 0, ran: `open -R ${home}/page.html/` });
  });
  test("a missing path runs nothing and exits 3", () => {
    expect(run("browser", `${home}/site/gone.html`)).toEqual({ code: 3, ran: "" });
  });
  test("the service's guard: the home folder and /tmp only, after .. and links are resolved", () => {
    expect(run("reveal", `${home}/site/main.ts`, true).code).toBe(0);
    expect(run("reveal", "/etc/hosts", true)).toEqual({ code: 5, ran: "" });
    expect(run("reveal", `${home}/..`, true)).toEqual({ code: 5, ran: "" });
    expect(run("reveal", "/tmp/..", true)).toEqual({ code: 5, ran: "" });
    expect(run("reveal", "/tmp", true).code).toBe(0);
  });
  test("the guard follows a link to where it leads, and opens that", () => {
    symlinkSync("/etc/hosts", join(home, "site", "hosts.txt"));
    expect(run("browser", `${home}/site/hosts.txt`, true)).toEqual({ code: 5, ran: "" });
    symlinkSync(join(home, "site", "index.html"), join(home, "link.html"));
    const real = spawnSync("/bin/sh", ["-c", 'cd "$1" && pwd -P', "x", join(home, "site")]).stdout.toString().trim();
    expect(run("browser", `${home}/link.html`, true)).toEqual({ code: 0, ran: `open -a /Applications/Firefox.app ${real}/index.html` });
  });
});
