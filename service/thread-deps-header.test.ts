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

test("its own list says which hold; the Tasks panel's relations add links and other lists' dependents", () => {
  const h = host(null);
  expect(h.depsOf(h.rec)).toEqual({ after: [], then: [] });
  // the list still has it waiting for WEB-1: the panel's entry adds how to open it
  h.rec.deps = { after: [{ ref: "WEB-1", state: "running", section: "working", external: true }], then: [{ id: 14, ref: "PRJ-14", title: "Docs" }] };
  shared.set("tasks.deps", { ":/repo#13": {
    after: [{ ref: "WEB-1", external: true, where: "web", open: { terminal: "t5" } }],
    then: [{ ref: "PRJ-14", open: { terminal: null } }, { ref: "APP-3", open: { terminal: "t9" } }],
  } });
  const d = h.depsOf(h.rec);
  expect(d.after).toEqual([{ ref: "WEB-1", state: "running", section: "working", external: true, where: "web", open: { terminal: "t5" } }]);
  expect(d.then.map((x: any) => x.ref)).toEqual(["PRJ-14", "APP-3"]);
  // another task's entry is no help
  shared.set("tasks.deps", { ":/repo#99": { after: [{ ref: "X-1" }], then: [] } });
  expect(h.depsOf(h.rec).after.map((x: any) => x.open)).toEqual([undefined]);
});

test("an older entry never brings back a prerequisite the list says is done, nor a dependent that started", () => {
  const h = host(null);
  // the list read now: PRJ-12 done, PRJ-14 started; the panel's entry is from before
  h.rec.deps = { after: [], then: [] };
  shared.set("tasks.deps", { ":/repo#13": {
    after: [{ ref: "PRJ-12", section: "working", pct: 40, open: { terminal: "t1" } }],
    then: [{ ref: "PRJ-14", open: null }, { ref: "vm-b:APP-3", open: null }],
  } });
  expect(h.depsOf(h.rec)).toEqual({ after: [], then: [{ ref: "vm-b:APP-3", open: null }] });
  h.rec.state = "done";
  expect(h.depsOf(h.rec)).toEqual({ after: [], then: [] });
});
