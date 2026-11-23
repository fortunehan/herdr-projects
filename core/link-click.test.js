// SHEP-117: a Ctrl/Cmd-clicked terminal path (Herdr's LinkClick), opened by core/link-click.js with SHEP-99's rules.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openClick } from "./link-click.js";

const root = mkdtempSync(join(tmpdir(), "link-click-"));
const bin = join(root, "bin"), home = join(root, "home"), log = join(root, "log");
mkdirSync(bin);
mkdirSync(join(home, "site", "assets"), { recursive: true });
mkdirSync(join(home, "Tool.app", "Contents"), { recursive: true });
for (const f of ["index.html", "old.htm", "shot.png", "photo.JPG", "spec.pdf", "notes.txt", "main.ts", "Makefile"]) {
  writeFileSync(join(home, "site", f), "");
}
const fake = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
fake("uname", "echo Darwin");
fake("open", `printf 'open %s\\n' "$*" >> "${log}"`);
fake("osascript", "echo '/Applications/Firefox.app'");

// The real opener script, its macOS programs (by absolute path, SHEP-104) swapped for the logging stand-ins.
function env(os = "macos", exists = () => true) {
  const toasts = [], runs = [];
  return {
    toasts, runs, os, exists,
    toast: (n) => toasts.push(n),
    exec: (prog, args) => {
      runs.push([prog, args]);
      const a = args.map((x) => x.replaceAll("/usr/bin/open", join(bin, "open")).replaceAll("/usr/bin/osascript", join(bin, "osascript")));
      const r = spawnSync(prog, a, { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: "utf8" });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
const local = (path, raw = path) => ({ link: { kind: "file", raw, path }, source: { terminal: "t1", machine: null, cwd: home, pane: "p1", tab: "1", space: "s1" } });
async function click(c, e = env()) {
  writeFileSync(log, "");
  const out = await openClick(c, e);
  return { out, ran: readFileSync(log, "utf8").trim(), toasts: e.toasts, runs: e.runs };
}

describe("a clicked local file", () => {
  test("pages, pictures, PDFs and text open in the default browser", async () => {
    for (const f of ["index.html", "old.htm", "shot.png", "photo.JPG", "spec.pdf", "notes.txt"]) {
      const p = join(home, "site", f);
      expect(await click(local(p))).toMatchObject({ out: "handled", ran: `open -a /Applications/Firefox.app ${p}`, toasts: [] });
    }
  }, 30000); // the first real sh spawn can be slow on a busy Mac

  test("any other file is shown in Finder", async () => {
    for (const f of ["main.ts", "Makefile"]) {
      const p = join(home, "site", f);
      expect(await click(local(p))).toMatchObject({ out: "handled", ran: `open -R ${p}`, toasts: [] });
    }
  });

  test("a folder opens", async () => {
    const p = join(home, "site", "assets");
    expect(await click(local(p))).toMatchObject({ out: "handled", ran: `open ${p}`, toasts: [] });
    expect(await click(local(`${p}/`))).toMatchObject({ out: "handled", ran: `open ${p}/` });
  });

  test("an app bundle is only shown in Finder, never run", async () => {
    const p = join(home, "Tool.app");
    expect(await click(local(p))).toMatchObject({ out: "handled", ran: `open -R ${p}`, toasts: [] });
  });

  test("a missing path runs nothing and says so in a short toast", async () => {
    const p = join(home, "site", "gone.html");
    const r = await click(local(p));
    expect(r).toMatchObject({ out: "handled", ran: "" });
    expect(r.toasts).toEqual([{ title: "Couldn't open it in the browser", body: `${p} isn't there.`, level: "error" }]);
  });

  test("on Windows a missing path is looked up first, and explorer is never started", async () => {
    const e = env("windows", () => false);
    const r = await click(local("C:/x/gone.txt"), e);
    expect(r.out).toBe("handled");
    expect(r.runs).toEqual([]);
    expect(r.toasts[0].body).toBe("C:/x/gone.txt isn't there.");
  });

  test("the path goes to the script as one argument, never as shell words", async () => {
    const e = env();
    await click(local(join(home, "site", "a;b $(x).ts")), e);
    expect(e.runs[0][0]).toBe("sh");
    expect(e.runs[0][1].slice(2)).toEqual(["open-path", "reveal", join(home, "site", "a;b $(x).ts")]);
  });
});

describe("a path that isn't on this machine", () => {
  test("a remote terminal's path gets a toast naming the machine", async () => {
    const c = { link: { kind: "file", raw: "/srv/app/log.txt", path: null }, source: { terminal: "vm/t3", machine: "vm", cwd: "/srv/app", pane: null, tab: null, space: null } };
    const r = await click(c);
    expect(r).toMatchObject({ out: "handled", runs: [] });
    expect(r.toasts).toEqual([{ title: "That path is on another machine", body: "It's on vm: open it there.", level: "info" }]);
  });

  test("a local path Herdr couldn't resolve gets a toast too", async () => {
    const r = await click(local(null, "./bits/x.txt"));
    expect(r).toMatchObject({ out: "handled", runs: [] });
    expect(r.toasts[0].title).toBe("Couldn't find that path");
  });
});

describe("URLs", () => {
  test("pass to Herdr's own opener", async () => {
    const r = await click({ link: { kind: "url", raw: "https://example.com", url: "https://example.com" }, source: { terminal: "t1", machine: null } });
    expect(r).toMatchObject({ out: "pass", runs: [], toasts: [] });
  });
});

// mods/open-paths/link.js as the window loads it: its herdr imports are stand-ins here (never mock.module("herdr")).
describe("the mod's handleLink", () => {
  const MOD = join(import.meta.dir, "..", "mods", "open-paths");
  const src = readFileSync(join(MOD, "link.js"), "utf8");
  test("declares a file rule only (URLs stay Herdr's)", () => {
    const m = JSON.parse(readFileSync(join(MOD, "mod.json"), "utf8"));
    expect(m.link_handlers.map((r) => r.kind)).toEqual(["file"]);
  });
  test("hands the click to openClick with herdr's exec, notify and platform", async () => {
    const body = src.replace(/^import .*$/gm, "").replace("export function handleLink", "return function handleLink");
    const notes = [], runs = [];
    const handleLink = new Function("exec", "notify", "window", "fs", "openClick", body)(
      async (p, a) => { runs.push([p, a]); return { code: 0 }; }, (n) => notes.push(n), () => ({ platform: "macos" }),
      { exists: async () => true }, openClick);
    expect(await handleLink({ link: { kind: "url", raw: "https://x.y", url: "https://x.y" }, source: {} })).toBe("pass");
    expect(await handleLink({ link: { kind: "file", raw: "/a/b.html", path: "/a/b.html" }, source: {} })).toBe("handled");
    expect(runs[0][1].slice(2)).toEqual(["open-path", "browser", "/a/b.html"]);
    expect(await handleLink({ link: { kind: "file", raw: "/r/x", path: null }, source: { machine: "vm" } })).toBe("handled");
    expect(notes.map((n) => n.title)).toEqual(["That path is on another machine"]);
  });
});
