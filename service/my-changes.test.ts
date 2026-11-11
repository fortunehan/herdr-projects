// The Changes side panel (mods/my-changes) follows the task open in the Tasks panel (SHEP-21), against real git repos.
// No window runs here: gpui and herdr are stand-ins, herdr's exec runs git for real. The decision itself is
// core/changes-follow.test.js; this checks the mod reads what it decided, writes nothing under .git and keeps only the
// newest task's result when tasks are switched fast.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const el = (): any => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : k === "when" ? (c: unknown, f: any) => (c ? f(el()) : el()) : () => el()) });
const shared = new Map<string, unknown>();
let tasksActive = "tasks-list";
let spaceFolder = "/nonexistent";
const tree = () => ({ id: "root", children: [{ id: "panel-body", active: "changes", children: [{ id: "changes" },
  { id: "tasks", active: tasksActive, children: [{ id: "tasks-list" }, { id: "tasks-thread" }] }] }] });

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString();
};
const exec = async (cmd: string, args: string[], { cwd }: { cwd: string }) => {
  const p = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};
const herdr = {
  spaces: () => [{ id: "s1", active: true, machine: null, folder: spaceFolder, tabs: [] }], panes: () => [], focused: () => null,
  exec, readTextFile: async (p: string) => await Bun.file(p).text(), watchFolder: async () => { throw new Error("no folder watch here"); },
  theme: () => new Proxy({}, { get: () => "#000000" }), settings: () => ({}),
  shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => { shared.set(k, v); }, layout: tree,
};
mock.module("herdr", () => fakeHerdr(herdr));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: el }));
const input = () => ({ on: () => {}, value: () => "", set_value: () => {} });
mock.module("gpui-base", () => fakeGpuiBase({
  v_flex: el, h_flex: el, Input: { new: el }, InputState: { new: input }, Scrollbar: { vertical: el }, v_virtual_list: el,
}));
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };

const { default: Changes } = await import("../mods/my-changes/main.js");

let jobs: Promise<unknown>[] = [];
const cx: any = { spawn: (f: any) => { jobs.push(f(cx)); }, notify: () => {}, focus_handle: () => ({ focus: () => {} }), timer: { every: () => {} } };
// Runs refreshes until none is pending and the panel shows what its key names now.
async function settle(view: any) {
  for (let i = 0; i < 20; i++) {
    const now = jobs; jobs = [];
    await Promise.all(now);
    if (view.key() !== view.context) view.refresh(cx);
    if (!jobs.length && !view.loading) return;
  }
}

let top: string, repo: string, wt: string;
const where = (over = {}) => ({ terminal: "t2p", ref: "SHEP-21", folder: wt, machine: null, repo, branch: "task/21", base: "main", start: null, pr: null, ...over });
const openTask = (thread: object, w: object | null) => { tasksActive = "tasks-thread"; shared.set("tasks.thread", thread); shared.set("tasks.thread.where", w); };
// Every file under a .git folder with its size and mtime: a read must change none of them.
function gitState(dir: string) {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n), s = statSync(p); if (s.isDirectory()) walk(p); else out[p] = `${s.size}:${s.mtimeMs}`; } };
  walk(dir);
  return out;
}

beforeAll(() => {
  top = mkdtempSync(join(tmpdir(), "my-changes-"));
  repo = join(top, "repo"); wt = join(top, "wt");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com"); git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n"); writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-q", "-b", "task/21", wt);
  writeFileSync(join(wt, "a.txt"), "one\ntwo\n");
  git(wt, "commit", "-qam", "task work");
  writeFileSync(join(wt, "b.txt"), "b changed\n");
  writeFileSync(join(wt, "fresh.txt"), "new\n");
  spaceFolder = repo;
});
afterAll(() => rmSync(top, { recursive: true, force: true }));

describe("my-changes follows the open task", () => {
  test("the space first, in the person's mode; a task: its worktree in Base against its base, labelled", async () => {
    store.set("my-changes.target", JSON.stringify({ mode: "uncommitted", ref: "" }));
    const v: any = new Changes(); v.init({}, cx); await settle(v);
    expect(v.follow.follow).toBe(false);
    expect(v.root).toBe(Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: repo }).stdout.toString().trim());
    expect(v.files).toEqual([]);

    const before = gitState(join(repo, ".git"));
    openTask({ terminal: "t2p", task: "SHEP-21" }, where());
    await settle(v);
    expect(v.mode).toBe("base");
    expect(v.follow.task).toBe("SHEP-21");
    expect(v.against.label).toBe("main");
    expect(v.files.map((f: any) => `${f.status} ${f.path}`)).toEqual(["M a.txt", "M b.txt", "A fresh.txt"]);
    expect(v.quiet).toBe(null);
    expect(gitState(join(repo, ".git"))).toEqual(before);

    // back to the list: the space's folder and Uncommitted again, the saved mode untouched
    tasksActive = "tasks-list";
    await settle(v);
    expect(v.follow.follow).toBe(false);
    expect(v.mode).toBe("uncommitted");
    expect(JSON.parse(store.get("my-changes.target")!).mode).toBe("uncommitted");
    expect(v.files).toEqual([]);
  });

  test("tasks opened fast: only the last one's changes show", async () => {
    const other = join(top, "other");
    mkdirSync(other); git(other, "init", "-q", "-b", "main");
    git(other, "config", "user.email", "t@example.com"); git(other, "config", "user.name", "t");
    writeFileSync(join(other, "z.txt"), "z\n"); git(other, "add", "-A"); git(other, "commit", "-qm", "z");
    writeFileSync(join(other, "z.txt"), "zz\n");
    const v: any = new Changes(); v.init({}, cx);
    openTask({ terminal: "t2p", task: "SHEP-21" }, where());
    v.refresh(cx);
    // the person opens SHEP-22 while SHEP-21's read runs
    openTask({ terminal: "t9", task: "SHEP-22" }, { terminal: "t9", ref: "SHEP-22", folder: other, machine: null, repo: other, branch: null, base: "main" });
    await settle(v);
    expect(v.follow.task).toBe("SHEP-22");
    expect(v.files.map((f: any) => f.path)).toEqual(["z.txt"]);
  });

  test("a finished task whose worktree is gone: its branch against its base, quietly; no branch: a quiet line", async () => {
    const v: any = new Changes(); v.init({}, cx);
    git(repo, "worktree", "remove", "--force", wt);
    openTask({ terminal: "t2p", task: "SHEP-21" }, where());
    await settle(v);
    expect(v.error).toBe(null);
    expect(v.quiet).toBe("SHEP-21's worktree is gone: its branch task/21 against its base");
    expect(v.files.map((f: any) => `${f.status} ${f.path}`)).toEqual(["M a.txt"]);
    expect(v.against.tip).toBe("task/21");

    git(repo, "branch", "-q", "-D", "task/21");
    shared.set("tasks.thread.where", where({ ref: "SHEP-21" }));
    v.context = null; await settle(v);
    expect(v.error).toBe(null);
    expect(v.quiet).toBe("SHEP-21's worktree is gone");
    expect(v.files).toEqual([]);
  });
});
