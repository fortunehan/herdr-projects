import { describe, expect, test } from "bun:test";
import { dependencies, place, taskKey } from "./tasks.js";

const list = (tasks, extra = {}) => ({ prefix: "SHEP", folder: "/work/shepherdr", machine: null, tasks, ...extra });
const placed = (...lists) => lists.flatMap((l) => l.tasks.map((t) => place(l, t, { live: t.state === "running" ? [{ address: "t1", status: "working" }] : [] })));
const task = (id, state, extra = {}) => ({ id, title: `Task ${id}`, state, ...extra });
const relations = (l, ...others) => {
  const result = dependencies(placed(l, ...others));
  return (id) => result.get(taskKey(l, { id }));
};

describe("task dependencies", () => {
  test("a chain has direct blockers with live status and reverse links", () => {
    const l = list([task(1, "running"), task(2, "queued", { after: [1] }), task(3, "queued", { after: [2] })]);
    const get = relations(l);
    expect(get(1).waitsFor).toEqual([]);
    expect(get(1).unblocks.map((d) => d.ref)).toEqual(["SHEP-2"]);
    expect(get(2).waitsFor).toEqual([{ key: taskKey(l, { id: 1 }), ref: "SHEP-1", title: "Task 1", state: "running", section: "working" }]);
    expect(get(2).unblocks.map((d) => d.ref)).toEqual(["SHEP-3"]);
    expect(get(3).waitsFor.map((d) => d.ref)).toEqual(["SHEP-2"]);
    expect(get(3).unblocks).toEqual([]);
  });

  for (const state of ["queued", "todo", "scheduled"]) test(`${state} keeps every unfinished prerequisite`, () => {
    const l = list([task(1, "ready"), task(2, "todo"), task(3, state, { after: [1, 2] })]);
    expect(relations(l)(3).waitsFor.map((d) => [d.ref, d.section])).toEqual([["SHEP-1", "ready"], ["SHEP-2", "todo"]]);
  });

  test("completed and removed prerequisites release their links; started dependents are not blocked", () => {
    const l = list([task(1, "done"), task(2, "queued", { after: [1, 99], after_ext: [{ ref: "WEB-1", state: "done" }, { ref: "WEB-2", state: "gone" }] }),
      task(3, "running", { after: [2] }), task(4, "ready", { after: [2] }), task(5, "done", { after: [2] })]);
    for (const t of l.tasks) expect(relations(l)(t.id)).toEqual({ waitsFor: [], unblocks: [] });
  });

  test("an external prerequisite keeps its supplied ref and state, with its loaded title and reverse link", () => {
    const remote = list([task(1, "done")], { prefix: "WEB", folder: "/work/web", machine: "vm-b" });
    const l = list([task(2, "queued", { after_ext: [{ ref: "vm-b:WEB-1", machine: "vm-b", state: "running" }] })]);
    const d = relations(l, remote)(2).waitsFor[0];
    expect(d).toEqual({ key: taskKey(remote, { id: 1 }), ref: "vm-b:WEB-1", title: "Task 1", state: "running", section: "working", external: true });
    expect(dependencies(placed(l, remote)).get(taskKey(remote, { id: 1 })).unblocks.map((d) => d.ref)).toEqual(["SHEP-2"]);
  });

  test("unavailable external lists show their state without a guessed navigation or status", () => {
    const l = list([task(1, "todo", { after_ext: [{ ref: "vm-b:WEB-1", machine: "vm-b", state: "unreachable" }, { ref: "WEB-2", state: "ready" }, { ref: "WEB-3" }] })]);
    expect(relations(l)(1).waitsFor).toEqual([
      { ref: "vm-b:WEB-1", title: null, state: "unreachable", section: null, external: true },
      { ref: "WEB-2", title: null, state: "ready", section: "ready", external: true },
      { ref: "WEB-3", title: null, state: "unknown", section: null, external: true },
    ]);
  });

  test("local ids are scoped by folder and machine; external machine null means its own machine", () => {
    const l = list([task(1, "queued", { after: [2], after_ext: [{ ref: "WEB-2", machine: null, state: "todo" }] }), task(2, "ready")], { machine: "vm-a" });
    const other = list([task(2, "running")], { prefix: "WEB", folder: "/web", machine: "vm-a" });
    const wrong = list([task(2, "done")], { prefix: "WEB", folder: "/web" });
    expect(relations(l, other, wrong)(1).waitsFor.map((d) => d.key)).toEqual([taskKey(l, { id: 2 }), taskKey(other, { id: 2 })]);
    expect(dependencies(placed(l, other, wrong)).get(taskKey(other, { id: 2 })).unblocks[0].ref).toBe("SHEP-1");
  });

  test("duplicates and self links do not duplicate hints; ambiguous refs never open the wrong folder", () => {
    const l = list([task(1, "queued", { after: [1, 2, 2], after_ext: [{ ref: "WEB-1", state: "todo" }] }), task(2, "todo")]);
    const a = list([task(1, "todo")], { prefix: "WEB", folder: "/a" });
    const b = list([task(1, "todo")], { prefix: "WEB", folder: "/b" });
    const before = JSON.stringify([l, a, b]);
    const get = relations(l, a, b);
    expect(get(1).waitsFor.map((d) => d.ref)).toEqual(["SHEP-2", "WEB-1"]);
    expect(get(1).waitsFor[1].key).toBeUndefined();
    expect(get(2).unblocks).toHaveLength(1);
    expect(JSON.stringify([l, a, b])).toBe(before);
  });
});
