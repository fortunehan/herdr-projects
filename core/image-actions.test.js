import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as actions from "./image-actions.js";
import { MAC_COPY, command, failed, problem, target } from "./image-actions.js";

const HOME = "/h/.config/herdr-app";
const GONE = "/h/.local/share/shepherdr/worktrees/docs/task-1/diagrams/a.png";
const IMG = { rel: "data/chat-attach/view/123-a.png", w: 10, h: 10, name: "a.png", path: GONE };
const OWN = `${HOME}/${IMG.rel}`;
const only = (...paths) => async (p) => paths.includes(p);

describe("target", () => {
  test("the original file while it's there", async () => {
    expect(await target(IMG, HOME, only(GONE, OWN))).toEqual({ path: GONE, gone: false });
  });

  test("the viewer's own copy once the original is gone (a removed worktree)", async () => {
    expect(await target(IMG, HOME, only(OWN))).toEqual({ path: OWN, gone: true });
  });

  test("no file at all", async () => {
    expect(await target(IMG, HOME, only())).toEqual({ path: null, gone: true });
  });

  test("an image with no original path uses its copy, and isn't gone", async () => {
    expect(await target({ ...IMG, path: undefined }, HOME, only(OWN))).toEqual({ path: OWN, gone: false });
  });

  test("no image", async () => {
    expect(await target(undefined, HOME, only())).toBe(null);
  });
});

describe("command", () => {
  test("macOS copies any format through NSImage, as PNG (not raw bytes as «class PNGf»)", () => {
    for (const p of ["/x/a.png", "/x/a.jpg", "/x/a.gif", "/x/a.webp", "/x/a.heic"]) {
      const [cmd, args] = command("copy", "macos", p);
      expect(cmd).toBe("osascript");
      expect(args).toEqual(["-l", "JavaScript", "-e", MAC_COPY, p]);
    }
    expect(MAC_COPY).not.toContain("PNGf");
    expect(MAC_COPY).toContain("initWithContentsOfFile");
    expect(MAC_COPY).toContain("NSPasteboardTypePNG");
  });

  test("a path with quotes is an argument, never spliced into the script", () => {
    const p = '/x/say "hi".png';
    expect(command("copy", "macos", p)[1].at(-1)).toBe(p);
    expect(MAC_COPY).not.toContain(p);
  });

  test("Linux copies with the file's own type", () => {
    const [cmd, args] = command("copy", "linux", "/x/a.jpg");
    expect(cmd).toBe("sh");
    expect(args[1]).toContain("--mime-type");
    expect(args.at(-1)).toBe("/x/a.jpg");
  });

  test("open and reveal per system", () => {
    expect(command("open", "macos", "/x/a.png")).toEqual(["open", ["/x/a.png"]]);
    expect(command("reveal", "macos", "/x/a.png")).toEqual(["open", ["-R", "/x/a.png"]]);
    expect(command("open", "windows", "C:\\a.png")).toEqual(["cmd", ["/c", "start", "", "C:\\a.png"]]);
    expect(command("reveal", "windows", "C:\\a.png")).toEqual(["explorer", ["/select,C:\\a.png"]]);
    expect(command("open", "linux", "/x/a.png")).toEqual(["xdg-open", ["/x/a.png"]]);
    expect(command("reveal", "linux", "/x/a.png")[1].at(-1)).toBe("/x/a.png");
  });
});

describe("failed", () => {
  test("a non-zero exit is a failure (open -R on a gone file exits 1)", () => {
    expect(failed("reveal", "macos", { code: 1, stdout: "", stderr: "The file /x/a.png does not exist." })).toBe(true);
    expect(failed("open", "macos", { code: 0, stdout: "", stderr: "" })).toBe(false);
  });

  test("a command that couldn't start is a failure", () => {
    expect(failed("copy", "linux", null)).toBe(true);
  });

  test("explorer exits 1 even when it worked", () => {
    expect(failed("reveal", "windows", { code: 1, stdout: "", stderr: "" })).toBe(false);
  });
});

describe("problem", () => {
  test("reveal on a gone original says its folder is gone", () => {
    expect(problem("reveal", { path: OWN, gone: true }, undefined)).toEqual({ title: "Couldn't show the image in its folder", body: "Its folder is gone (a finished task's worktree is removed)." });
  });

  test("no file at all", () => {
    expect(problem("copy", { path: null, gone: true }, undefined).body).toBe("The file is gone.");
  });

  test("osascript's error in plain words", () => {
    const r = { code: 1, stdout: "", stderr: "execution error: Error: Error: not a picture macOS can read (-2700)\n" };
    expect(problem("copy", { path: "/x/a.txt", gone: false }, r)).toEqual({ title: "Couldn't copy the image", body: "not a picture macOS can read" });
  });

  test("a command that isn't installed", () => {
    expect(problem("copy", { path: "/x/a.png", gone: false }, null).body).toBe("The command it needs isn't installed.");
  });
});

// The viewer's act() and say() (mods/chat-image/main.js), run with stubs for herdr and the view.
function viewer({ files, os = "macos", run = () => ({ code: 0, stdout: "", stderr: "" }) }) {
  const text = readFileSync(join(import.meta.dir, "../mods/chat-image/main.js"), "utf8");
  const body = text.slice(text.indexOf("  act(action, cx) {"), text.indexOf("  // ---- input")).replace(/\n  }\n/g, "\n  },\n");
  const seen = { execs: [], toasts: [] };
  const fs = { stat: async (p) => { if (!files.includes(p)) throw new Error("ENOENT"); return {}; } };
  const exec = async (cmd, args) => { seen.execs.push([cmd, ...args]); return run(cmd, args); };
  const toast = (n) => seen.toasts.push(n);
  const v = new Function("target", "command", "failed", "problem", "fs", "exec", "appHome", "win", "toast", `return { ${body} };`)(
    actions.target, actions.command, actions.failed, actions.problem, fs, exec, () => HOME, () => ({ platform: os }), toast);
  v.img = () => IMG;
  let task;
  const cx = { spawn: (fn) => { task = fn(cx); }, notify: () => {}, timer: { after: () => {} } };
  return { seen, view: v, act: async (a) => { v.act(a, cx); await task; } };
}

describe("the viewer's buttons", () => {
  test("show in folder on a removed worktree's picture: says so, runs nothing", async () => {
    const w = viewer({ files: [OWN] });
    await w.act("reveal");
    expect(w.seen.execs).toEqual([]);
    expect(w.seen.toasts).toEqual([{ title: "Couldn't show the image in its folder", body: "Its folder is gone (a finished task's worktree is removed).", level: "error" }]);
    expect(w.view.note.error).toBe(true);
  });

  test("copy and open use the viewer's own copy once the original is gone", async () => {
    const w = viewer({ files: [OWN] });
    await w.act("copy");
    await w.act("open");
    expect(w.seen.execs.map((e) => e.at(-1))).toEqual([OWN, OWN]);
    expect(w.seen.toasts).toEqual([]);
    expect(w.view.note).toEqual({ text: "Copied", error: false });
  });

  test("a command that exits non-zero is a toast, not silence", async () => {
    const w = viewer({ files: [GONE, OWN], run: () => ({ code: 1, stdout: "", stderr: "The file does not exist." }) });
    await w.act("reveal");
    expect(w.seen.execs).toEqual([["open", "-R", GONE]]);
    expect(w.seen.toasts[0]).toEqual({ title: "Couldn't show the image in its folder", body: "The file does not exist.", level: "error" });
  });
});

// For real on macOS, on a named pasteboard of its own (the person's clipboard is never touched).
describe.skipIf(process.platform !== "darwin")("MAC_COPY on macOS", () => {
  const dir = mkdtempSync(join(tmpdir(), "shep-copy-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const READ = `ObjC.import("AppKit");
function run(argv) {
  const pb = $.NSPasteboard.pasteboardWithName(argv[0]);
  const d = pb.dataForType($.NSPasteboardTypePNG);
  const out = d && !d.isNil() ? $.NSBitmapImageRep.imageRepWithData(d) : null;
  pb.releaseGlobally;
  return out ? out.pixelsWide + "x" + out.pixelsHigh : "none";
}`;
  const osa = (script, ...args) => spawnSync("osascript", ["-l", "JavaScript", "-e", script, ...args], { encoding: "utf8" });
  // A 3×2 PNG, made into the other formats by sips.
  const png = join(dir, "a.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGM4YWQEQQxwFgBJ6AcJzlK6WQAAAABJRU5ErkJggg==", "base64"));
  for (const f of ["jpeg", "gif", "tiff", "heic"]) spawnSync("sips", ["-s", "format", f, png, "--out", join(dir, `a.${f}`)]);

  for (const f of ["png", "jpeg", "gif", "tiff", "heic"]) {
    test(`a ${f.toUpperCase()} lands as a PNG`, () => {
      const name = `shepherdr-test-${Math.random().toString(36).slice(2)}`;
      const w = osa(MAC_COPY, join(dir, `a.${f}`), name);
      expect(w.status).toBe(0);
      expect(osa(READ, name).stdout.trim()).toBe("3x2");
    });
  }

  test("a gone file fails with a word", () => {
    const w = osa(MAC_COPY, join(dir, "gone.png"), `shepherdr-test-${Math.random().toString(36).slice(2)}`);
    expect(w.status).not.toBe(0);
    expect(problem("copy", { path: join(dir, "gone.png"), gone: false }, { code: w.status, stdout: "", stderr: w.stderr }).body).toBe("not a picture macOS can read");
  });
});
