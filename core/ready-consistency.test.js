import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as tasks from "./tasks.js";
import { workingIn } from "./spaces.js";
import * as accept from "./accept.js";
import fixture from "../test/fixtures/codex-ready.json";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const bare = (file) => read(file).replace(/^import[\s\S]*?;\n/gm, "")
  .replace(/^export \{[^}]*\}[^;]*;\n/gm, "").replace(/^export (default )?/gm, "");
const load = (file, deps, result) => new Function(...Object.keys(deps), `${bare(file)}\nreturn ${result};`)(...Object.values(deps));

function replay(task = fixture.task, live = fixture.live, { helpers = [], loaded = true, machine = null } = {}) {
  const list = { slug: "demo", folder: "/work/demo", machine, prefix: "SHEP", tasks: [task] };
  task = { ...task, tab: "tab1", folder: list.folder, slug: list.slug, machine };
  const terms = [...live, ...helpers].map((a) => ({ ...a, state: "live", labels: { "herdr.task": `demo#${task.id}`, "herdr.role": a.role ?? "worker" } }));
  const deps = { ...tasks, View: class {}, TEXT: {}, machines: () => [{ name: machine, layout: loaded ? "ready" : "loading" }],
    terminals: () => terms, agents: () => live, panes: () => [], chatPane: () => null,
    taskDot: (section) => section, ownProgress: () => null, div: () => null };
  const Tasks = load("mods/tasks/main.js", deps, "Tasks");
  const Panel = load("mods/chat/panel.js", deps, "PanelHost");
  const panel = Object.create(Panel.prototype);
  panel.rec = task;
  panel.cur = { key: { slug: list.slug, id: task.id, machine: list.machine } };
  const placed = Object.create(Tasks.prototype).place(list, task);
  const worker = live[0];
  return { task, placed, dot: panel.dot(worker?.status, worker?.address), review: panel.acceptable(worker?.status, worker?.address) };
}

describe("SHEP-44: one status for list, detail and space counts", () => {
  for (const [name, patch, live, helpers, section] of [
    ["recorded own work", {}, fixture.live, [], "working"],
    ["settled", { own_work: false }, fixture.live, [], "ready"],
    ["checks pending", { own_work: false, pr: { wait: "Checks running" } }, fixture.live, [], "working"],
    ["checks failing", { own_work: false, attention: "Checks failing", attention_at: 1 }, [], [], "needs"],
    ["ready turn still ending", { own_work: false }, [{ address: "t6j", status: "working", turn: 0 }], [], "working"],
    ["later work", { own_work: false }, [{ address: "t6j", status: "working", turn: 1 }], [], "working"],
    ["helper still running", { own_work: false }, fixture.live, [{ address: "t2", parent: "t6j", role: "helper", status: "working" }], "working"],
    ["helper asks worker", { own_work: false }, fixture.live, [{ address: "t2", parent: "t6j", role: "helper", status: "blocked" }], "working"],
    ["helper finished", { own_work: false }, fixture.live, [{ address: "t2", parent: "t6j", role: "helper", status: "idle" }], "ready"],
    ["other worker busy", { own_work: false }, [...fixture.live, { address: "t3", status: "working", turn: 0 }], [], "working"],
    ["person asked", { own_work: false }, [{ address: "t6j", status: "blocked", turn: 1 }], [], "needs"],
    ["stopped without ready", { state: "running", started: 1, own_work: false }, [], [], "needs"],
    ["ready without a terminal", { own_work: false }, [], [], "ready"],
    ["merging", { own_work: false, merge_requested: 1 }, fixture.live, [], "working"],
  ]) {
    test(name, () => {
      const r = replay({ ...fixture.task, ...patch }, live, { helpers });
      expect({ list: r.placed.section, detail: r.dot, review: r.review }).toEqual({ list: section, detail: section, review: section === "ready" });
    });
  }

  test("loading another machine does not invent a stopped worker", () => {
    const r = replay({ ...fixture.task, state: "running", own_work: false, started: 1 }, [], { machine: "remote", loaded: false });
    expect({ list: r.placed.section, detail: r.dot, review: r.review }).toEqual({ list: "working", detail: "working", review: false });
  });

  test("a helper on another machine keeps its worker Working", () => {
    const r = replay({ ...fixture.task, own_work: false }, [{ address: "remote/t6j", status: "idle" }], {
      machine: "remote", helpers: [{ address: "remote/t2", parent: "t6j", role: "reviewer", status: "working" }],
    });
    expect({ list: r.placed.section, detail: r.dot, review: r.review }).toEqual({ list: "working", detail: "working", review: false });
  });

  test("a refreshed snapshot clears Working and counts Ready exactly once", async () => {
    const state = new Map();
    let current = replay();
    const inbox = load("lib/inbox.js", {
      shared: (k) => state.get(k), setShared: (k, v) => state.set(k, v), appHome: () => "/app",
      terminals: () => [], agents: () => [], panes: () => [], spaces: () => [], SH: "",
      dirsReady: async () => ({ tasks: "/tasks" }), readTextFile: async () => "{}",
      exec: async (cmd, args) => ({ code: 0, stdout: cmd === "sh" ? "" : args[0] === "list"
        ? JSON.stringify([{ folder: "/work/demo", tasks: [{ ...current.task, status: current.placed.section }] }]) : "[]" }),
    }, "({ readTasks, readyCount, readyByTab })");
    const counts = async () => {
      await inbox.readTasks();
      return { ready: inbox.readyCount(), tab: inbox.readyByTab().get("tab1") ?? 0,
        working: workingIn({ id: "sp1" }, state.get("inbox.running")) };
    };
    expect(await counts()).toEqual({ ready: 0, tab: 0, working: 1 });
    current = replay({ ...fixture.task, own_work: false });
    expect(await counts()).toEqual({ ready: 1, tab: 1, working: 0 });
    expect(await counts()).toEqual({ ready: 1, tab: 1, working: 0 });
  });

  test("an open native Accept card refreshes eligibility and refuses resumed work", async () => {
    let next = { state: "ready", status: "ready", evidence: { summary: "Finished" } };
    const calls = [];
    const Card = load("mods/accept-card/main.js", { ...accept, View: class {}, props: () => ({ ref: "SHEP-43", folder: "/work/demo" }),
      appHome: () => "/app", exec: async (_cmd, args) => { calls.push(args); return { code: 0, stdout: JSON.stringify(next) }; },
    }, "AcceptCard");
    const card = Object.create(Card.prototype), cx = { notify() {}, spawn() { throw new Error("must not accept resumed work"); } };
    await card.refresh(cx, true);
    expect(accept.canAccept(card.t)).toBe(true);
    next = { state: "ready", status: "working" };
    await card.refresh(cx);
    expect(accept.canAccept(card.t)).toBe(false);
    expect(card.t.evidence.summary).toBe("Finished");
    expect(calls[1]).not.toContain("--evidence");
    card.accept(cx);
    expect(calls).toHaveLength(2);
  });
});
