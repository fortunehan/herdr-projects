import { expect, test } from "bun:test";
import { dependencies, place, refOf, taskKey } from "../core/tasks.js";
import { Compat } from "./compat.ts";

test("dependency links reach the correct web task and keep external states", () => {
  const lists = [
    { prefix: "SHEP", folder: "/repo", machine: null, tasks: [{ id: 1, state: "queued", title: "Ship", after_ext: [
      { ref: "vm-b:WEB-2", machine: "vm-b", state: "ready" }, { ref: "OTHER-3", state: "unreachable" },
    ] }] },
    { prefix: "WEB", folder: "/web", machine: "vm-b", tasks: [{ id: 2, state: "todo", title: "Build" }] },
  ];
  const ps = lists.flatMap((l) => l.tasks.map((t) => place(l, t)));
  const links = dependencies(ps);
  const rows = ps.map((p) => ({ key: taskKey(p.list, p.task), ref: refOf(p.list, p.task), id: p.task.id,
    title: p.task.title, section: p.section, machine: p.list.machine, folder: p.list.folder,
    dependencies: links.get(taskKey(p.list, p.task)) }));
  const snap = new Compat().snapshot({ host: "host", user: "me", machines: [], spaces: [], sections: [], rows });
  expect(snap.tasks[0].dependencies?.waitsFor).toEqual([
    { ref: "vm-b:WEB-2", title: "Build", state: "ready", status: "ready", task: "vm-b:WEB-2", external: true, word: "Ready" },
    { ref: "OTHER-3", title: null, state: "unreachable", external: true, word: "unreachable" },
  ]);
  expect(snap.tasks[1].dependencies?.unblocks[0]).toMatchObject({ ref: "SHEP-1", task: "SHEP-1", status: "queued" });
});

test("the web gets a hidden prerequisite's % done, folder and status words (SHEP-103)", () => {
  const lists = [
    { prefix: "SHEP", folder: "/repo", machine: null, tasks: [
      { id: 12, state: "running", title: "Data", progress: { text: "Tests", done: 40 } },
      { id: 13, state: "queued", title: "Lines", after: [12], after_ext: [{ ref: "WEB-2", machine: null, state: "running" }] },
    ] },
    { prefix: "WEB", folder: "/work/web", machine: null, tasks: [{ id: 2, state: "running", title: "Route" }] },
  ];
  const ps = lists.flatMap((l) => l.tasks.map((t) => place(l, t, { live: (t.state === "running" ? [{ address: `t${t.id}`, status: "working" }] : []) as any })));
  const links = dependencies(ps);
  const rows = ps.map((p) => ({ key: taskKey(p.list, p.task), ref: refOf(p.list, p.task), id: p.task.id,
    title: p.task.title, section: p.section, machine: p.list.machine, folder: p.list.folder,
    dependencies: links.get(taskKey(p.list, p.task)) }));
  const snap = new Compat().snapshot({ host: "host", user: "me", machines: [], spaces: [], sections: [], rows });
  const cc = snap.tasks.find((t) => t.id === "SHEP-13")!;
  expect(cc.dependencies?.waitsFor).toEqual([
    { ref: "SHEP-12", title: "Data", state: "running", status: "work", task: "SHEP-12", pct: 40, word: "Working 40%" },
    { ref: "WEB-2", title: "Route", state: "running", status: "work", task: "WEB-2", external: true, where: "web", word: "Working" },
  ]);
  expect(snap.tasks.find((t) => t.id === "SHEP-12")!.dependencies?.unblocks.map((d) => d.ref)).toEqual(["SHEP-13"]);
});
