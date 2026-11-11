import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPEN, TITLE, cantOpen, command, folderOf, problem } from "./open-editor.js";

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

describe("cantOpen", () => {
  test("a task on this machine with a folder can open", () => {
    expect(cantOpen(WORKTREE)).toBe(null);
    expect(cantOpen(HERE)).toBe(null);
  });

  test("another machine's task says where it runs", () => {
    expect(cantOpen({ ...WORKTREE, machine: "vm-demo" })).toEqual({ title: TITLE, body: "This task runs on vm-demo: VS Code opens only this machine's folders." });
  });

  test("no worktree yet, or no record", () => {
    expect(cantOpen({ ...WORKTREE, worktree: null }).body).toContain("no worktree yet");
    expect(cantOpen(null).body).toBe("The task isn't read yet.");
  });
});

describe("problem", () => {
  test("none when it opened", () => expect(problem({ code: 0, stdout: "", stderr: "" }, false)).toBe(null));
  test("a removed worktree", () => {
    expect(problem({ code: 3, stdout: "", stderr: "" }, true).body).toBe("Its folder is gone (a finished task's worktree is removed).");
    expect(problem({ code: 3, stdout: "", stderr: "" }, false).body).toBe("Its folder is gone.");
  });
  test("no VS Code", () => expect(problem({ code: 4, stdout: "", stderr: "" }, false).body).toContain("VS Code isn't installed"));
  test("sh couldn't start", () => expect(problem(null, false)).toEqual({ title: TITLE, body: "sh couldn't start." }));
  test("anything else: its last line", () => expect(problem({ code: 1, stdout: "", stderr: "a\nboom\n" }, false).body).toBe("boom"));
});

// The real script, with stand-ins for code, open and uname first on PATH (never the real VS Code).
describe("the script", () => {
  const dir = mkdtempSync(join(tmpdir(), "shep-vscode-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, "wt");
  mkdirSync(folder);
  let n = 0;
  const run = (fakes, target = folder) => {
    const bin = join(dir, `bin${n++}`), log = join(bin, "log");
    mkdirSync(bin);
    for (const [name, code] of Object.entries({ uname: 'echo Darwin', open: "exit 1", ...fakes })) {
      if (code === null) continue;
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${code}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const [cmd, args] = command(target);
    const r = spawnSync(cmd, args, { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
    return { code: r.status, log: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.startsWith("uname")) : [] };
  };

  test("the code CLI when it's on PATH", () => {
    expect(run({ code: "exit 0" })).toEqual({ code: 0, log: [`code ${folder}`] });
  });

  test("no code CLI: macOS's Visual Studio Code app", () => {
    expect(run({ open: "exit 0" })).toEqual({ code: 0, log: [`open -a Visual Studio Code ${folder}`] });
  });

  test("the code CLI failing falls back to the app", () => {
    expect(run({ code: "exit 1", open: "exit 0" }).log).toEqual([`code ${folder}`, `open -a Visual Studio Code ${folder}`]);
  });

  test("neither: exit 4", () => {
    expect(run({}).code).toBe(4);
    expect(run({ uname: "echo Linux" }).code).toBe(4);
  });

  test("a removed folder: exit 3, nothing started", () => {
    expect(run({ code: "exit 0" }, join(dir, "gone"))).toEqual({ code: 3, log: [] });
  });

  test("it's sh, run with the folder as $1", () => {
    expect(command("/a b")).toEqual(["sh", ["-c", OPEN, "open-vscode", "/a b"]]);
  });
});
