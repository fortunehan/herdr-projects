import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spaceTaskCounts, taskCounts } from "./task-counts.js";
import { chatPane } from "./spaces.js";

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
    spaceTaskCounts, shared: (k) => state.get(k), setShared: (k, v) => state.set(k, v), appHome: () => "/app",
    terminals: () => [], agents: () => [], panes: () => [], spaces: () => [{ id: "sp1", tabs: [{ id: "tab1" }] }], SH: "",
    dirsReady: async () => ({ tasks: "/tasks" }), readTextFile: async () => "{}",
    pullCard: () => "Could not pull",
    exec: async (cmd, args) => ({ code: 0, stdout: cmd === "sh" ? "" : args[0] === "list" ? JSON.stringify(groups) : "[]" }),
  }, "({ readTasks, statusCounts, items })");
  return Object.assign(async (tasks) => {
    groups = [{ folder: "/work/demo", tasks: tasks.map((t) => ({ space: "sp1", tab: "tab1", ...t })) }];
    await inbox.readTasks();
    return inbox.statusCounts();
  }, { items: inbox.items });
}

describe("space and bottom bar status totals (SHEP-79)", () => {
  test("the web attention API keeps task list totals independent of space placement", () => {
    const working = { key: "local:work", status: "working", live: [{ address: "worker" }, { address: "reviewer" }] };
    expect(taskCounts([{ key: "ask:1" }, { key: "ask:1" }, { key: "blocked:other" }], [working, working,
      { key: "remote:work", status: "work" }, { key: "ready", status: "ready" },
      { key: "archived", status: "ready", archived: true }, { key: "merging", status: "merging" },
    ])).toEqual({ need: 2, ready: 1, working: 2 });
    expect(taskCounts()).toEqual({ need: 0, ready: 0, working: 0 });
  });

  test("All spaces excludes unplaced items and respects the row count switches (SHEP-79)", () => {
    const state = new Map([
      ["inbox.tasks", [
        { kind: "stopped", folder: "/demo", ref: "T-1", tab: "tab1" },
        { kind: "stopped", folder: "/demo", ref: "T-2", space: "null" },
        { kind: "merge", folder: "/demo", ref: "T-3", tab: "tab1" },
      ]],
      ["inbox.statuses", [{ key: "T-3", status: "ready" }]],
    ]);
    const inbox = load("lib/inbox.js", {
      spaceTaskCounts, shared: (k) => state.get(k), terminals: () => [], panes: () => [],
      spaces: () => [{ id: "sp1", tabs: [{ id: "tab1" }] }],
    }, "({ statusCounts })");
    expect(inbox.statusCounts()).toEqual({ need: 1, ready: 1, working: 0 });
    state.set("counts.red", false);
    state.set("counts.green", false);
    expect(inbox.statusCounts()).toEqual({ need: 0, ready: 0, working: 0 });
  });
  test("one bucket per item across local and remote spaces, repeated pins, tabs and folders", () => {
    const local = { id: "sp1", folder: "/demo", tabs: [{ id: "tab1" }, { id: "tab1" }] };
    const remote = { id: "vm/sp1", machine: "vm", folder: "/demo", tabs: [{ id: "vm/tab1" }] };
    const need = { key: "ask:1", tab: "tab1" };
    const ready = { folder: "/demo", ref: "T-1", tab: "vm/tab1" };
    const work = { folder: "/demo", ref: "T-2", status: "working" };
    const result = spaceTaskCounts({ spaces: [local, remote, local, { id: "sp2", folder: "/demo" }],
      needs: [need, need, { key: "auto:1" }, { key: "provider:1", tab: "closed" }],
      ready: [ready, ready, { ...ready, ref: "T-3", space: "null", tab: null }, { ...ready, archived: true }],
      running: [work, work, { ...work, machine: "vm" }, { ...work, ref: "T-4", space: "gone" },
        { ...work, ref: "ready", status: "ready" }, { ...work, ref: "archived", archived: true }],
    });
    expect([...result.bySpace]).toEqual([
      ["sp1", { need: 1, ready: 0, working: 1 }],
      ["vm/sp1", { need: 0, ready: 1, working: 1 }],
      ["sp2", { need: 0, ready: 0, working: 0 }],
    ]);
    expect(result.total).toEqual({ need: 1, ready: 1, working: 2 });
    expect(result.elsewhere).toEqual({ need: 2, ready: 1, working: 1, count: 4, reasons: [
      { reason: "No tab in a space", count: 1 }, { reason: "Tab is no longer in a space", count: 1 },
      { reason: "Space is unavailable", count: 2 },
    ] });
    expect(spaceTaskCounts().total).toEqual({ need: 0, ready: 0, working: 0 });
  });

  test("inbox refresh moves the same task from Working to Ready to Needs you to zero", async () => {
    const refresh = inboxReplay();
    const task = { id: 1, ref: "T-1", state: "ready", live: [{ address: "a" }, { address: "b" }] };
    expect(await refresh([{ ...task, status: "working" }, { ...task, status: "working" }])).toEqual({ need: 0, ready: 0, working: 1 });
    expect(await refresh([{ ...task, status: "ready" }])).toEqual({ need: 0, ready: 1, working: 0 });
    expect(await refresh([{ ...task, state: "running", status: "stopped", needs: "stopped" }])).toEqual({ need: 1, ready: 0, working: 0 });
    expect(await refresh([{ ...task, state: "done", status: "done", archived: true, pull: { at: 1 } }])).toEqual({ need: 0, ready: 0, working: 0 });
    expect(refresh.items().map((item) => item.kind)).toEqual(["pull"]);
    expect(await refresh([])).toEqual({ need: 0, ready: 0, working: 0 });
  });

  test("both native consumers use the same totals for asks, providers, automations and work", () => {
    const spaces = [{ id: "sp1", folder: "/demo", tabs: [{ id: "tab1" }] },
      { id: "vm/sp1", machine: "vm", folder: "/demo", tabs: [{ id: "vm/tab1" }] }];
    const terminals = [
      { address: "assistant", state: "live", labels: { "herdr.role": "coordinator", "herdr.coordinator.space": "sp1" } },
      { address: "worker", state: "live", parent: "assistant", status: "blocked" },
      { address: "vm/provider", state: "live", labels: { "herdr.tab": "vm/tab1" } },
    ];
    const state = new Map([
      ["inbox.asks", [{ id: "worker.1.1", terminal: "worker" }]],
      ["inbox.provider", [{ terminal: "vm/provider", why: "Signed out" }]],
      ["inbox.autos", [{ id: "auto1", folder: "/demo" }]],
      ["inbox.tasks", [{ kind: "merge", folder: "/demo", ref: "T-1", tab: "vm/tab1" },
        { kind: "stopped", folder: "/demo", ref: "T-2", space: "null" }]],
      ["inbox.running", [{ ref: "T-3", space: "sp1", status: "working" },
        { ref: "T-4", machine: "vm", folder: "/demo", status: "working" },
        { ref: "T-5", space: "missing", status: "working" }]],
    ]);
    const inbox = load("lib/inbox.js", { spaceTaskCounts, chatPane, SH: "", shared: (k) => state.get(k), terminals: () => terminals,
      spaces: () => spaces, panes: () => [{ terminal: "assistant", pane: "pane1", tab: "tab1" }],
    }, "({ spaceStatusCounts })");
    const deps = { View: class {}, Menu: class {}, IconPicker: class {}, Rename: class {}, MachinePopup: class {},
      WORKTREE_RE: /worktrees/, SH: "", spacesWithChats: () => spaces, ...inbox };
    const Rows = load("mods/spaces-chat/main.js", deps, "Spaces");
    const rows = new Rows();
    const Status = load("mods/workspace-status-chat/main.js", { ...deps, div: tree, h_flex: tree, svg: tree,
      spaces: () => spaces, theme: () => ({}), shared: () => null, red: () => "red", green: () => "green", TEXT: {},
    }, "WorkspaceStatus");
    const bar = new Status();
    bar.width = 390;
    for (const red of [true, false]) for (const green of [true, false]) {
      state.set("counts.red", red); state.set("counts.green", green);
      const result = inbox.spaceStatusCounts();
      const sum = {
        need: spaces.reduce((n, s) => n + rows.needs(s), 0),
        ready: spaces.reduce((n, s) => n + rows.readyIn(s), 0),
        working: spaces.reduce((n, s) => n + rows.countsIn(s).working, 0),
      };
      expect(sum).toEqual({ need: red ? 2 : 0, ready: green ? 1 : 0, working: 2 });
      expect(result.total).toEqual(sum);
      expect(words(bar.draw())).toEqual([String(sum.need), "Needs you", String(sum.ready), "Ready", "2", "Working",
        `+${red ? 3 : 1} elsewhere`]);
      expect(result.elsewhere).toMatchObject({ need: red ? 2 : 0, ready: 0, working: 1 });
    }
  });

  test("native bottom bar keeps all labels and green Ready at zero and at narrow widths", () => {
    let counts = { need: 2, ready: 3, working: 4 };
    let elsewhere = { need: 0, ready: 0, working: 0, count: 0, reasons: [] };
    let opened = false;
    const Status = load("mods/workspace-status-chat/main.js", {
      View: class {}, div: tree, h_flex: tree, svg: tree, theme: () => ({ muted: "muted", dim: "dim", working: "amber" }),
      spaces: () => [], shared: () => null, spaceStatusCounts: () => ({ total: counts, elsewhere }), red: () => "red", green: () => "green", TEXT: {}, RADIUS: {},
      window: () => ({}), keys: () => [], showInbox: () => { opened = true; },
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
    elsewhere = { need: 1, ready: 1, working: 0, count: 2, reasons: [{ count: 2, reason: "Space is unavailable" }] };
    for (const width of [390, 1280]) {
      status.width = width;
      rendered = status.draw();
      const extra = byId(rendered, "status-elsewhere");
      expect(words(extra)).toEqual(["+2 elsewhere"]);
      expect(extra.style.text_color).toBe("dim");
      expect(extra.style.accessibility_label).toContain("2: Space is unavailable");
      expect(extra.style.accessibility_label).toContain("1 needs you, 1 ready, 0 working outside spaces");
      extra.style.on_click();
      expect(opened).toBe(true);
    }
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
