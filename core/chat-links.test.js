// SHEP-99: paths and links in an agent's reply are clickable (core/chat-links.js).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as L from "./chat-links.js";
import { marked } from "marked";

const HOME = "/h/me";
const md = (s, o = {}) => L.linkify(s, { home: HOME, ...o });

describe("finding links in a reply", () => {
  test("a path in inline code in a Chinese sentence (the person's example)", () => {
    expect(md("三个方案的 HTML 预览做好了，在 `/tmp/sds18-mock/index.html`，可以直接在浏览器打开。"))
      .toBe("三个方案的 HTML 预览做好了，在 [`/tmp/sds18-mock/index.html`](file:///tmp/sds18-mock/index.html)，可以直接在浏览器打开。");
  });

  test("full-width punctuation and CJK text end a plain path", () => {
    for (const end of ["，", "。", "）", "：", "；", "！", "」", "”", "、"]) {
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
    const [f] = L.find("at /h/me/src/a.ts:12:3, then");
    expect(f).toMatchObject({ text: "/h/me/src/a.ts:12:3", path: "/h/me/src/a.ts", line: 12, col: 3 });
    expect(L.find("~/x/y.py:7。")[0]).toMatchObject({ text: "~/x/y.py:7", path: "~/x/y.py", line: 7, col: null });
    expect(md("at `/h/me/src/a.ts:12`")).toBe("at [`/h/me/src/a.ts:12`](file:///h/me/src/a.ts)");
  });

  test("home paths and file URLs", () => {
    expect(md("in ~/dev/shop/README.md")).toBe("in [\\~/dev/shop/README.md](file:///h/me/dev/shop/README.md)");
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
    expect(md("[the page](/tmp/a/b.html) and [code](~/x/a.ts:3)")).toBe("[the page](file:///tmp/a/b.html) and [code](file:///h/me/x/a.ts)");
    expect(md("[the page](/tmp/a/b.html)", { paths: false })).toBe("the page");
  });

  test("inline code holding only a path takes it whole: spaces, CJK, the top folders", () => {
    expect(md("`/tmp/My Report/index.html`")).toBe("[`/tmp/My Report/index.html`](file:///tmp/My%20Report/index.html)");
    expect(md("`/tmp/中文/index.html`")).toBe("[`/tmp/中文/index.html`](file:///tmp/%E4%B8%AD%E6%96%87/index.html)");
    expect(md("`/tmp` and `~/`")).toBe("[`/tmp`](file:///tmp) and [`~/`](file:///h/me)");
    // a slash command or a command line isn't a path
    expect(md("`/model` and `/usr/bin/open -R x` and `/bin/ls -la`")).toBe("`/model` and `/usr/bin/open -R x` and `/bin/ls -la`");
  });

  test("a file URL's parts are decoded once, its #fragment dropped", () => {
    expect(L.find("file:///tmp/a%23b.html")[0].path).toBe("/tmp/a#b.html");
    expect(md("Open file:///tmp/build.html#preview.")).toBe("Open [file:///tmp/build.html#preview](file:///tmp/build.html).");
  });

  test("round 2: odd input never throws, IPv6 hosts keep their brackets, references stay whole", () => {
    expect(md("`/tmp/a\u2028b.html` and `/tmp/a\rb`")).toBe("`/tmp/a\u2028b.html` and `/tmp/a\rb`");
    expect(md("https://[::1]:5173/site")).toBe("[https://\\[::1\\]:5173/site](https://[::1]:5173/site)");
    expect(md("[site]: https://example.org/\n\nSee [site].")).toBe("[site]: https://example.org/\n\nSee [site].");
    // a plain path cut where Chinese text goes on would point at its folder: left plain
    expect(md("在/tmp/中文/index.html里")).toBe("在/tmp/中文/index.html里");
  });

  test("round 3: a path running into Chinese text is ambiguous, left plain", () => {
    expect(L.find("在/tmp/a/b.html里好")).toEqual([]);
    expect(L.find("在/tmp/demo中文/index.html。")).toEqual([]);
  });

  test("round 3: a fence belongs to its quote; references and //host links stay as written", () => {
    // a quoted ``` inside a top-level block doesn't close it
    expect(md("```\n> ```\n/tmp/a/b.txt\n```")).toBe("```\n> ```\n/tmp/a/b.txt\n```");
    // a fence left open in a quote ends with the quote
    expect(md("> ```\n> x\n\nsee /tmp/a/b.pdf")).toBe("> ```\n> x\n\nsee [/tmp/a/b.pdf](file:///tmp/a/b.pdf)");
    expect(md("[site]:\n    https://example.org/\n\n> [q]: https://x.y/z")).toBe("[site]:\n    https://example.org/\n\n> [q]: https://x.y/z");
    expect(md("[Docs](//example.org/guide)")).toBe("[Docs](//example.org/guide)");
  });

  test("round 3: half an emoji (a fold's cut) leaves the path plain instead of throwing", () => {
    expect(() => md("`/tmp/preview-\ud83d`")).not.toThrow();
    expect(md("`/tmp/preview-\ud83d`")).toBe("`/tmp/preview-\ud83d`");
  });

  test("round 4: a list marker never closes a fence; quoted references; %20 in a path link; //host clicks", () => {
    expect(md("```\n- ```\n/tmp/a/b.txt\n```")).toBe("```\n- ```\n/tmp/a/b.txt\n```");
    expect(md("> [docs]:\n>   https://example.org/guide")).toBe("> [docs]:\n>   https://example.org/guide");
    expect(md("[Report](/tmp/My%20Report.html)")).toBe("[Report](file:///tmp/My%20Report.html)");
    expect(L.fromHref("//example.org/guide", HOME)).toEqual({ kind: "url", url: "https://example.org/guide" });
  });

  test("round 5: a list item's fence ends with the item; quoted references without a space; %3A in a name", () => {
    const nested = "- ```\n  first\n- ````\n  ```\n  /tmp/a/in.txt\n  ````";
    expect(md(nested)).toBe(nested);
    expect(md("- ```\n  x\n\nthen /tmp/c/d.pdf")).toBe("- ```\n  x\n\nthen [/tmp/c/d.pdf](file:///tmp/c/d.pdf)");
    expect(md("> [docs]:\n>https://example.org/guide\n>\n> [docs]")).toBe("> [docs]:\n>https://example.org/guide\n>\n> [docs]");
    // words under a bare "[docs]:" are words, not its destination
    expect(md("> [docs]:\n> See /tmp/a/b.txt")).toBe("> [docs]:\n> See [/tmp/a/b.txt](file:///tmp/a/b.txt)");
    expect(md("[Report](/tmp/Report%3A12:34)")).toBe("[Report](file:///tmp/Report:12)");
  });

  test("a fence in a quoted list is code too", () => {
    expect(md("> - ```sh\n>   cat /tmp/a/b.txt\n> - ```")).toBe("> - ```sh\n>   cat /tmp/a/b.txt\n> - ```");
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

// The renderer is the judge of where code is: every code block marked finds reads the same after linkify (Copy copies it).
test("code blocks read the same to marked after linkify", () => {
  const codes = (md) => { const out = []; marked.walkTokens(marked.lexer(md), (t) => { if (t.type === "code") out.push(t.text); }); return out; };
  const samples = [
    "- ```\n  first\n- ````\n  ```\n  /tmp/a/in.txt\n  ````",
    "```\n- ```\n/tmp/a/b.txt\n```",
    "```\n> ```\n/tmp/a/b.txt\n```",
    "> ```\n> /tmp/a/b\n\nsee /tmp/a/b.pdf",
    "> - ```sh\n>   cat /tmp/a/b.txt\n> - ```",
    "- Example\n\n    ~~~sh\n    cat /tmp/a/b.txt\n    ~~~",
    "Run:\n\n    open /tmp/a/b.html\n\nthen /tmp/c/d.pdf",
    "1. step\n   ```\n   /tmp/x/y.html\n   ```\n2. /tmp/z/w.pdf",
    "> > ```\n> > /tmp/q/r.txt\n> > ```\n> /tmp/s/t.txt",
    "````\n```\n/tmp/a/b\n```\n````",
    "  ~~~sh\ncat /tmp/a/b.txt\n  ~~~",
    "   ```\n/tmp/a/b.txt\n```\nafter /tmp/c/d.pdf",
  ];
  for (const s of samples) expect(codes(md(s))).toEqual(codes(s));
});

// A reference the agent defined still leads where it did.
test("reference definitions resolve the same to marked after linkify", () => {
  const hrefs = (md) => { const out = []; marked.walkTokens(marked.lexer(md), (t) => { if (t.type === "link") out.push(t.href); }); return out; };
  const samples = [
    "[docs]:\n  https://example.org/guide \"Open the guide\n  in a browser\"\n\n[docs]",
    "> [docs]:\n>https://example.org/guide\n>\n> [docs]",
    "[site]:\n    https://example.org/\n\nSee [site].",
    "# Build results\n[report]: https://example.org/build\n\nRead [report]",
    "---\n[report]: https://example.org/build\n\nRead [report]",
    "```\nx\n```\n[report]: https://example.org/build\n\nRead [report]",
  ];
  for (const s of samples) expect(hrefs(md(s))).toEqual(hrefs(s));
  // "[x]:" right after a sentence is words: the path under it is still a link
  expect(md("Build complete.\n[Preview]:\n/tmp/a/b.html")).toBe("Build complete.\n[Preview]:\n[/tmp/a/b.html](file:///tmp/a/b.html)");
});

test("round 9: a reference link the agent wrote keeps its words and where they lead", () => {
  const s = "Open [`/tmp/build/report.html`][report].\n\n[report]: https://example.org/build";
  expect(md(s)).toBe(s);
  expect(md("See [`/tmp/a/b.html`][] and [report].\n\n[report]: https://x.y/z\n[`/tmp/a/b.html`]: https://x.y/b")).toBe("See [`/tmp/a/b.html`][] and [report].\n\n[report]: https://x.y/z\n[`/tmp/a/b.html`]: https://x.y/b");
  expect(md("Open [`/tmp/build/report.html`].\n\n[`/tmp/build/report.html`]: https://example.org/build")).toBe("Open [`/tmp/build/report.html`].\n\n[`/tmp/build/report.html`]: https://example.org/build");
  // brackets that aren't a link still get their paths linked
  expect(md("[see /tmp/a/b.pdf]")).toBe("[see [/tmp/a/b.pdf](file:///tmp/a/b.pdf)]");
});

test("round 10: brackets that aren't a defined reference stay text (a URL's query, an index in code)", () => {
  expect(md("See https://example.org/search?filter[status]=active.")).toBe("See [https://example.org/search?filter\\[status\\]=active](https://example.org/search?filter%5Bstatus%5D=active).");
  expect(md('Example [run `cp "${files[0]}" /tmp/backup.txt`].')).toBe('Example [run `cp "${files[0]}" /tmp/backup.txt`].');
  // a defined name is still a reference, also when its words wrap
  const s = "Open [`/tmp/reports/preview.html`\n][preview].\n\n[preview]: /tmp/reports/final.html";
  expect(md(s)).toBe(s);
});

describe("a clicked link's target", () => {
  test("URLs, file URLs and paths", () => {
    expect(L.fromHref("https://x.y/z?q=1", HOME)).toEqual({ kind: "url", url: "https://x.y/z?q=1" });
    expect(L.fromHref("file:///tmp/a%20b/c.svg", HOME)).toEqual({ kind: "path", path: "/tmp/a b/c.svg" });
    expect(L.fromHref("file://localhost/tmp/x", HOME)).toEqual({ kind: "path", path: "/tmp/x" });
    expect(L.fromHref("/tmp/a/b.ts:12", HOME)).toEqual({ kind: "path", path: "/tmp/a/b.ts" });
    expect(L.fromHref("~/a", HOME)).toEqual({ kind: "path", path: "/h/me/a" });
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
  test("macOS's programs run by absolute path", () => {
    expect(L.OPEN).toContain("exec /usr/bin/open -R");
    expect(L.OPEN).toContain("$(/usr/bin/osascript ");
    expect(L.OPEN).not.toMatch(/exec open |\$\(osascript /);
  });
  fake("open", `printf 'open %s\\n' "$*" >> "${log}"`);
  fake("osascript", "echo '/Applications/Firefox.app'");
  // the script runs macOS's programs by absolute path (SHEP-104): here they are the stand-ins
  const cmd = (action, p, guard) => {
    const [prog, args] = L.command(action, "macos", p, guard);
    return [prog, args.map((a) => a.replaceAll("/usr/bin/open", join(bin, "open")).replaceAll("/usr/bin/osascript", join(bin, "osascript")))];
  };
  const run = (action, p, guard = false) => {
    writeFileSync(log, "");
    const [prog, args] = cmd(action, p, guard);
    const r = spawnSync(prog, args, { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } });
    return { code: r.status, ran: readFileSync(log, "utf8").trim() };
  };

  test("a page opens in the default browser's app, not the file type's", () => {
    expect(run("browser", "~/site/index.html")).toEqual({ code: 0, ran: `open -a /Applications/Firefox.app ${home}/site/index.html` });
  }, 30000); // the first real sh spawn can be slow on a busy Mac
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
    expect(run("reveal", "/tmp/../etc", true)).toEqual({ code: 5, ran: "" });
    expect(run("reveal", "/tmp/..", true)).toEqual({ code: 5, ran: "" });
    expect(run("reveal", "/tmp", true).code).toBe(0);
  });
  test("the guard refuses everything outside /tmp when the home folder can't be found", () => {
    writeFileSync(log, "");
    const [prog, args] = cmd("reveal", "/etc/hosts", true);
    expect(spawnSync(prog, args, { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "no-such-home") } }).status).toBe(5);
  });
  test("a link that looks like a page but leads to a source file is shown in Finder", () => {
    writeFileSync(join(home, "site", "notes.md"), "");
    symlinkSync(join(home, "site", "notes.md"), join(home, "preview.html"));
    const real = spawnSync("/bin/sh", ["-c", 'cd "$1" && pwd -P', "x", join(home, "site")]).stdout.toString().trim();
    expect(run("browser", `${home}/preview.html`, true)).toEqual({ code: 0, ran: `open -R ${real}/notes.md` });
  });
  test("a link without an extension that leads to a page opens in the browser", () => {
    symlinkSync(join(home, "site", "index.html"), join(home, "preview"));
    const real = spawnSync("/bin/sh", ["-c", 'cd "$1" && pwd -P', "x", join(home, "site")]).stdout.toString().trim();
    expect(run("reveal", `${home}/preview`, true)).toEqual({ code: 0, ran: `open -a /Applications/Firefox.app ${real}/index.html` });
  });
  test("the guard follows a link to where it leads, and opens that", () => {
    symlinkSync("/etc/hosts", join(home, "site", "hosts.txt"));
    expect(run("browser", `${home}/site/hosts.txt`, true)).toEqual({ code: 5, ran: "" });
    symlinkSync(join(home, "site", "index.html"), join(home, "link.html"));
    const real = spawnSync("/bin/sh", ["-c", 'cd "$1" && pwd -P', "x", join(home, "site")]).stdout.toString().trim();
    expect(run("browser", `${home}/link.html`, true)).toEqual({ code: 0, ran: `open -a /Applications/Firefox.app ${real}/index.html` });
  });
});

// SHEP-108: the window's QuickJS compiles a pattern copy on every matchAll; linking a reply that way took 5-20 ms, and
// a frame of rows passed the window's ~50 ms render limit, blanking every chat. The shape that broke it: a Chinese
// report with many inline code spans and a table (the Assistant's SHEP-86 reply).
describe("linking stays cheap where regexps aren't cached (SHEP-108)", () => {
  const REPORT = [
    "SHEP-86 的调研报告已经发布（artifact `shep-86-eta-artifacts-sh-04cc`，第 3 版）。要点如下：",
    "",
    "**结论**",
    "- eta 的 artifact 本身**不如**我们的 recipe：放在沙箱 iframe 里显示。",
    "  - 命令显示成\"终端 + 退出码\"，改动显示成着色的 diff。",
    "",
    "| # | 做什么 | 为什么 | 大小 |",
    "|---|---|---|---|",
    "| 1 | herdr-task 加一个 `send-back` 命令 | 见 `/tmp/a/b.html` | M |",
    "| 2 | 每个版本一个 `answers.json` | 换设备看不到 | M |",
    "| 3 | 新增 `check` 块，`code` 块支持 `diff` 着色 | https://example.com/x | S |",
    "",
    "<hc suggest=\"三个都开\"/>",
  ].join("\n");

  test("no matchAll, and at most one pattern compiled per reply", () => {
    const realMatchAll = String.prototype.matchAll, RealRegExp = globalThis.RegExp;
    let built = 0;
    String.prototype.matchAll = () => { throw new Error("matchAll compiles a copy of the pattern on each call"); };
    globalThis.RegExp = new Proxy(RealRegExp, { construct(T, args) { built++; return new T(...args); } });
    let out;
    try { out = md(REPORT); } finally { String.prototype.matchAll = realMatchAll; globalThis.RegExp = RealRegExp; }
    expect(built).toBeLessThanOrEqual(1);
    expect(out).toContain("[`/tmp/a/b.html`](file:///tmp/a/b.html)");
    expect(out).toContain("[https://example.com/x](https://example.com/x)");
    expect(out).toContain("`send-back`");
  });

  test("the shared patterns are reused safely: the same reply links the same way twice", () => {
    expect(md(REPORT)).toBe(md(REPORT));
    expect(L.find("a /tmp/x/y b /tmp/z/w").map((x) => x.path)).toEqual(["/tmp/x/y", "/tmp/z/w"]);
  });
});
