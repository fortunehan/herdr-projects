import { describe, expect, test } from "bun:test";
import { goneLine, modeFor, target, taskKey, taskOpen, whereOf } from "./changes-follow.js";

const SPACE = { cwd: "/src/shop", on: null };
const THREAD = { terminal: "t2p", task: "SHEP-21", title: "Changes panel follows the open task",
  key: { machine: null, folder: "/src/shop", slug: "shepherdr", id: 21 } };
const WHERE = { terminal: "t2p", ref: "SHEP-21", folder: "/wt/task-21", machine: null, repo: "/src/shop",
  branch: "task/21-changes", base: "main", start: "abc1234", pr: null };

const tree = (active) => ({ id: "root", children: [{ id: "panel", hidden: true, children: [{ id: "panel-body", active: "changes",
  children: [{ id: "changes" }, { id: "tasks", active, children: [{ id: "tasks-list" }, { id: "tasks-thread" }] }] }] }] });

describe("taskOpen", () => {
  test("open while the Tasks stack shows the task, even with Changes picked or the panel hidden", () => {
    expect(taskOpen(tree("tasks-thread"))).toBe(true);
    expect(taskOpen(tree("tasks-list"))).toBe(false);
    expect(taskOpen({ id: "root", children: [] })).toBe(false);
    expect(taskOpen(null)).toBe(false);
  });
});

describe("target", () => {
  test("no task open: the space's folder, as today", () => {
    expect(target({ open: false, thread: THREAD, where: WHERE, space: SPACE })).toMatchObject({ follow: false, task: null, cwd: SPACE.cwd, on: null });
    expect(target({ open: true, thread: null, where: null, space: SPACE })).toMatchObject({ follow: false, cwd: SPACE.cwd });
  });

  test("a worktree task: its worktree, its own base, labelled with its ref", () => {
    expect(target({ open: true, thread: THREAD, where: WHERE, space: SPACE })).toEqual({ follow: true, task: "SHEP-21", terminal: "t2p",
      cwd: "/wt/task-21", on: null, base: "main", branch: "task/21-changes", repo: "/src/shop", pending: false });
  });

  test("a task working here (no worktree): its folder", () => {
    const where = { ...WHERE, folder: "/src/shop", branch: null };
    expect(target({ open: true, thread: THREAD, where, space: { cwd: "/elsewhere", on: null } })).toMatchObject({ follow: true, cwd: "/src/shop" });
  });

  test("another machine's task: read on that machine", () => {
    const thread = { ...THREAD, terminal: "mini/t5" }, where = { ...WHERE, terminal: "mini/t5", machine: "mini" };
    expect(target({ open: true, thread, where, space: SPACE })).toMatchObject({ on: "mini", cwd: "/wt/task-21" });
    // before its place is read: its machine from the terminal, nothing read yet
    expect(target({ open: true, thread, where: null, space: SPACE })).toMatchObject({ on: "mini", cwd: null, pending: true });
  });

  test("the previous task's place never shows under the next task (opening tasks fast)", () => {
    const next = { ...THREAD, terminal: "t9", task: "SHEP-22" };
    const t = target({ open: true, thread: next, where: WHERE, space: SPACE });
    expect(t).toMatchObject({ follow: true, task: "SHEP-22", cwd: null, pending: true });
    expect(target({ open: true, thread: next, where: { ...WHERE, terminal: "t9", ref: "SHEP-22", folder: "/wt/22" }, space: SPACE }))
      .toMatchObject({ task: "SHEP-22", cwd: "/wt/22", pending: false });
  });

  test("opened from news (no ref in the thread): the ref comes with its place", () => {
    const thread = { terminal: "t2p", task: null, title: "x" };
    expect(target({ open: true, thread, where: null, space: SPACE })).toMatchObject({ follow: true, task: null, pending: true });
    expect(target({ open: true, thread, where: WHERE, space: SPACE })).toMatchObject({ task: "SHEP-21", cwd: "/wt/task-21" });
  });

  test("a task never started: its list's folder; a stale place of another unstarted task is not taken", () => {
    const thread = { terminal: null, task: "SHEP-30", key: { machine: null, folder: "/src/shop", slug: "s", id: 30 } };
    expect(target({ open: true, thread, where: null, space: SPACE })).toMatchObject({ follow: true, task: "SHEP-30", cwd: "/src/shop", pending: false });
    expect(whereOf(thread, { ref: "SHEP-31", folder: "/x" })).toBe(null);
    expect(whereOf(thread, { ref: "SHEP-30", folder: "/x" })).toMatchObject({ folder: "/x" });
  });
});

describe("modeFor", () => {
  const task = target({ open: true, thread: THREAD, where: WHERE, space: SPACE });
  const space = target({ open: false, thread: THREAD, where: WHERE, space: SPACE });

  test("a task opens in Base; leaving it gives the person's own mode back", () => {
    const opened = modeFor(task, "uncommitted", { key: null, mode: null });
    expect(opened).toEqual({ mode: "base", key: taskKey(task), taskMode: "base" });
    expect(modeFor(space, "uncommitted", opened)).toEqual({ mode: "uncommitted", key: null, taskMode: null });
    expect(modeFor(space, "ref", opened).mode).toBe("ref");
  });

  test("a mode picked while the task shows stays for that task only", () => {
    const picked = { key: taskKey(task), mode: "uncommitted" };
    expect(modeFor(task, "ref", picked).mode).toBe("uncommitted");
    const other = target({ open: true, thread: { ...THREAD, terminal: "t9", task: "SHEP-22" }, where: null, space: SPACE });
    expect(modeFor(other, "ref", picked).mode).toBe("base");
  });

  test("an unknown saved mode is Uncommitted", () => {
    expect(modeFor(space, "weird", null).mode).toBe("uncommitted");
  });
});

describe("goneLine", () => {
  test("a quiet line, with the branch when it still shows", () => {
    expect(goneLine("SHEP-21", "task/21-x")).toBe("SHEP-21's worktree is gone: its branch task/21-x against its base");
    expect(goneLine("SHEP-21", null)).toBe("SHEP-21's worktree is gone");
    expect(goneLine(null, null)).toBe("This task's worktree is gone");
  });
});
