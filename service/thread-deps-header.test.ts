// SHEP-103: the window's task header shows the task's "↑ after" and "↓ then" (mods/chat/panel.js). Its links open the
// task on the right machine, and it prefers what the Tasks panel worked out from every list.
import { beforeEach, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const shared = new Map<string, unknown>();
const ran: [string, any][] = [];
const none = async () => ({ code: 1, stdout: "", stderr: "" });
const tree = { id: "root", children: [{ id: "tasks-thread-head" }, { id: "tasks-thread-body", children: [{ id: "tasks-thread-chat" }] }] };
// the same task key live on this computer and on vm-b
const terms = [
  { address: "t1", state: "live", labels: { "herdr.task": "project#12" } },
  { address: "vm-b/t1", state: "live", labels: { "herdr.task": "project#12" } },
  // vm-c: a worker's helper listed before the worker
  { address: "vm-c/t7", state: "live", parent: "vm-c/t8", labels: { "herdr.task": "project#12", "herdr.role": "helper" } },
  { address: "vm-c/t8", state: "live", labels: { "herdr.task": "project#12" } },
];
mock.module("herdr", () => fakeHerdr({
  run: (cmd: string, args: any) => { ran.push([cmd, args]); }, layout: () => tree, exec: none, hc: none, settings: () => ({}),
  shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => { shared.set(k, v); },
  agents: () => [], panes: () => [], terminals: () => terms, spaces: () => [], machines: () => [],
}));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase());
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { PanelHost } = await import("../mods/chat/panel.js");

beforeEach(() => { shared.clear(); ran.length = 0; });

const doc = { prefix: "PRJ", folder: "/repo", tasks: [{ id: 12, state: "running", title: "Build" }, { id: 13, state: "queued", title: "Ship", after: [12] }] };
const host = (machine: string | null) => {
  const h: any = new PanelHost(class {}, true);
  h.rec = { id: 13, ref: "PRJ-13", state: "queued", slug: "project", folder: "/repo", machine, deps: { after: [], then: [] } };
  h.listDoc = doc;
  return h;
};

test("a link to a task of this list opens its worker on the list's own machine", () => {
  host("vm-b").openDep(12);
  expect(shared.get("tasks.thread")).toMatchObject({ terminal: "vm-b/t1", key: { machine: "vm-b", id: 12 } });
  host(null).openDep(12);
  expect(shared.get("tasks.thread")).toMatchObject({ terminal: "t1", key: { machine: null, id: 12 } });
  expect(ran).toContainEqual(["layout.select", { stack: "tasks-thread-body", child: "tasks-thread-chat" }]);
  host("vm-c").openDep(12);
  expect(shared.get("tasks.thread")).toMatchObject({ terminal: "vm-c/t8" });
});

const open = (machine: string | null, folder: string, id: number) => ({ terminal: null, key: { machine, folder, slug: "x", id } });

test("its own list says which hold and their state; the Tasks panel's relations add links and other lists' dependents", () => {
  const h = host(null);
  expect(h.depsOf(h.rec)).toEqual({ after: [], then: [] });
  h.rec.deps = {
    after: [{ id: 12, ref: "PRJ-12", title: "Build", state: "ready", section: "ready" }, { ref: "WEB-1", title: null, state: "running", section: "working", external: true }],
    then: [{ id: 14, ref: "PRJ-14", title: "Docs" }],
  };
  // an older entry: PRJ-12 still Working there; it only adds how each opens and WEB-1's folder
  shared.set("tasks.deps", { ":/repo#13": {
    after: [{ ref: "PRJ-12", section: "working", pct: 40, open: open(null, "/repo", 12) },
      { ref: "WEB-1", title: "Route", external: true, where: "web", open: open(null, "/web", 1) }],
    then: [{ ref: "PRJ-14", open: open(null, "/repo", 14) }, { ref: "APP-3", open: open(null, "/app", 3) }],
  } });
  const d = h.depsOf(h.rec);
  expect(d.after).toEqual([
    { id: 12, ref: "PRJ-12", title: "Build", state: "ready", section: "ready", open: open(null, "/repo", 12) },
    { ref: "WEB-1", title: "Route", state: "running", section: "working", external: true, where: "web", open: open(null, "/web", 1) },
  ]);
  expect(d.then.map((x: any) => [x.ref, x.open.key.folder])).toEqual([["PRJ-14", "/repo"], ["APP-3", "/app"]]);
});

test("two machines' tasks of the same id stay two, each saying its machine and opening its own", () => {
  // vm-b:PRJ-12, waited for by vm-b:PRJ-13 (its own list) and by this computer's PRJ-13
  const h = host("vm-b");
  h.rec = { ...h.rec, id: 12, ref: "PRJ-12", state: "running", deps: { after: [], then: [{ id: 13, ref: "PRJ-13", title: "Ship" }] } };
  shared.set("tasks.deps", { "vm-b:/repo#12": { after: [], then: [
    { ref: "PRJ-13", open: open(null, "/repo", 13) },
    { ref: "PRJ-13", open: open("vm-b", "/repo", 13) },
  ] } });
  const d = h.depsOf(h.rec);
  expect(d.then.map((x: any) => [x.ref, x.open.key.machine])).toEqual([["vm-b:PRJ-13", "vm-b"], ["PRJ-13", null]]);
});

test("an older entry never brings back a prerequisite the list says is done, nor a dependent that started", () => {
  const h = host(null);
  h.rec.deps = { after: [], then: [] };
  shared.set("tasks.deps", { ":/repo#13": {
    after: [{ ref: "PRJ-12", section: "working", pct: 40, open: open(null, "/repo", 12) }],
    then: [{ ref: "PRJ-14", open: open(null, "/repo", 14) }, { ref: "vm-b:APP-3", open: open("vm-b", "/app", 3) }],
  } });
  expect(h.depsOf(h.rec)).toEqual({ after: [], then: [{ ref: "vm-b:APP-3", open: open("vm-b", "/app", 3) }] });
  h.rec.state = "done";
  expect(h.depsOf(h.rec)).toEqual({ after: [], then: [] });
});

test("the header block follows the layout's saved height back to its own", () => {
  const h = host(null);
  const later: (() => void)[] = [];
  const cx = { timer: { after: (_ms: number, f: () => void) => later.push(f) } };
  (tree.children[0] as any).size = { px: 192 };
  h.fitHead(0, cx);
  later.forEach((f) => f());
  expect(ran).toContainEqual(["layout.resize", { id: "tasks-thread-head", px: 127 }]);
  ran.length = 0; later.length = 0;
  (tree.children[0] as any).size = { px: 127 };
  h.fitHead(0, cx);
  expect(later).toHaveLength(0);
});
