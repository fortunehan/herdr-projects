import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const load = (file, deps, name) => new Function(...Object.keys(deps), `${read(file)
  .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export (default )?/gm, "")}\nreturn ${name};`)(...Object.values(deps));

function element() {
  const node = { style: {}, kids: [] };
  const self = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "child") return (child) => { node.kids.push(child); return self; };
    if (key === "children") return (children) => { node.kids.push(...children); return self; };
    if (key === "when") return (on, fn) => on ? fn(self) : self;
    return (...args) => { node.style[key] = args.length === 1 ? args[0] : args; return self; };
  } });
  return self;
}
const nodes = (n) => n && typeof n === "object" ? [n, ...n.kids.flatMap(nodes)] : [];
const words = (n) => typeof n === "object" ? n.kids.flatMap(words) : [n];

function fixture() {
  const state = new Map(), calls = [];
  const tabs = [{ id: "a", name: "Assistant", active: true }, { id: "b", name: "Panel", active: false }];
  let need = 12, ready = 3;
  const deps = {
    View: class {}, div: element, h_flex: element, svg: element, image: element,
    shared: (k) => state.get(k), settings: () => ({}), red: () => "red", green: () => "green",
    theme: () => ({ chrome: "chrome", raised: "raised", border: "border" }),
    TEXT: { id: 11 }, H: { sm: 24 }, RADIUS: {}, spaces: () => [{ id: "s1", active: true, tabs }],
    panes: () => [], isCoordinatorTab: () => false, tabName: (name) => name,
    countsByTab: () => new Map([["a", need], ["b", 2], ["elsewhere", 99]]),
    readyByTab: () => new Map([["a", ready]]),
    layout: () => null, window: () => ({}), addonOn: () => false,
    serveRemote() {}, tickOnChange() {}, watchNewSpaces() {}, run: (...args) => calls.push(args),
  };
  deps.spaceCounts = load("lib/ui.js", { div: element, h_flex: element, settings: () => ({ dark: true }) }, "spaceCounts");
  const Tabs = load("mods/tabs-tasks/main.js", deps, "Tabs");
  const bar = new Tabs();
  bar.pressed = null;
  bar.syncPanel = () => {};
  const render = () => bar.draw({});
  return { render, state, calls, setCounts: (n, r) => { need = n; ready = r; }, spaceCounts: deps.spaceCounts };
}

function counts(tab) {
  return nodes(tab).find((n) => n.style.accessibility_label);
}
const tab = (root, id) => nodes(root).find((n) => n.style.id === `tab-${id}`);

describe("Panel tab counts match Spaces (SHEP-77)", () => {
  test("selected and unselected tabs reuse plain colored numbers with exact accessible counts", () => {
    const f = fixture(), root = f.render();
    for (const [id, need, ready] of [["a", 12, 3], ["b", 2, 0]]) {
      const rendered = tab(root, id), c = counts(rendered);
      expect(c).toBeDefined();
      expect(c).toEqual(f.spaceCounts(need, ready));
      expect(c.style).toMatchObject({ h: 16, text_size: 11, font_bold: [], flex_none: [], gap: 8, role: "image" });
      expect(c.style.accessibility_label).toBe(`${need} needs you, ${ready} ready`);
      expect(words(c)).toEqual(ready ? ["9+", "3"] : ["2"]);
      expect(c.kids.map((n) => n.style.text_color)).toEqual(ready ? ["#ff6369", "#3dd68c"] : ["#ff6369"]);
      expect(nodes(c).some((n) => "bg" in n.style || "rounded" in n.style)).toBe(false);
      expect(words(rendered)).toContain(id === "a" ? "Assistant" : "Panel");
      rendered.style.on_mouse_up[1]();
      expect(f.calls.at(-1)).toEqual(["tab.select", { id }]);
      expect(rendered.style.on_mouse_down[0]).toBe("right");
    }
  });

  test("zeros, independent caps, count settings and hidden tabs retain their visibility rules", () => {
    const f = fixture();
    for (const [need, ready, visible] of [[0, 0, null], [2, 0, ["2"]], [0, 12, ["9+"]], [12, 12, ["9+", "9+"]]]) {
      f.setCounts(need, ready);
      const c = counts(tab(f.render(), "a"));
      expect(c ? words(c) : null).toEqual(visible);
    }
    f.state.set("counts.red", false);
    expect(words(counts(tab(f.render(), "a")))).toEqual(["9+"]);
    f.state.set("counts.red", true);
    f.state.set("counts.green", false);
    expect(words(counts(tab(f.render(), "a")))).toEqual(["9+"]);
    f.state.set("counts.red", false);
    expect(counts(tab(f.render(), "a"))).toBeUndefined();
    f.state.set("tabbar.tabs", false);
    expect(tab(f.render(), "a")).toBeUndefined();
  });
});
