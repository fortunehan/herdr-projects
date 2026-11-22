import { describe, expect, test } from "bun:test";
import { dependencies, place, taskKey, relationState, linkedToNext, ownRelations } from "./tasks.js";

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

// SHEP-103: B of SHEP-100's mock-up, the same data (SHEP-12 = BB working, SHEP-13 = CC after BB, SHEP-14 = DD after CC,
// SHEP-15 = EE after BB and CC, SHEP-16 after WEB-2, SHEP-17 after vm-b:HAT-12).
describe("task dependencies as variant B shows them", () => {
  const mock = (bb = "running") => list([
    task(12, bb, bb === "running" ? { progress: { text: "Writing tests for after_ext", done: 40 } } : {}),
    task(13, "queued", { after: [12] }), task(14, "queued", { after: [13] }), task(15, "queued", { after: [12, 13] }),
    task(16, "queued", { after_ext: [{ ref: "WEB-2", machine: null, state: "running" }] }),
    task(17, "queued", { after_ext: [{ ref: "vm-b:HAT-12", machine: "vm-b", state: "ready" }] }),
  ]);
  const web = list([task(2, "running", { progress: { text: "Routes", done: 60 } })], { prefix: "WEB", folder: "/work/web" });

  test("a chain: BB then CC, CC after BB then DD and EE, DD after CC", () => {
    const get = relations(mock(), web);
    expect(get(12).unblocks.map((d) => d.ref)).toEqual(["SHEP-13", "SHEP-15"]);
    expect(get(13).waitsFor.map((d) => d.ref)).toEqual(["SHEP-12"]);
    expect(get(13).unblocks.map((d) => d.ref)).toEqual(["SHEP-14", "SHEP-15"]);
    expect(get(14).waitsFor.map((d) => d.ref)).toEqual(["SHEP-13"]);
  });

  test("a task waiting on two names both, each with its status for when its row is out of sight", () => {
    const ds = relations(mock(), web)(15).waitsFor;
    expect(ds.map((d) => d.ref)).toEqual(["SHEP-12", "SHEP-13"]);
    expect(ds[0]).toMatchObject({ section: "working", pct: 40 });
    expect(ds.map(relationState)).toEqual(["Working 40%", "Queued"]);
  });

  test("another folder's task says its folder and status; another machine's its scheduler state", () => {
    const get = relations(mock(), web);
    expect(get(16).waitsFor[0]).toMatchObject({ ref: "WEB-2", where: "web", section: "working", pct: 60, external: true });
    expect(relationState(get(16).waitsFor[0])).toBe("Working 60%");
    expect(get(17).waitsFor[0]).toEqual({ ref: "vm-b:HAT-12", title: null, state: "ready", section: "ready", external: true });
    expect(relationState(get(17).waitsFor[0])).toBe("Ready");
    expect(relationState({ ref: "vm-c:X-1", state: "unreachable", section: null })).toBe("unreachable");
  });

  test("once BB is done: CC no longer waits, DD and EE wait for CC only", () => {
    const get = relations(mock("done"), web);
    expect(get(12).unblocks).toEqual([]);
    expect(get(13).waitsFor).toEqual([]);
    expect(get(15).waitsFor.map((d) => d.ref)).toEqual(["SHEP-13"]);
    expect(get(13).unblocks.map((d) => d.ref)).toEqual(["SHEP-14", "SHEP-15"]);
  });

  test("a short line joins only a row and the very next row waiting for it", () => {
    const l = mock();
    const result = dependencies(placed(l, web));
    const rows = (ids) => ids.map((id) => ({ key: taskKey(l, { id }), waits: result.get(taskKey(l, { id })).waitsFor.map((d) => d.key).filter(Boolean) }));
    // Queued, as the mock-up's list: CC, DD, EE, ...; BB is in Working, away from CC
    expect([...linkedToNext(rows([13, 14, 15, 16, 17]))]).toEqual([taskKey(l, { id: 13 })]);
    // filtered to Queued, BB isn't a row at all; a chain BB, CC, DD in a row joins both pairs
    expect([...linkedToNext(rows([12, 13, 14]))]).toEqual([taskKey(l, { id: 12 }), taskKey(l, { id: 13 })]);
    expect([...linkedToNext(rows([14, 13]))]).toEqual([]);
  });

  test("a task's own header reads its after and then from its list alone", () => {
    const doc = { prefix: "SHEP", tasks: mock().tasks };
    expect(ownRelations(doc, 13)).toEqual({
      after: [{ id: 12, ref: "SHEP-12", title: "Task 12", state: "running", section: "working", pct: 40 }],
      then: [{ id: 14, ref: "SHEP-14", title: "Task 14" }, { id: 15, ref: "SHEP-15", title: "Task 15" }],
    });
    expect(ownRelations(doc, 17).after).toEqual([{ ref: "vm-b:HAT-12", title: null, state: "ready", section: "ready", external: true }]);
    expect(ownRelations({ prefix: "SHEP", tasks: mock("done").tasks }, 13).after).toEqual([]);
    // a started task waits for nothing; a missing one has nothing
    expect(ownRelations({ prefix: "SHEP", tasks: [task(1, "ready"), task(2, "running", { after: [1] })] }, 2)).toEqual({ after: [], then: [] });
    expect(ownRelations(doc, 99)).toEqual({ after: [], then: [] });
  });
});
