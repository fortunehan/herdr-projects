import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPS, cantOpen, folderOf, openCommand as command, openProblem as problem, title } from "./open-editor.js";

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
  test("VS Code, iTerm2, Finder, in that order", () => {
    expect(Object.keys(APPS)).toEqual(["vscode", "iterm", "finder"]);
    expect(Object.values(APPS).map((a) => a.name)).toEqual(["VS Code", "iTerm2", "Finder"]);
  });

  test("each icon is in mods/chat", () => {
    for (const a of Object.values(APPS)) expect(existsSync(join(import.meta.dir, "..", "mods", "chat", a.icon))).toBe(true);
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

describe("problem", () => {
  test("none when it opened", () => expect(problem("vscode", { code: 0, stdout: "", stderr: "" }, false)).toBe(null));
  test("a removed worktree", () => {
    expect(problem("iterm", { code: 3, stdout: "", stderr: "" }, true)).toEqual({ title: "Couldn't open iTerm2", body: "Its folder is gone (a finished task's worktree is removed)." });
    expect(problem("finder", { code: 3, stdout: "", stderr: "" }, false).body).toBe("Its folder is gone.");
  });
  test("the app missing", () => {
    expect(problem("vscode", { code: 4, stdout: "", stderr: "" }, false).body).toContain("VS Code isn't installed");
    expect(problem("iterm", { code: 4, stdout: "", stderr: "" }, false).body).toBe("iTerm2 isn't installed.");
    expect(problem("finder", { code: 4, stdout: "", stderr: "" }, false).body).toBe("Finder is only on macOS.");
  });
  test("sh couldn't start", () => expect(problem("vscode", null, false)).toEqual({ title: title("vscode"), body: "sh couldn't start." }));
  test("anything else: its last line", () => expect(problem("finder", { code: 1, stdout: "", stderr: "a\nboom\n" }, false).body).toBe("boom"));
});

// The real scripts, with stand-ins for code, open and uname first on PATH (never the real apps).
describe("the scripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "shep-open-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, "w t");
  mkdirSync(folder);
  let n = 0;
  const run = (app, fakes, target = folder) => {
    const bin = join(dir, `bin${n++}`), log = join(bin, "log");
    mkdirSync(bin);
    for (const [name, code] of Object.entries({ uname: 'echo Darwin', open: "exit 1", ...fakes })) {
      if (code === null) continue;
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${code}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const [cmd, args] = command(app, target);
    const r = spawnSync(cmd, args, { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
    return { code: r.status, log: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.startsWith("uname")) : [] };
  };

  test("VS Code: the code CLI when it's on PATH", () => {
    expect(run("vscode", { code: "exit 0" })).toEqual({ code: 0, log: [`code ${folder}`] });
  });

  test("VS Code: no code CLI, macOS's Visual Studio Code app", () => {
    expect(run("vscode", { open: "exit 0" })).toEqual({ code: 0, log: [`open -a Visual Studio Code ${folder}`] });
  });

  test("VS Code: the code CLI failing falls back to the app", () => {
    expect(run("vscode", { code: "exit 1", open: "exit 0" }).log).toEqual([`code ${folder}`, `open -a Visual Studio Code ${folder}`]);
  });

  test("VS Code: neither, exit 4", () => {
    expect(run("vscode", {}).code).toBe(4);
    expect(run("vscode", { uname: "echo Linux" }).code).toBe(4);
  });

  test("iTerm2: looks the app up, then opens it on the folder", () => {
    expect(run("iterm", { open: "exit 0" })).toEqual({ code: 0, log: ["open -Ra iTerm", `open -a iTerm ${folder}`] });
  });

  test("iTerm2: not installed, exit 4 and nothing opened", () => {
    expect(run("iterm", { open: "exit 1" })).toEqual({ code: 4, log: ["open -Ra iTerm"] });
    expect(run("iterm", { open: "exit 0", uname: "echo Linux" })).toEqual({ code: 4, log: [] });
  });

  test("iTerm2: failing to start passes its exit on", () => {
    expect(run("iterm", { open: '[ "$1" = -Ra ] || { echo boom >&2; exit 1; }' }).code).toBe(1);
  });

  test("Finder: open on the folder", () => {
    expect(run("finder", { open: "exit 0" })).toEqual({ code: 0, log: [`open ${folder}`] });
    expect(run("finder", { open: "exit 0", uname: "echo Linux" })).toEqual({ code: 4, log: [] });
  });

  test("a removed folder: exit 3, nothing started", () => {
    for (const app of Object.keys(APPS)) expect(run(app, { code: "exit 0", open: "exit 0" }, join(dir, "gone"))).toEqual({ code: 3, log: [] });
  });

  test("it's sh, run with the folder as $1", () => {
    expect(command("iterm", "/a b")).toEqual(["sh", ["-c", APPS.iterm.script, "open-iterm", "/a b"]]);
  });
});
