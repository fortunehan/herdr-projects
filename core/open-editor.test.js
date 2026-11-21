import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPS, COPIES, DEFAULT_TERMINAL, cantOpen, copyOf, folderOf, openCommands, openFolder, title } from "./open-editor.js";

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
  const stub = (results = {}) => {
    const calls = [];
    const exec = async (cmd, args, opts) => { calls.push([cmd, ...args]); expect(opts.timeout).toBeGreaterThan(0); return results[cmd] ?? { code: 0, stdout: "", stderr: "" }; };
    return { calls, exec };
  };

  test("each app opens by its bundle id after the folder check, no lookup script", async () => {
    for (const [app, bundle] of [["vscode", "com.microsoft.VSCode"], ["iterm", "com.googlecode.iterm2"], ["finder", "com.apple.finder"], ["xcode", "com.apple.dt.Xcode"]]) {
      const s = stub();
      expect(await openFolder(s.exec, app, WT)).toBe(null);
      expect(s.calls).toEqual([["/bin/test", "-d", WT], ["/usr/bin/open", "-b", bundle, "--", WT]]);
      expect(openCommands(app, WT)).toEqual(s.calls);
    }
  });

  test("Terminal: the default terminal's app, looked up with the fixed script", async () => {
    const s = stub({ "/usr/bin/osascript": { code: 0, stdout: "/Applications/Ghostty.app\n", stderr: "" } });
    expect(await openFolder(s.exec, "terminal", WT)).toBe(null);
    expect(s.calls).toEqual([["/bin/test", "-d", WT], ["/usr/bin/osascript", "-l", "JavaScript", "-e", DEFAULT_TERMINAL], ["/usr/bin/open", "-a", "/Applications/Ghostty.app", "--", WT]]);
  });

  test("Terminal: a failed lookup opens Terminal.app instead", async () => {
    const s = stub({ "/usr/bin/osascript": { code: 1, stdout: "", stderr: "execution error: (-2700)" } });
    expect(await openFolder(s.exec, "terminal", WT)).toBe(null);
    expect(s.calls.at(-1)).toEqual(["/usr/bin/open", "-a", "Terminal", "--", WT]);
  });

  test("a gone folder runs nothing else", async () => {
    const s = stub({ "/bin/test": { code: 1, stdout: "", stderr: "" } });
    expect(await openFolder(s.exec, "finder", WT, { done: true })).toEqual({ title: "Couldn't open Finder", body: `Its folder is gone (a finished task's worktree is removed): ${WT}` });
    expect((await openFolder(stub({ "/bin/test": { code: 1, stdout: "", stderr: "" } }).exec, "finder", WT)).body).toBe(`The folder is missing or can't be read: ${WT}`);
    expect(s.calls).toEqual([["/bin/test", "-d", WT]]);
  });

  test("a failure names the step, the command (quoted for a shell) and the last stderr line", async () => {
    const s = stub({ "/usr/bin/open": { code: 1, stdout: "", stderr: "noise\nboom\n" } });
    expect(await openFolder(s.exec, "vscode", "/a b/it's")).toEqual({ title: "Couldn't open VS Code", body: "Opening VS Code failed: boom (open -b com.microsoft.VSCode -- '/a b/it'\\''s')" });
  });

  test("exec rejecting is a step failure too, never a bare failed", async () => {
    const exec = async () => { throw new Error(""); };
    expect((await openFolder(exec, "xcode", WT)).body).toBe(`Checking the folder failed: /bin/test couldn't run: no reason given (test -d ${WT})`);
  });

  test("off macOS only VS Code opens, with its code command", async () => {
    const s = stub();
    expect(await openFolder(s.exec, "vscode", WT, { platform: "linux" })).toBe(null);
    expect(s.calls).toEqual([["code", WT]]);
    expect(await openFolder(s.exec, "xcode", WT, { platform: "linux" })).toEqual({ title: "Couldn't open Xcode", body: "Xcode opens only on macOS." });
  });

  test("title", () => {
    expect(title("terminal")).toBe("Couldn't open Terminal");
    expect(title("xcode")).toBe("Couldn't open Xcode");
  });
});

// The real programs on this Mac, without starting any app: the lookup script, and open -b's answer for an app
// that isn't there.
describe.if(process.platform === "darwin")("on macOS for real", () => {
  const real = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  // SHEP-97's cause: /usr/bin/test isn't on macOS 26, so herdr's exec refused to start the folder check.
  test("every program an Open runs is on this Mac", () => {
    for (const app of ["terminal", ...Object.keys(APPS)]) {
      for (const [cmd] of openCommands(app, "/tmp")) expect(existsSync(cmd)).toBe(true);
    }
  });

  test("the folder check runs for real: a folder passes, a missing one is said", async () => {
    const exec = async (cmd, args) => (cmd === "/usr/bin/open" ? { code: 0, stdout: "", stderr: "" } : real(cmd, args));
    expect(await openFolder(exec, "vscode", tmpdir())).toBe(null);
    expect((await openFolder(exec, "vscode", join(tmpdir(), "shep97-gone"))).body).toBe(`The folder is missing or can't be read: ${join(tmpdir(), "shep97-gone")}`);
  });

  test("the default-terminal lookup prints an app's path", () => {
    const r = real("/usr/bin/osascript", ["-l", "JavaScript", "-e", DEFAULT_TERMINAL]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\/.+\.app$/);
  });

  test("open -b with an unknown bundle id says the app isn't installed", async () => {
    const exec = async (cmd, args) => real(cmd, cmd === "/usr/bin/open" ? ["-b", "com.example.shep97-none", ...args.slice(2)] : args);
    const p = await openFolder(exec, "xcode", tmpdir());
    expect(p.body).toStartWith("Xcode isn't installed: macOS has no app with the bundle id com.apple.dt.Xcode.");
  });
});
