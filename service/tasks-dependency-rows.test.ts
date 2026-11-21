// SHEP-103: the Tasks panel's rows as B of SHEP-100's mock-up draws them: "↑ after" over a waiting task's title, "↓ then"
// under the task it waits for, a short line between two rows when the waiting one comes right after, and the
// prerequisite's dot and status when its row is out of sight. The mock-up's data: SHEP-12 = BB (working, 40%),
// SHEP-13 = CC after BB, SHEP-14 = DD after CC, SHEP-15 = EE after BB and CC, SHEP-16 after WEB-2 (another folder).
import { beforeEach, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit, built, type Element } from "./fake-gpui";

const shared = new Map<string, unknown>();
const none = async () => ({ code: 1, stdout: "", stderr: "" });
const tree = { id: "root", children: [{ id: "tasks", children: [{ id: "tasks-list" }, { id: "tasks-thread" }] }] };
const theme = { foreground: "#fafafa", muted: "#a1a1aa", dim: "#7c7c85", hover: "#ffffff0a", selected: "#ffffff12", border: "#ffffff1f", background: "#111114" };
mock.module("herdr", () => fakeHerdr({
  run: () => {}, layout: () => tree, exec: none, hc: none, theme: () => theme, settings: () => ({}),
  shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => { shared.set(k, v); },
  agents: () => [], panes: () => [], terminals: () => [], spaces: () => [], machines: () => [],
}));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase());
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Tasks } = await import("../mods/tasks/main.js");
const { dependencies, place, taskKey } = await import("../core/tasks.js");

beforeEach(() => { shared.clear(); built.length = 0; });

const list: any = { machine: null, folder: "/work/shepherdr", slug: "shepherdr", prefix: "SHEP", tasks: [
  { id: 12, state: "running", title: "Add dependency data to the task list", progress: { text: "Writing tests for after_ext", done: 40 } },
  { id: 13, state: "queued", title: "Draw dependency lines in the panel", after: [12] },
  { id: 14, state: "queued", title: "Same lines in the web app", after: [13] },
  { id: 15, state: "queued", title: "Docs for task chains", after: [12, 13] },
  { id: 16, state: "queued", title: "Call the new /api/chains route", after_ext: [{ ref: "WEB-2", machine: null, state: "running" }] },
] };
const web: any = { machine: null, folder: "/work/web", slug: "web", prefix: "WEB", tasks: [{ id: 2, state: "running", title: "Chains route" }] };
const live = [{ address: "t1", status: "working" }];
const placed = [list, web].flatMap((l) => l.tasks.map((t: any) => place(l, t, { live: (t.state === "running" ? live : []) as any })));
const of = (id: number) => placed.find((p: any) => p.list === list && p.task.id === id);

function panel(seen: number[]) {
  const tasks: any = Object.create(Tasks.prototype);
  tasks.live = () => [];
  tasks.names = { machine: false, space: false };
  tasks.seen = new Set(seen.map((id) => taskKey(list, { id })));
  tasks.frame = { dependencies: dependencies(placed), dependencyTargets: new Map(placed.map((p: any) => [taskKey(p.list, p.task), p])),
    built: new Set(), hidden: new Set(), rowKeys: new WeakMap() };
  return tasks;
}

// Every string in an element's tree, in order.
const words = (e: Element): string[] => (e?.kids ?? []).flatMap((k: any) => (typeof k === "string" ? [k] : words(k)));
const linked = (row: Element) => built.some((e) => e.kind === "svg" && row && within(row, e) && e.calls.some((c: any) => c[0] === "w" && c[1][0] === 7));
const within = (root: Element, e: Element): boolean => root === e || (root?.kids ?? []).some((k: any) => typeof k !== "string" && within(k, e));

test("the waiting row says after, the waited-for row says then, in the mock-up's words", () => {
  const tasks = panel([12, 13, 14, 15, 16]);
  const [cc, dd, ee] = tasks.rows([of(13), of(14), of(15)], theme);
  const ccWords = words(cc);
  expect(ccWords.slice(0, 3)).toEqual(["↑ after", "SHEP-12", "Draw dependency lines in the panel"]);
  expect(ccWords).toContain("↓ then");
  expect(ccWords.slice(ccWords.indexOf("↓ then"))).toEqual(["↓ then", "SHEP-14", "SHEP-15"]);
  // a task waiting on two names both on one line
  expect(words(ee).slice(0, 3)).toEqual(["↑ after", "SHEP-12", "SHEP-13"]);
  expect(words(dd)[0]).toBe("↑ after");
  // the queue's "after SHEP-12" second line gives way to the line over the title
  expect(ccWords.join(" ")).not.toContain("After SHEP-12");
  const bb = tasks.rows([of(12)], theme)[0];
  expect(words(bb).slice(-3)).toEqual(["↓ then", "SHEP-13", "SHEP-15"]);
});

test("only a row followed by one waiting for it gets the short line", () => {
  const tasks = panel([12, 13, 14, 15, 16]);
  const rows = tasks.rows([of(13), of(14), of(15), of(16)], theme);
  expect(rows.map((r: Element) => linked(r))).toEqual([true, false, false, false]);
});

test("a prerequisite out of sight carries its dot and status; another folder's its folder too", () => {
  // filtered to Queued: BB has no row
  const tasks = panel([13, 14, 15, 16]);
  const [cc, , , other] = tasks.rows([of(13), of(14), of(15), of(16)], theme);
  expect(words(cc).slice(0, 3)).toEqual(["↑ after", "SHEP-12", "· Working 40%"]);
  expect(words(other).slice(0, 3)).toEqual(["↑ after", "WEB-2 · web", "· Working"]);
  // in sight, the id alone
  const shown = panel([12, 13, 14, 15, 16]).rows([of(13)], theme)[0];
  expect(words(shown)).not.toContain("· Working 40%");
});

test("a folded group's rows count as out of sight for the next frame", () => {
  const tasks = panel([]);
  tasks.shutKeys = new Set(["working"]);
  tasks.allDone = new Set();
  const rows = tasks.rows([of(12)], theme);
  tasks.group("working", "Working", rows, theme, {});
  const key = taskKey(list, { id: 12 });
  expect(tasks.frame.built.has(key)).toBe(true);
  expect(tasks.frame.hidden.has(key)).toBe(true);
  const cc = tasks.rows([of(13)], theme);
  tasks.group("queued", "Queued", cc, theme, {});
  expect(tasks.frame.hidden.has(taskKey(list, { id: 13 }))).toBe(false);
});

test("an id opens its task, without opening the row it sits on", () => {
  const tasks = panel([12, 13]);
  const opened: string[] = [];
  tasks.target = (p: any) => () => opened.push(`SHEP-${p.task.id}`);
  const cc = tasks.rows([of(13)], theme)[0];
  const item = built.find((e) => within(cc, e) && e.calls.some((c: any) => c[0] === "id" && String(c[1][0]).startsWith("after-")))!;
  let stopped = false;
  item.calls.find((c: any) => c[0] === "on_click")[1][0]({}, { stop_propagation: () => { stopped = true; }, notify: () => {} });
  expect(opened).toEqual(["SHEP-12"]);
  expect(stopped).toBe(true);
});
