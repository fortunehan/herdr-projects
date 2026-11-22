// SHEP-98: the picture viewer's Copy, Open and Show in folder (mods/chat-image) did nothing in the window, opened from
// an artifact or a chat: act() checked the file with fs.stat, which the window's "fs/promises" doesn't have (its names
// are WINDOW_FS below, as herdr-app's gpui-kit.d.ts declares them). The TypeError rejected act()'s spawned task, which
// the window drops without a word. Bun's fs has stat, so the mod is run here on a stand-in with only the window's names.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, dispatch, fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

/** What the window's "fs/promises" has (herdr-app's gpui-kit.d.ts). */
const WINDOW_FS = ["exists", "mkdir", "readFile", "readdir", "rmdir", "unlink", "writeFile"];

const theme = new Proxy({}, { get: () => "#000000" });
const home = mkdtempSync(join(tmpdir(), "picture-viewer-"));
const ran: [string, string[]][] = [];
const notes: any[] = [];
let given: any = {};
let homeBroken = false;
let result: (cmd: string) => Promise<unknown> = async () => ({ code: 0, stdout: "", stderr: "" });
mock.module("herdr", () => fakeHerdr({
  theme: () => theme,
  appHome: () => { if (homeBroken) throw new Error("broken"); return home; },
  props: () => given,
  window: () => ({ platform: "macos" }),
  exec: (cmd: string, args: string[]) => { ran.push([cmd, args]); return result(cmd); },
  notify: (n: unknown) => { notes.push(n); return "n1"; },
  shared: () => null,
  settings: () => ({}),
}));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase());

// The mod as the window loads it, its fs import pointed at a stand-in with only the window's names.
const ROOT = join(import.meta.dir, "..");
const mod = join(home, "mods", "chat-image");
cpSync(join(ROOT, "mods/chat-image"), mod, { recursive: true });
const main = readFileSync(join(mod, "main.js"), "utf8");
expect(main).toContain('from "fs/promises"');
writeFileSync(join(mod, "main.js"), main.replace('from "fs/promises"', 'from "./window-fs.js"'));
writeFileSync(join(mod, "window-fs.js"), [
  'import * as real from "node:fs/promises";',
  "export const exists = (p) => real.access(p).then(() => true, () => false);",
  ...WINDOW_FS.filter((n) => n !== "exists").map((n) => `export const ${n} = real.${n};`),
].join("\n"));
const { default: ImageViewer } = await import(join(mod, "main.js"));
const { MAC_COPY } = await import(join(mod, "core/image-actions.js"));

// An artifact's picture, as mods/artifacts/recipe-view.js openPicture() passes it; a chat's, as mods/chat openImages().
mkdirSync(join(home, "mods/art-x/shots"), { recursive: true });
cpSync(join(ROOT, "web/public/splash/375x812@3-dark.png"), join(home, "mods/art-x/shots/after.png"));
const ART = { rel: "mods/art-x/shots/after.png", w: 1125, h: 2436, name: "After", path: join(home, "mods/art-x/shots/after.png") };
mkdirSync(join(home, "data/chat-attach/view"), { recursive: true });
cpSync(join(ROOT, "web/public/splash/375x812@3-dark.png"), join(home, "data/chat-attach/view/a.png"));
const CHAT = { rel: "data/chat-attach/view/a.png", w: 1125, h: 2436, name: "shot.png", path: join(home, "gone/shot.png") };


let spawned: Promise<unknown>[] = [];
const failures: unknown[] = [];
const cx: any = new Proxy({
  spawn: (f: (cx: any) => Promise<unknown>) => { const p = Promise.resolve().then(() => f(cx)).catch((e) => { failures.push(e); }); spawned.push(p); },
  timer: { after: () => {} },
}, { get: (t, k) => (t as any)[k] ?? (() => {}) });

async function open(images: unknown[]) {
  given = { images, index: 0, width: 1200, height: 800, overlay: "o1" };
  const v = new ImageViewer();
  v.init({}, cx);
  built.length = 0;
  v.render(cx);
  return v;
}
async function click(v: any, id: string) {
  dispatch(byId(id)!, "on_click", cx);
  for (let i = 0; i < 5; i++) await Promise.all(spawned);
  built.length = 0;
  v.render(cx);
}
const toolbarNote = () => built.map((e: any) => e.kids).flat().find((k: unknown) => typeof k === "string" && /Copied|Couldn't/.test(k));

beforeEach(() => { ran.length = 0; notes.length = 0; failures.length = 0; spawned = []; homeBroken = false; result = async () => ({ code: 0, stdout: "", stderr: "" }); });

describe("the picture viewer's buttons run their command in the window (SHEP-98)", () => {
  test("opened from an artifact: Copy copies the file with /usr/bin/osascript, and says Copied", async () => {
    const v = await open([ART]);
    await click(v, "copy");
    expect(failures).toEqual([]);
    expect(ran).toHaveLength(1);
    const [cmd, args] = ran[0];
    expect(cmd).toBe("/usr/bin/osascript");
    expect(args.slice(0, 2)).toEqual(["-l", "JavaScript"]);
    expect(args.slice(2)).toEqual(["-e", MAC_COPY, ART.path]);
    expect(toolbarNote()).toBe("Copied");
  });

  test("opened from an artifact: Open runs /usr/bin/open on the file", async () => {
    const v = await open([ART]);
    await click(v, "open");
    expect(failures).toEqual([]);
    expect(ran).toEqual([["/usr/bin/open", [ART.path]]]);
  });

  test("opened from an artifact: Show in folder runs /usr/bin/open -R on the file", async () => {
    const v = await open([ART]);
    await click(v, "reveal");
    expect(failures).toEqual([]);
    expect(ran).toEqual([["/usr/bin/open", ["-R", ART.path]]]);
  });

  test("opened from a chat whose original is gone: Copy and Open use the viewer's own copy", async () => {
    const v = await open([CHAT]);
    await click(v, "copy");
    await click(v, "open");
    expect(failures).toEqual([]);
    expect(ran.map(([c, a]) => [c, a[a.length - 1]])).toEqual([["/usr/bin/osascript", join(home, CHAT.rel)], ["/usr/bin/open", join(home, CHAT.rel)]]);
  });

  test("a command that fails says why in a toast and on the toolbar", async () => {
    result = async () => ({ code: 1, stdout: "", stderr: "execution error: Error: not a picture macOS can read (-2700)" });
    const v = await open([ART]);
    await click(v, "copy");
    expect(notes).toEqual([{ title: "Couldn't copy the image", body: "not a picture macOS can read", level: "error" }]);
    expect(toolbarNote()).toBe("Couldn't copy the image: not a picture macOS can read");
  });

  // SHEP-104: Open failed with nothing on stderr, and the toast had no reason at all.
  test("a command that fails without a word says which program ran and its exit code", async () => {
    result = async () => ({ code: 1, stdout: "", stderr: "" });
    const v = await open([ART]);
    await click(v, "open");
    await click(v, "reveal");
    await click(v, "copy");
    expect(notes.map((n: any) => n.body)).toEqual(["open didn't open it (exit 1)", "open didn't show it (exit 1)", "osascript didn't copy it (exit 1)"]);
  });

  test("anything else that goes wrong still ends in a toast and the toolbar note, never silence", async () => {
    const v = await open([ART]);
    homeBroken = true;
    await click(v, "open");
    expect(failures).toEqual([]);
    expect(ran).toEqual([]);
    expect(notes).toEqual([{ title: "Couldn't open the image", body: "Broken.", level: "error" }]);
    expect(toolbarNote()).toBe("Couldn't open the image: Broken.");
  });
});

// Every window mod uses only what the window's fs has: a missing one throws only in the window, never in bun.
test("window mods call only the fs functions the window has (SHEP-98)", () => {
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "bin") walk(p); continue; }
      if (!e.name.endsWith(".js")) continue;
      const src = readFileSync(p, "utf8");
      if (!/import \* as fs from "fs\/promises"/.test(src)) continue;
      for (const m of src.matchAll(/\bfs\.([A-Za-z]+)\b/g)) if (!WINDOW_FS.includes(m[1])) bad.push(`${p.slice(ROOT.length + 1)}: fs.${m[1]}`);
    }
  };
  walk(join(ROOT, "mods"));
  walk(join(ROOT, "lib"));
  expect(bad).toEqual([]);
});

// SHEP-104: exec resolves a bare program on the window's PATH, and the dev Mac's puts cmux's `open` wrapper before
// /usr/bin/open. macOS programs a mod runs are absolute; a folder check uses the shell's own `[ -d ]` (macOS 26 has
// no /usr/bin/test, and a remote machine's test may live elsewhere).
const MAC_PROGRAMS = ["open", "osascript", "pbcopy", "pbpaste", "launchctl", "test"];
function barePrograms(code: string): string[] {
  const src = code.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
  const names = MAC_PROGRAMS.join("|");
  const found: string[] = [];
  // As a program with its argument list: exec("open", [p]), exec("open", args), return ["open", [p]].
  for (const m of src.matchAll(new RegExp(`["'\`](${names})["'\`]\\s*,\\s*\\[`, "g"))) found.push(`"${m[1]}", [...]`);
  for (const m of src.matchAll(new RegExp(`\\bexec\\(\\s*["'\`](${names})["'\`]\\s*,\\s*[^\\[\\s]`, "g"))) found.push(`exec("${m[1]}", ...)`);
  // Inside a shell script (sh's own `test` is a builtin, no PATH): after exec, &&, || or ; (`open` only before an
  // argument, as JS has `|| open ?`), or a macOS-only program followed by an argument.
  for (const m of src.matchAll(/(?:\bexec|&&|\|\||;)\s+(?:(open)\s+[-<>"'$/]|(osascript|pbcopy|pbpaste|launchctl)\s)/g)) found.push(`sh: ${m[1] ?? m[2]}`);
  // A script that starts with one ('open "$1"'), or a pipe into one ('cat "$1" | pbcopy').
  for (const m of src.matchAll(/(?<=["'`]\s*)(open|osascript|pbcopy|pbpaste|launchctl)\s+[-<>"'$/]/g)) found.push(`sh: ${m[1]}`);
  for (const m of src.matchAll(/(?<!\|)\|\s*(open|osascript|pbcopy|pbpaste|launchctl)\b/g)) found.push(`sh: ${m[1]}`);
  for (const m of src.matchAll(/(?<![\w/.$-])(osascript|pbcopy|pbpaste|launchctl)\s+[-<>"'$]/g)) found.push(`sh: ${m[1]}`);
  return found;
}

test("window mods run macOS programs by absolute path, never a bare name a PATH can shadow (SHEP-104)", () => {
  expect(barePrograms('exec("open", [p])')).toEqual(['"open", [...]']);
  expect(barePrograms('exec("open", args)')).toEqual(['exec("open", ...)']);
  expect(barePrograms('return ["osascript", ["-l"]]')).toEqual(['"osascript", [...]']);
  expect(barePrograms("exec('test', ['-d', p])")).toEqual(['"test", [...]']);
  expect(barePrograms('sh -c "mkdir -p x && exec osascript -l JavaScript"')).toEqual(["sh: osascript", "sh: osascript"]);
  expect(barePrograms('exec("sh", ["-c", "pbcopy < file"])')).toEqual(["sh: pbcopy", "sh: pbcopy"]);
  expect(barePrograms(`exec("sh", ["-c", 'open "$1"', "viewer", p])`)).toEqual(["sh: open"]);
  expect(barePrograms(`exec("sh", ["-c", 'cat "$1" | pbcopy', "clipboard", p])`)).toEqual(["sh: pbcopy"]);
  expect(barePrograms('"systemctl --user start x || launchctl kickstart y"')).toEqual(["sh: launchctl"]);
  expect(barePrograms('"cat f | /usr/bin/pbcopy; exec /usr/bin/osascript -e x"; // macOS (osascript): its copy')).toEqual([]);
  expect(barePrograms('exec("/usr/bin/open", [p]); this.btn("open", "external-link")')).toEqual([]);
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".last") walk(p); continue; }
      if (!e.name.endsWith(".js") || e.name.endsWith(".test.js")) continue;
      for (const f of barePrograms(readFileSync(p, "utf8"))) bad.push(`${p.slice(ROOT.length + 1)}: ${f}`);
    }
  };
  walk(join(ROOT, "mods"));
  walk(join(ROOT, "lib"));
  expect(bad).toEqual([]);
});
