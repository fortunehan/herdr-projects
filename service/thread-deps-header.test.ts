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
  h.rec = { id: 13, slug: "project", folder: "/repo", machine, deps: { after: [], then: [] } };
  h.listDoc = doc;
  return h;
};

test("a link to a task of this list opens its worker on the list's own machine", () => {
  host("vm-b").openDep(12);
  expect(shared.get("tasks.thread")).toMatchObject({ terminal: "vm-b/t1", key: { machine: "vm-b", id: 12 } });
  host(null).openDep(12);
  expect(shared.get("tasks.thread")).toMatchObject({ terminal: "t1", key: { machine: null, id: 12 } });
  expect(ran).toContainEqual(["layout.select", { stack: "tasks-thread-body", child: "tasks-thread-chat" }]);
});

test("the Tasks panel's relations win when they are about this task; else its own list's", () => {
  const h = host(null);
  expect(h.depsOf(h.rec)).toEqual({ after: [], then: [] });
  shared.set("tasks.thread.deps", { key: ":/repo#13", after: [{ ref: "WEB-1", external: true, open: { terminal: "t5" } }], then: [] });
  expect(h.depsOf(h.rec).after[0].ref).toBe("WEB-1");
  shared.set("tasks.thread.deps", { key: ":/repo#99", after: [{ ref: "X-1" }], then: [] });
  expect(h.depsOf(h.rec)).toEqual({ after: [], then: [] });
});
