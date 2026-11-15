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
    { ref: "vm-b:WEB-2", title: "Build", state: "ready", status: "ready", task: "vm-b:WEB-2", external: true },
    { ref: "OTHER-3", title: null, state: "unreachable", external: true },
  ]);
  expect(snap.tasks[1].dependencies?.unblocks[0]).toMatchObject({ ref: "SHEP-1", task: "SHEP-1", status: "queued" });
});
