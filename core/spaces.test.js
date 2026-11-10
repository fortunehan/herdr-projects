import { expect, test } from "bun:test";
import { spaceName, tilde, sharedNames, gitTail, assistantOf, isThinking, statusOf, taskInSpace, isWorkingTask, workingIn } from "./spaces.js";

test("two spaces with one name on a machine each show their folder, from ~ (the sidebar's rows, both sides)", () => {
  // built, so the repo's no-home-paths rule has nothing to find
  expect(tilde(["", "home", "u", "dev", "app"].join("/"))).toBe("~/dev/app");
  expect(tilde(["", "Users", "u"].join("/"))).toBe("~");
  expect(tilde("/srv/app")).toBe("/srv/app");
  const rows = [
    { id: "a", machine: null, name: "Home" }, { id: "b", machine: null, name: "home" }, { id: "c", machine: "vm", name: "Home" },
    { id: "d", machine: null, name: "app" }, { id: "e", machine: null, name: "app", linked: true },
  ];
  expect([...sharedNames(rows)].sort()).toEqual(["a", "b"]);
});

test("a space is called as the window's sidebar calls it, never ~", () => {
  expect(spaceName({ name: "web", folder: "/x/y" })).toBe("web");
  expect(spaceName({ name: "~", folder: "/srv/u" }, { home: "/srv/u" })).toBe("Home");
  expect(spaceName({ name: "~", folder: "/tmp/abc/tt-repo" })).toBe("tt-repo");
  expect(spaceName({ name: "~", folder: "/root/" })).toBe("Home");
  expect(spaceName({ name: "", folder: "/srv/app" }, { repo: "app-repo" })).toBe("app-repo");
  expect(spaceName({ name: "dev", folder: "/srv/app" }, { named: false, repo: "app" })).toBe("app");
});

test("after a space's name only its repo and branch where unusual, no ahead/behind counts (SHEP-32)", () => {
  expect(gitTail({ name: "herdr", branch: "spike", ahead: 2, behind: 1 }, { name: "web" })).toEqual({ where: "herdr · spike" });
  expect(gitTail({ name: "web", branch: "main" }, { name: "web" })).toEqual({ where: "" });
  expect(gitTail({ name: "herdr", branch: null }, { name: "herdr", tag: "mini" })).toEqual({ where: "mini · detached" });
});

test("a space's Assistant thinks while it is in a turn, from the window's terminals and the service's alike (SHEP-17)", () => {
  const coord = (status, extra = {}) => ({ address: "t1", state: "live", status, labels: { "herdr.role": "coordinator", "herdr.coordinator.space": "sp1" }, ...extra });
  expect(statusOf({ status: "working" })).toBe("working");
  expect(statusOf({ status: { state: "blocked" } })).toBe("blocked");
  expect(statusOf(null)).toBe(null);
  expect(isThinking(coord("working"))).toBe(true);
  expect(isThinking(coord({ state: "working" }))).toBe(true);
  for (const s of ["idle", "blocked", "done", { state: "idle" }]) expect(isThinking(coord(s))).toBe(false);
  expect(isThinking(null)).toBe(false);
  // a task worker at work is no Assistant thinking
  expect(isThinking({ status: "working", labels: { "herdr.role": "worker" } })).toBe(false);
  expect(isThinking(assistantOf({ id: "sp1", machine: null }, [coord("working")]))).toBe(true);
  expect(isThinking(assistantOf({ id: "sp2", machine: null }, [coord("working")]))).toBe(false);
});

test("a space counts its tasks at work: started there, else in its folder; never queued, ready or archived ones (SHEP-17)", () => {
  const s = { id: "vm/sp1", machine: "vm", folder: "/srv/app" };
  expect(taskInSpace({ space: "vm/sp1" }, s)).toBe(true);
  expect(taskInSpace({ space: "vm/sp2", machine: "vm", folder: "/srv/app" }, s)).toBe(false);
  expect(taskInSpace({ machine: "vm", folder: "/srv/app" }, s)).toBe(true);
  expect(taskInSpace({ machine: null, folder: "/srv/app" }, s)).toBe(false);
  expect(taskInSpace({ machine: "vm", folder: "" }, { ...s, folder: "" })).toBe(false);
  expect(isWorkingTask({ status: "working" })).toBe(true);
  expect(isWorkingTask({ section: "working" })).toBe(true);
  expect(isWorkingTask({ section: "working", archived: true })).toBe(false);
  for (const st of ["needs", "ready", "merging", "queued", "todo", "done"]) expect(isWorkingTask({ status: st })).toBe(false);
  const tasks = [
    { space: "vm/sp1", status: "working" }, { space: "vm/sp1", section: "working" }, { space: "vm/sp1", status: "ready" },
    { machine: "vm", folder: "/srv/app", status: "working" }, { space: "vm/sp2", status: "working" }, { space: "vm/sp1", status: "working", archived: true },
  ];
  expect(workingIn(s, tasks)).toBe(3);
  expect(workingIn(s, null)).toBe(0);
});
