import { expect, test } from "bun:test";
import { spacesFromDoc, spaceName, tilde, sharedNames, gitTail, inOrder, withOrder, keptOrder, machinesInOrder, byMachineOrder, withMachineOrder, machineOrderOf, assistantOf, isThinking, statusOf, taskInSpace, isWorkingTask, workingIn } from "./spaces.js";

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

// SHEP-130: a dragged order holds, whatever Herdr's own order is
const sp = (id, machine = null) => ({ id, machine });
const ids = (l) => l.map((s) => s.id);

test("each machine's spaces show in the dragged order; the machines keep their slots", () => {
  // Herdr's order: this computer's, then vm's from its document, then a space the service made on vm (always last)
  const list = [sp("a"), sp("b"), sp("vm/t"), sp("vm/s"), sp("vm/home", "vm")].map((s) => ({ ...s, machine: s.id.startsWith("vm/") ? "vm" : null }));
  expect(ids(inOrder(list, undefined))).toEqual(["a", "b", "vm/t", "vm/s", "vm/home"]);
  const order = { vm: ["vm/home", "vm/t", "vm/s"], "": ["b", "a"] };
  expect(ids(inOrder(list, order))).toEqual(["b", "a", "vm/home", "vm/t", "vm/s"]);
});

test("a space the order doesn't name keeps its place after the one before it in Herdr's; a gone one is skipped", () => {
  const list = [sp("a"), sp("new"), sp("b"), sp("c")];
  expect(ids(inOrder(list, { "": ["c", "a", "gone", "b"] }))).toEqual(["c", "a", "new", "b"]);
  expect(ids(inOrder([sp("first"), sp("a"), sp("b")], { "": ["b", "a"] }))).toEqual(["first", "b", "a"]);
});

test("a drag keeps the spaces it didn't show (in a section, hidden) where they were, and the other machines' orders", () => {
  const d = withOrder({ pinned: ["x"], order: { vm: ["vm/2", "vm/1"] } }, null, ["c", "a"], ["a", "s", "b", "c"]);
  expect(d.order).toEqual({ vm: ["vm/2", "vm/1"], "": ["c", "a", "s", "b"] });
  expect(d.pinned).toEqual(["x"]);
  expect(withOrder({}, "vm", ["vm/home", "vm/t"]).order).toEqual({ vm: ["vm/home", "vm/t"] });
  expect(keptOrder(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "b"]);
});

// SHEP-153: the machines in the order the person dragged them into
test("machines show in the saved order; a new one goes last, a gone one leaves no gap", () => {
  expect(machinesInOrder([null, "vm", "mini"], undefined)).toEqual(["", "vm", "mini"]);
  expect(machinesInOrder([null, "vm", "mini", "new"], ["mini", "gone", "", "vm"])).toEqual(["mini", "", "vm", "new"]);
  const list = [sp("a"), sp("vm/1", "vm"), sp("b"), sp("mini/1", "mini"), sp("vm/2", "vm")];
  expect(ids(byMachineOrder(list, ["mini", "vm"]))).toEqual(["mini/1", "vm/1", "vm/2", "a", "b"]);
  expect(ids(byMachineOrder(list, []))).toEqual(ids(list));
});

test("a machine drag keeps the ones it didn't show where they were, and the rest of the sidebar's data", () => {
  const d = withMachineOrder({ pinned: ["x"], machineOrder: ["", "far", "vm"] }, ["vm", null]);
  expect(d.machineOrder).toEqual(["vm", "", "far"]);
  expect(d.pinned).toEqual(["x"]);
  expect(machineOrderOf({ machineOrder: ["a", 3, "b"] })).toEqual(["a", "b"]);
});

// #818: another machine's herdr-app document already names its terminals with that machine ("box/t6"): its tab's
// chat key read "t:box/box/t6", no such terminal, Reconnecting… for ever
test("another machine's tab keeps one machine on its terminals, as written or not", () => {
  const doc = { spaces: [{ id: "s1", name: "docs", folder: "/srv/docs", tabs: [{ id: "tab2", name: "Claude Code", root: { children: [{ content: { props: { terminal: "box/t6" } } }, { content: { terminal: "t7" } }] } }] }] };
  const [s] = spacesFromDoc(doc, "box");
  expect(s.id).toBe("box/s1");
  expect(s.tabs[0].id).toBe("box/tab2");
  expect(s.tabs[0].terminals).toEqual(["box/t6", "box/t7"]);
  // this machine's own: as written
  expect(spacesFromDoc(doc, null)[0].tabs[0].terminals).toEqual(["box/t6", "t7"]);
});
