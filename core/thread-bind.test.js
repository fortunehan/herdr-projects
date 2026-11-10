import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as bind from "./thread-bind.js";
import { RETRY_MS, STUCK_MS, ThreadBinding, followed, sameTask, threadId } from "./thread-bind.js";

const SHEP15 = { terminal: "t2p", task: "SHEP-15", title: "Cmd+Shift+L focuses the composer", key: { machine: null, folder: "/s", slug: "s", id: 15 } };
const MD1 = { terminal: "t2n", task: "MD-1", title: "Design: link Mobile Apps Info", key: { machine: null, folder: "/m", slug: "m", id: 1 } };

describe("threadId and sameTask", () => {
  test("a task is its agent's terminal, else its key", () => {
    expect(threadId(SHEP15)).toBe("t:t2p");
    expect(threadId({ terminal: null, key: { machine: "vm", slug: "s", id: 3 } })).toBe("k:vm:s#3");
    expect(threadId(null)).toBe(null);
  });

  test("a resumed task is the same task under a new terminal; another space's task is not", () => {
    expect(sameTask(SHEP15, { ...SHEP15, terminal: "t9" })).toBe(true);
    expect(sameTask(SHEP15, MD1)).toBe(false);
    expect(sameTask({ terminal: "t1", task: "A-1" }, { terminal: "t1", task: "A-1" })).toBe(true);
    expect(sameTask({ terminal: "t1", task: "A-1" }, { terminal: "t2", task: "B-1" })).toBe(false);
  });
});

describe("the body draws a Chat only for the task the header names", () => {
  test("its Chat was made for MD-1 and SHEP-15 is asked for: not shown, a swap asked for", () => {
    const b = new ThreadBinding();
    const n = b.begin(0);
    b.end(n, MD1, true, 0);
    expect(b.plan(MD1, 10)).toEqual({ show: true, ask: false });
    expect(b.plan(SHEP15, 20)).toEqual({ show: false, ask: true });
  });

  test("a swap asked for that never started (a render Herdr stopped) is asked for again after RETRY_MS", () => {
    const b = new ThreadBinding();
    expect(b.plan(SHEP15, 0).ask).toBe(true);
    expect(b.plan(SHEP15, RETRY_MS - 1)).toEqual({ show: false, ask: false });
    expect(b.plan(SHEP15, RETRY_MS)).toEqual({ show: false, ask: true });
  });

  test("another task asked for while the first swap waits is asked for at once", () => {
    const b = new ThreadBinding();
    expect(b.plan(MD1, 0).ask).toBe(true);
    expect(b.plan(SHEP15, 1).ask).toBe(true);
  });

  test("one swap at a time; one stuck past STUCK_MS gives way, and its late end changes nothing", () => {
    const b = new ThreadBinding();
    const first = b.begin(0);
    expect(b.begin(1)).toBe(null);
    expect(b.plan(SHEP15, 2).ask).toBe(false);
    const second = b.begin(STUCK_MS);
    expect(second).not.toBe(null);
    expect(b.current(first)).toBe(false);
    expect(b.end(first, MD1, true, STUCK_MS + 1)).toBe(false);
    expect(b.cur).toBe(null);
    expect(b.end(second, SHEP15, true, STUCK_MS + 2)).toBe(true);
    expect(b.plan(SHEP15, STUCK_MS + 3)).toEqual({ show: true, ask: false });
  });

  test("a swap that failed shows nothing and is tried again after RETRY_MS, not on every render", () => {
    const b = new ThreadBinding();
    b.plan(SHEP15, 0);
    const n = b.begin(0);
    b.end(n, SHEP15, false, 5);
    expect(b.plan(SHEP15, 6)).toEqual({ show: false, ask: false });
    expect(b.plan(SHEP15, 5 + RETRY_MS).ask).toBe(true);
  });
});

describe("a Resume or model switch follows its own task only", () => {
  test("still showing the task: its new agent", () => {
    expect(followed(SHEP15, SHEP15, "t3", 7)).toEqual({ ...SHEP15, terminal: "t3", log: null, note: null, at: 7 });
  });

  test("the person opened another space's task meanwhile: theirs stays as it is", () => {
    expect(followed(SHEP15, MD1, "t3", 7)).toBe(null);
  });

  test("a task without a key (a chip's thread) goes by its id and terminal", () => {
    const a = { terminal: "t1", task: "A-1", title: "a" }, b = { terminal: "t2", task: "B-1", title: "b" };
    expect(followed(a, a, "t5", 1)?.terminal).toBe("t5");
    expect(followed(b, a, "t5", 1)).toBe(null);
  });
});

// The Tasks panel's body itself (mods/chat/panel.js PanelHost), run against stand-ins for Herdr and GPUI: the real
// render and swap. PANEL_SRC runs another version of the file (main's, to see the bug).
const PANEL = process.env.PANEL_SRC ?? new URL("../mods/chat/panel.js", import.meta.url);
function loadPanel(state) {
  const mk = () => { const node = { kids: [] }; const proxy = new Proxy(node, { get: (o, k) => (k === "kids" ? o.kids : k === "child" ? (c) => { o.kids.push(c); return proxy; } : () => proxy) }); return proxy; };
  const herdr = {
    shared: (k) => state.shared.get(k) ?? null, setShared: (k, v) => state.shared.set(k, v), run: () => null,
    theme: () => ({}), exec: async () => ({ code: 0, stdout: "", stderr: "" }), appHome: () => "/x", home: () => "/h",
    readTextFile: async () => null, writeTextFile: async () => null, notify: () => null, layout: () => ({}), openOverlay: () => null,
  };
  const mods = {
    "gpui-kit": { div: mk, svg: mk }, "gpui-base": { h_flex: mk, v_flex: mk }, herdr,
    "./live.js": { terminals: () => [], agents: () => [] },
    "./core/thread-bind.js": bind,
    "./dirs.js": { dirs: () => ({ tasks: "/h/tasks" }) },
    "./core/paths.js": { SH: "" },
  };
  const names = [], values = [];
  const src = readFileSync(PANEL, "utf8").replace(/^import \{([^}]*)\} from "([^"]+)";$/gm, (_m, list, from) => {
    for (const part of list.split(",").map((x) => x.trim()).filter(Boolean)) {
      const [name, as] = part.split(/\s+as\s+/);
      names.push(as ?? name);
      values.push(mods[from]?.[name] ?? (() => null));
    }
    return "";
  }).replace(/^export /gm, "");
  return new Function(...names, `${src}\nreturn { PanelHost, inner };`)(...values);
}

// A window's worth of the body: its renders, the timers they set and the tasks those spawn.
function window_() {
  const state = { shared: new Map(), timers: [], made: [] };
  const { PanelHost } = loadPanel(state);
  const cx = {
    timer: { after: (ms, fn) => { state.timers.push({ due: Date.now() + ms, fn }); }, every: () => null },
    spawn: (fn) => fn(cx), notify: () => null,
    new: (_C, props) => { const e = { props, released: false, release() { e.released = true; } }; state.made.push(e); return e; },
  };
  const host = new PanelHost(function Chat() {}, false);
  const shown = () => {
    const tree = host.renderBody(cx);
    const e = tree.kids.find((k) => k && typeof k === "object" && "props" in k);
    return e ? e.props.terminal : tree.kids.find((k) => typeof k === "string") ?? null;
  };
  const tick = async (ms = 0) => {
    setSystemTime(new Date(Date.now() + ms));
    const due = state.timers.filter((t) => t.due <= Date.now());
    state.timers = state.timers.filter((t) => t.due > Date.now());
    for (const t of due) await t.fn(cx);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { state, host, shown, tick, open: (w) => state.shared.set("tasks.thread", { ...w, at: Date.now() }) };
}

describe("the Tasks panel's task chat (panel.js), SHEP-16", () => {
  afterEach(() => setSystemTime());

  test("MD-1 shown, then SHEP-15 opened while that render is stopped: SHEP-15's chat never shows MD-1's agent", async () => {
    setSystemTime(new Date(1_000_000));
    const w = window_();
    w.open(MD1);
    w.shown();
    await w.tick();
    expect(w.shown()).toBe("t2n");
    w.open(SHEP15);
    // Herdr stopped this render (its 50 ms): what it set going never runs.
    w.shown();
    w.state.timers = [];
    // Live data changes redraw the body again and again (an agent's status each second).
    for (let i = 0; i < 5; i++) {
      expect(w.shown()).not.toBe("t2n");
      await w.tick(1000);
    }
    expect(w.shown()).toBe("t2p");
    expect(w.state.made.find((e) => e.props.terminal === "t2n").released).toBe(true);
  });

  test("switching on while the old chat still closes ends on the task asked for last", async () => {
    setSystemTime(new Date(2_000_000));
    const w = window_();
    w.open(MD1);
    w.shown();
    await w.tick();
    const C = { terminal: "t3", task: "C-1", title: "c", key: { machine: null, folder: "/c", slug: "c", id: 1 } };
    w.open(SHEP15);
    w.shown();
    w.open(C);
    for (let i = 0; i < 4; i++) { w.shown(); await w.tick(RETRY_MS); }
    expect(w.shown()).toBe("t3");
    expect(w.host.cur.task).toBe("C-1");
  });

  test("a release that throws doesn't leave the body stuck", async () => {
    setSystemTime(new Date(3_000_000));
    const w = window_();
    w.open(MD1);
    w.shown();
    await w.tick();
    w.state.made[0].release = () => { throw new Error("already released"); };
    w.open(SHEP15);
    for (let i = 0; i < 3; i++) { w.shown(); await w.tick(RETRY_MS); }
    expect(w.shown()).toBe("t2p");
  });
});
