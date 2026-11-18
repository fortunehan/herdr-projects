import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spaceTaskCounts } from "./task-counts.js";

const bare = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export (default )?/gm, "");
const load = (file, deps, result) => new Function(...Object.keys(deps), `${bare(file)}\nreturn ${result};`)(...Object.values(deps));

function element(kind = "div") {
  const node = { kind, style: {}, children: [] };
  const proxy = new Proxy(node, { get(target, k) {
    if (k in target) return target[k];
    if (k === "child") return (child) => { node.children.push(child); return proxy; };
    if (k === "when") return (on, f) => on ? f(proxy) : proxy;
    return (...args) => { node.style[k] = args[0] ?? true; return proxy; };
  } });
  return proxy;
}
const nodes = (n) => typeof n === "object" ? [n, ...n.children.flatMap(nodes)] : [];
const words = (n) => typeof n === "object" ? n.children.flatMap(words) : [n];
const t = { dim: "gray", working: "yellow", chrome: "chrome", selected: "selected", hover: "hover" };

function fixture() {
  const state = new Map();
  const deps = {
    Menu: class {}, Rename: class {}, IconPicker: class {}, MachinePopup: class {}, WORKTREE_RE: /worktrees/,
    spacesWithChats: () => [],
    View: class {}, div: () => element(), h_flex: () => element("h_flex"), v_flex: () => element("v_flex"),
    svg: (path) => { const e = element("svg"); e.style.path = path; return e; },
    shared: (k) => state.get(k), settings: () => ({}), red: () => "red", green: () => "green",
    TEXT: { id: 11, label: 12 }, RADIUS: { card: 8 }, onStatus: () => "black",
    spaceStatusCounts: () => spaceTaskCounts({ spaces: [w],
      needs: Array.from({ length: 5 }, (_, key) => ({ key, tab: key < 2 ? "a" : "b" })),
      ready: Array.from({ length: 3 }, (_, key) => ({ key, tab: key < 1 ? "a" : "b" })),
      running: state.get("inbox.running") ?? [], red: state.get("counts.red") !== false, green: state.get("counts.green") !== false }),
    muted: () => false, iconOf: () => null, data: () => state.get("spaces-chat") ?? {},
  };
  deps.spaceCounts = load("lib/ui.js", { div: deps.div, h_flex: deps.h_flex, settings: () => ({ dark: true }) }, "spaceCounts");
  const Spaces = load("mods/spaces-chat/main.js", deps, "Spaces");
  const s = new Spaces();
  Object.assign(s, { unread: new Set(), pressed: null });
  const w = { id: "s1", active: false, tabs: [{ id: "a" }, { id: "b" }], folder: "/demo" };
  const row = (active = false) => s.row({ w: { ...w, active }, name: "Long space name", i: 0 }, t);
  return { s, state, w, row };
}

const counts = (root) => nodes(root).find((n) => n.style.accessibility_label === "5 needs you, 3 ready");
function plain(root) {
  const c = counts(root);
  expect(c).toBeDefined();
  expect(words(c)).toEqual(["5", "3"]);
  expect(c.style.text_size).toBe(11);
  expect(c.style.font_bold).toBe(true);
  expect(c.style.role).toBe("image");
  expect(c.style.flex_none).toBe(true);
  expect(c.children.map((n) => n.style.text_color)).toEqual(["#ff6369", "#3dd68c"]);
  expect(nodes(c).some((n) => "bg" in n.style || "rounded" in n.style)).toBe(false);
}

describe("Spaces status counts (SHEP-71)", () => {
  test("selected and unselected rows use bold plain numbers without visible status labels", () => {
    const { row } = fixture();
    for (const active of [false, true]) {
      const rendered = row(active);
      plain(rendered);
      expect(rendered.style.bg).toBe(active ? "selected" : undefined);
      expect(Boolean(rendered.style.hover)).toBe(!active);
      expect(rendered.style.h).toBe(30);
      expect(nodes(rendered).some((n) => n.style.min_w === 0 && n.children.some((c) => c?.style?.truncate))).toBe(true);
      expect(rendered.style.on_mouse_down).toBeDefined();
      expect(rendered.style.on_mouse_move).toBeDefined();
    }
  });

  test("tab scoping, settings, hidden zeros and independently capped counts stay intact", () => {
    const { s, state, w, row } = fixture();
    expect(s.needs(w)).toBe(5);
    expect(s.readyIn(w)).toBe(3);
    state.set("counts.red", false);
    expect(s.needs(w)).toBe(0);
    expect(words(row())).not.toContain("5");
    state.set("counts.green", false);
    expect(s.readyIn(w)).toBe(0);
    expect(nodes(row()).some((n) => n.style.accessibility_label)).toBe(false);
    s.needs = () => 12; s.readyIn = () => 1;
    const capped = nodes(row()).find((n) => n.style.accessibility_label === "12 needs you, 1 ready");
    expect(words(capped)).toEqual(["9+", "1"]);
  });

  test("folded section and Pinned totals share the row style; open headings hide totals", () => {
    const { s, state, w } = fixture();
    const members = [{ w, name: "Space" }];
    plain(s.sectionHead({ id: "group", name: "Group" }, members, t, false));
    expect(counts(s.sectionHead({ id: "group", name: "Group" }, members, t, true))).toBeUndefined();
    state.set("spaces-chat", { pinnedFolded: true });
    plain(s.pinned(members, [w.id], false, t)[0]);
    state.set("spaces-chat", { pinnedFolded: false });
    expect(counts(s.pinned(members, [w.id], false, t)[0])).toBeUndefined();
  });

  test("Working keeps its ring, duration, size, cap and position while both children inherit yellow", () => {
    const { s, state, w, row } = fixture();
    expect(s.workingMark(w, t)).toBeNull();
    state.set("inbox.running", [
      ...Array.from({ length: 12 }, (_, ref) => ({ ref, space: w.id, status: "working" })),
      { space: "other", status: "working" }, { space: w.id, status: "ready" },
      { space: w.id, status: "working", archived: 1 },
    ]);
    const mark = s.workingMark(w, t);
    expect(mark.style.text_color).toBe("yellow");
    expect(mark.style.text_size).toBe(12);
    expect(mark.style.gap).toBe(3);
    expect(words(mark)).toEqual(["9+"]);
    expect(mark.children[0].style).toMatchObject({ path: "mods/tasks/merging.svg", size: 10, spin: 1400 });
    expect(mark.children.every((n) => !("text_color" in n.style))).toBe(true);
    const rendered = row();
    const siblings = nodes(rendered).find((n) => n.children.some((c) => c?.style?.id === "working-s1")).children;
    expect(siblings.at(-2).style.id).toBe("working-s1");
    expect(siblings.at(-1)).toBe(counts(rendered));
  });
});
