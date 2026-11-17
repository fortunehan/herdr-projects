import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { taskCounts } from "./task-counts.js";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const bare = (file) => read(file).replace(/^import[\s\S]*?;\n/gm, "")
  .replace(/^export \{[^}]*\}[^;]*;\n/gm, "").replace(/^export (default )?/gm, "");
const load = (file, deps, result) => new Function(...Object.keys(deps), `${bare(file)}\nreturn ${result};`)(...Object.values(deps));

function tree() {
  const node = { style: {}, children: [] };
  const proxy = new Proxy(node, { get(target, k) {
    if (k in target) return target[k];
    if (k === "child") return (child) => { node.children.push(child); return proxy; };
    if (k === "when") return (on, f) => on ? f(proxy) : proxy;
    return (...args) => { node.style[k] = args[0] ?? true; return proxy; };
  } });
  return proxy;
}
const words = (node) => typeof node === "object" ? node.children.flatMap(words) : [node];
const byId = (node, id) => typeof node === "object" && (node.style.id === id ? node : node.children.map((c) => byId(c, id)).find(Boolean));

function inboxReplay() {
  const state = new Map();
  let groups = [];
  const inbox = load("lib/inbox.js", {
    taskCounts, shared: (k) => state.get(k), setShared: (k, v) => state.set(k, v), appHome: () => "/app",
    terminals: () => [], agents: () => [], panes: () => [], spaces: () => [], SH: "",
    dirsReady: async () => ({ tasks: "/tasks" }), readTextFile: async () => "{}",
    exec: async (cmd, args) => ({ code: 0, stdout: cmd === "sh" ? "" : args[0] === "list" ? JSON.stringify(groups) : "[]" }),
  }, "({ readTasks, statusCounts })");
  return async (tasks) => {
    groups = [{ folder: "/work/demo", tasks }];
    await inbox.readTasks();
    return inbox.statusCounts();
  };
}

describe("global task status totals (SHEP-68)", () => {
  test("mixed states count task rows once, excluding archived and waiting-to-merge rows", () => {
    const task = (key, status, extra = {}) => ({ key, status, ...extra });
    const working = task("local:/a:T-1", "working", { live: [{ address: "worker" }, { address: "reviewer" }] });
    expect(taskCounts([{ key: "ask:1" }, { key: "ask:1" }, { key: "blocked:other" }], [working, working,
      task("remote:/a:T-1", "work"), task("local:/b:T-1", "ready"), task("archived", "ready", { archived: 1 }),
      ...["needs", "need", "merging", "queued", "scheduled", "todo", "done"].map((s) => task(s, s)),
    ])).toEqual({ need: 2, ready: 1, working: 2 });
    expect(taskCounts()).toEqual({ need: 0, ready: 0, working: 0 });
  });

  test("inbox refresh moves the same task from Working to Ready to Needs you to zero", async () => {
    const refresh = inboxReplay();
    const task = { id: 1, ref: "T-1", state: "ready", live: [{ address: "a" }, { address: "b" }] };
    expect(await refresh([{ ...task, status: "working" }, { ...task, status: "working" }])).toEqual({ need: 0, ready: 0, working: 1 });
    expect(await refresh([{ ...task, status: "ready" }])).toEqual({ need: 0, ready: 1, working: 0 });
    expect(await refresh([{ ...task, state: "running", status: "stopped", needs: "stopped" }])).toEqual({ need: 1, ready: 0, working: 0 });
    expect(await refresh([])).toEqual({ need: 0, ready: 0, working: 0 });
  });

  test("native bottom bar keeps all labels and green Ready at zero and at narrow widths", () => {
    let counts = { need: 2, ready: 3, working: 4 };
    const Status = load("mods/workspace-status-chat/main.js", {
      View: class {}, div: tree, h_flex: tree, svg: tree, theme: () => ({ muted: "muted", dim: "dim", working: "amber" }),
      spaces: () => [], shared: () => null, statusCounts: () => counts, red: () => "red", green: () => "green", TEXT: {}, RADIUS: {},
      window: () => ({}), keys: () => [],
    }, "WorkspaceStatus");
    const status = new Status();
    status.width = 390;
    let rendered = status.draw();
    expect(words(rendered)).toEqual(["2", "Needs you", "3", "Ready", "4", "Working"]);
    expect(byId(rendered, "status-ready").style.text_color).toBe("green");
    expect(byId(rendered, "palette")).toBeUndefined();
    counts = { need: 0, ready: 0, working: 0 };
    rendered = status.draw();
    expect(words(rendered)).toEqual(["0", "Needs you", "0", "Ready", "0", "Working"]);
    status.width = 1280;
    expect(words(status.draw())).toContain("Commands");
  });

  test("native Tasks navigation has no badge; space and tab counts retain their source", () => {
    const source = read("mods/tabs-tasks/main.js");
    const button = source.slice(source.indexOf("const panelButton ="), source.indexOf('return h_flex().id("tabs-bar")'));
    expect(button).not.toContain("countBadge");
    expect(button).toContain('run("layout.select", { stack: "panel-body", child: id })');
    expect(source).toContain('panelButton("tasks", "Tasks", "mods/tasks/tasks.svg")');
    expect(source).toContain("countsByTab()");
    expect(source).toContain("readyByTab()");
  });
});
