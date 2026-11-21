import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPS, COPIES, cantOpen, copyOf, folderOf, openCommand, openFolder, title } from "./open-editor.js";

const WT = "/h/.local/share/shepherdr/worktrees/shop/task-3-x";
const WORKTREE = { mode: "worktree", worktree: WT, folder: "/h/dev/shop", machine: null, state: "running" };
const HERE = { mode: "here", folder: "/h/dev/shop", machine: null, state: "running" };

describe("folderOf", () => {
  test("a worktree task opens its worktree, a --here task its list's folder", () => {
    expect(folderOf(WORKTREE)).toBe(WT);
    expect(folderOf(HERE)).toBe("/h/dev/shop");
  });

  test("a worktree task not started yet has none (never its list's folder instead)", () => {
    expect(folderOf({ ...WORKTREE, worktree: undefined })).toBe(null);
    expect(folderOf(null)).toBe(null);
  });

  test("an old record without a mode: its worktree when it has one", () => {
    expect(folderOf({ worktree: WT, folder: "/h/dev/shop" })).toBe(WT);
    expect(folderOf({ folder: "/h/dev/shop" })).toBe("/h/dev/shop");
  });
});

describe("APPS", () => {
  test("VS Code, iTerm2, Finder, Xcode, in that order", () => {
    expect(Object.keys(APPS)).toEqual(["vscode", "iterm", "finder", "xcode"]);
    expect(Object.values(APPS).map((a) => a.name)).toEqual(["VS Code", "iTerm2", "Finder", "Xcode"]);
  });

  test("each icon is in mods/chat", () => {
    for (const a of [...Object.values(APPS), ...Object.values(COPIES)]) expect(existsSync(join(import.meta.dir, "..", "mods", "chat", a.icon))).toBe(true);
  });
});

describe("copyOf", () => {
  test("Copy path: the task's folder, a worktree or a --here task's list folder", () => {
    expect(copyOf("path", WORKTREE, "x")).toEqual({ text: WT });
    expect(copyOf("path", HERE, null)).toEqual({ text: "/h/dev/shop" });
  });

  test("Copy path on another machine's task: its folder there (copying needs no local folder)", () => {
    expect(copyOf("path", { ...WORKTREE, machine: "vm-demo" }, "vm-demo/w3")).toEqual({ text: WT });
  });

  test("Copy path with no record or no worktree yet says why", () => {
    expect(copyOf("path", null, null)).toEqual({ problem: "The task isn't read yet." });
    expect(copyOf("path", { ...WORKTREE, worktree: null }, null).problem).toContain("no worktree yet");
  });

  test("Copy panel ID: the worker's terminal address, its machine's prefix included; none running says so", () => {
    expect(copyOf("id", WORKTREE, "vm-demo/w3")).toEqual({ text: "vm-demo/w3" });
    expect(copyOf("id", WORKTREE, null)).toEqual({ problem: "No live terminal is available for this task." });
  });

  test("the Assistant header's words", () => {
    expect(COPIES.path).toMatchObject({ name: "Copy path", done: "Full path copied" });
    expect(COPIES.id).toMatchObject({ name: "Copy panel ID", done: "Panel ID copied" });
  });
});

describe("cantOpen", () => {
  test("a task on this machine with a folder can open", () => {
    for (const app of Object.keys(APPS)) {
      expect(cantOpen(WORKTREE, app)).toBe(null);
      expect(cantOpen(HERE, app)).toBe(null);
    }
  });

  test("another machine's task says where it runs", () => {
    expect(cantOpen({ ...WORKTREE, machine: "vm-demo" }, "vscode")).toEqual({ title: "Couldn't open VS Code", body: "This task runs on vm-demo: VS Code opens only this machine's folders." });
    expect(cantOpen({ ...WORKTREE, machine: "vm-demo" }, "iterm")).toEqual({ title: "Couldn't open iTerm2", body: "This task runs on vm-demo: iTerm2 opens only this machine's folders." });
    expect(cantOpen({ ...WORKTREE, machine: "vm-demo" }, "finder")).toEqual({ title: "Couldn't open Finder", body: "This task runs on vm-demo: Finder opens only this machine's folders." });
  });

  test("no worktree yet, or no record", () => {
    expect(cantOpen({ ...WORKTREE, worktree: null }, "iterm").body).toContain("no worktree yet");
    expect(cantOpen(null, "finder").body).toBe("The task isn't read yet.");
  });
});

describe("openFolder", () => {
  const stub = (result = { code: 0, stdout: "", stderr: "" }) => {
    const calls = [];
    const exec = async (cmd, args, opts) => { calls.push([cmd, ...args]); expect(opts.timeout).toBeGreaterThan(0); return result; };
    return { calls, exec };
  };

  test("one open per app: VS Code, Finder and Xcode by bundle id, iTerm2 by name", async () => {
    for (const [app, find] of [["vscode", ["-b", "com.microsoft.VSCode"]], ["iterm", ["-a", "iTerm"]], ["finder", ["-b", "com.apple.finder"]], ["xcode", ["-b", "com.apple.dt.Xcode"]]]) {
      const s = stub();
      expect(await openFolder(s.exec, app, WT)).toBe(null);
      expect(s.calls).toEqual([["/usr/bin/open", ...find, "--", WT]]);
      expect(openCommand(app, WT)).toEqual(["/usr/bin/open", [...find, "--", WT]]);
    }
  });

  test("a gone folder, as open says it", async () => {
    const gone = { code: 1, stdout: "", stderr: `The file ${WT} does not exist.` };
    expect(await openFolder(stub(gone).exec, "finder", WT, { done: true })).toEqual({ title: "Couldn't open Finder", body: `Its folder is gone (a finished task's worktree is removed): ${WT}` });
    expect((await openFolder(stub(gone).exec, "finder", WT)).body).toBe(`The folder is missing: ${WT}`);
  });

  test("an app that isn't there", async () => {
    expect((await openFolder(stub({ code: 1, stdout: "", stderr: "Unable to find application named 'iTerm'" }).exec, "iterm", WT)).body).toBe(`iTerm2 isn't installed. (open -a iTerm -- ${WT})`);
    expect((await openFolder(stub({ code: 1, stdout: "", stderr: "LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application with bundle identifier com.apple.dt.Xcode." }).exec, "xcode", WT)).body).toBe(`Xcode isn't installed. (open -b com.apple.dt.Xcode -- ${WT})`);
  });

  test("anything else: the last stderr line and the command, quoted for a shell", async () => {
    const s = stub({ code: 1, stdout: "", stderr: "noise\nboom\n" });
    expect(await openFolder(s.exec, "vscode", "/a b/it's")).toEqual({ title: "Couldn't open VS Code", body: "Opening VS Code failed: boom (open -b com.microsoft.VSCode -- '/a b/it'\\''s')" });
  });

  test("exec rejecting says so, never a bare failed", async () => {
    const exec = async () => { throw new Error(""); };
    expect((await openFolder(exec, "xcode", WT)).body).toBe(`/usr/bin/open couldn't run: no reason given (open -b com.apple.dt.Xcode -- ${WT})`);
  });

  test("off macOS only VS Code opens, with its code command", async () => {
    const s = stub();
    expect(await openFolder(s.exec, "vscode", WT, { platform: "linux" })).toBe(null);
    expect(s.calls).toEqual([["code", WT]]);
    expect(await openFolder(s.exec, "xcode", WT, { platform: "linux" })).toEqual({ title: "Couldn't open Xcode", body: "Xcode opens only on macOS." });
  });

  test("title", () => expect(title("iterm")).toBe("Couldn't open iTerm2"));
});

// The real open on this Mac, without starting any app: a missing folder, and an app that isn't there.
describe.if(process.platform === "darwin")("on macOS for real", () => {
  const real = async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  // SHEP-97's cause: the old folder check ran /usr/bin/test, which macOS 26 doesn't have.
  test("the program every Open runs is on this Mac", () => {
    for (const app of Object.keys(APPS)) expect(existsSync(openCommand(app, "/tmp")[0])).toBe(true);
  });

  test("a missing folder is said in plain words, before any app starts", async () => {
    for (const app of Object.keys(APPS)) {
      const gone = join(tmpdir(), "shep97-gone");
      expect((await openFolder(real, app, gone)).body).toBe(`The folder is missing: ${gone}`);
    }
  });

  test("an app that isn't installed says so", async () => {
    const exec = (cmd, args) => real(cmd, ["-a", "Shep97 No Such App", ...args.slice(2)]);
    expect((await openFolder(exec, "iterm", tmpdir())).body).toStartWith("iTerm2 isn't installed.");
  });
});
