import { describe, expect, test } from "bun:test";
import { CHAT, KEY, decide, followSpace, switched } from "./thread-space.js";

const T1 = { terminal: "t1", task: "SHEP-1", title: "One", key: { machine: null, folder: "/a", slug: "a", id: 1 } };
const T2 = { terminal: "t2", task: "SHEP-2", title: "Two", key: { machine: null, folder: "/b", slug: "b", id: 2 } };

describe("decide", () => {
  test("the first look only notes the space", () => {
    expect(decide({ now: "A", mem: null, open: true, thread: T1 })).toEqual({ mem: { seen: "A", open: {} }, restore: null, list: false });
  });

  test("the same space: nothing", () => {
    expect(decide({ now: "A", mem: { seen: "A", open: {} }, open: true, thread: T1 })).toBe(null);
  });

  test("leaving a space with a task open: back to the list, the task kept for that space", () => {
    const step = decide({ now: "B", mem: { seen: "A", open: {} }, open: true, thread: T1, view: "tasks-thread-shell", ids: ["A", "B"] });
    expect(step.list).toBe(true);
    expect(step.restore).toBe(null);
    expect(step.mem).toEqual({ seen: "B", open: { A: { thread: T1, view: "tasks-thread-shell" } } });
  });

  test("back to it: its task and view again", () => {
    const step = decide({ now: "A", mem: { seen: "B", open: { A: { thread: T1, view: "tasks-thread-pr" } } }, open: false, thread: T1, ids: ["A", "B"] });
    expect(step.restore).toEqual({ thread: T1, view: "tasks-thread-pr" });
  });

  test("a space left on its list forgets its task", () => {
    const step = decide({ now: "B", mem: { seen: "A", open: { A: { thread: T1, view: CHAT } } }, open: false, thread: T1, ids: ["A", "B"] });
    expect(step).toEqual({ mem: { seen: "B", open: {} }, restore: null, list: false });
  });

  test("each space its own task", () => {
    const step = decide({ now: "A", mem: { seen: "B", open: { A: { thread: T1, view: CHAT } } }, open: true, thread: T2, view: CHAT, ids: ["A", "B"] });
    expect(step.restore.thread).toEqual(T1);
    expect(step.mem.open.B.thread).toEqual(T2);
  });

  test("the Terminal view comes back as the chat (its block shows whichever agent it was pointed at)", () => {
    const step = decide({ now: "A", mem: { seen: "B", open: { A: { thread: T1, view: "tasks-thread-term" } } }, open: false, thread: null });
    expect(step.restore.view).toBe(CHAT);
  });

  test("the same task with a new agent (a Resume meanwhile): the new one", () => {
    const resumed = { ...T1, terminal: "t9", at: 5 };
    const step = decide({ now: "A", mem: { seen: "B", open: { A: { thread: T1, view: CHAT } } }, open: false, thread: resumed });
    expect(step.restore.thread).toEqual(resumed);
  });

  test("a closed space is forgotten", () => {
    const step = decide({ now: "B", mem: { seen: "A", open: { C: { thread: T2, view: CHAT } } }, open: false, thread: null, ids: ["A", "B"] });
    expect(step.mem.open).toEqual({});
  });
});

// A window: the layout's tasks stack and body stack, shared state, the shown space.
function windowOf() {
  const store = {};
  const w = {
    active: "A",
    tree: { id: "root", children: [{ id: "tasks", active: "tasks-list", children: [{ id: "tasks-list" },
      { id: "tasks-thread", children: [{ id: "tasks-thread-head" }, { id: "tasks-thread-body", active: CHAT, children: [{ id: CHAT }, { id: "tasks-thread-shell" }] }] }] }] },
  };
  const find = (n, id) => (n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);
  w.h = {
    spaces: () => ["A", "B"].map((id) => ({ id, active: id === w.active })),
    layout: () => w.tree,
    shared: (k) => store[k] ?? null,
    setShared: (k, v) => { store[k] = v; },
    run: (cmd, a) => { if (cmd === "layout.select") find(w.tree, a.stack).active = a.child; },
  };
  w.open = (t, view = CHAT) => { store["tasks.thread"] = t; find(w.tree, "tasks").active = "tasks-thread"; find(w.tree, "tasks-thread-body").active = view; };
  w.shows = () => (find(w.tree, "tasks").active === "tasks-thread" ? [store["tasks.thread"]?.task, find(w.tree, "tasks-thread-body").active] : "list");
  w.pick = (id) => { w.active = id; if (switched(w.h)) followSpace(w.h); };
  w.store = store;
  return w;
}

describe("followSpace", () => {
  test("A's task, then B: B's list; back to A: A's task in the view it had", () => {
    const w = windowOf();
    followSpace(w.h);
    w.open(T1, "tasks-thread-shell");
    w.pick("B");
    expect(w.shows()).toBe("list");
    w.pick("A");
    expect(w.shows()).toEqual(["SHEP-1", "tasks-thread-shell"]);
    expect(w.store[KEY].seen).toBe("A");
  });

  test("a task opened in B stays B's", () => {
    const w = windowOf();
    followSpace(w.h);
    w.open(T1);
    w.pick("B");
    w.open(T2);
    w.pick("A");
    expect(w.shows()).toEqual(["SHEP-1", CHAT]);
    w.pick("B");
    expect(w.shows()).toEqual(["SHEP-2", CHAT]);
  });

  test("a second call after the move does nothing", () => {
    const w = windowOf();
    followSpace(w.h);
    w.open(T1);
    w.active = "B";
    expect(followSpace(w.h)).toBe(true);
    expect(switched(w.h)).toBe(false);
    expect(followSpace(w.h)).toBe(false);
  });

  test("a layout without the task view: nothing", () => {
    const w = windowOf();
    w.tree = { id: "root", children: [] };
    expect(followSpace(w.h)).toBe(false);
  });
});
