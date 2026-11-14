import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../mods/pane-chat/main.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default class Pane", "class Pane");
const spacesSource = readFileSync(new URL("./spaces.js", import.meta.url), "utf8")
  .split("// A space's Assistant:")[0].replace(/^export /gm, "").replace(/\bCHAT\b/g, "CHAT_LABEL");

/** Run the actual header and popup handlers with isolated live lists; no global Herdr mock. */
function harness() {
  const state = { props: { pane: "p-clicked" }, panes: [], terminals: [], shared: {}, clipboard: [], notices: [], commands: [], overlays: [], closed: [] };
  function element() {
    const data = { nodes: [], handlers: {} };
    const el = new Proxy(data, { get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === "child") data.nodes.push(args[0]);
        else if (key === "children") data.nodes.push(...args[0]);
        else if (key === "when") { if (args[0]) args[1](el); }
        else if (key.startsWith("on_")) data.handlers[key] = args.at(-1);
        else data[key === "id" ? "elementId" : key === "tooltip" ? "tip" : `style_${key}`] = args;
        return el;
      };
    } });
    return el;
  }
  const env = {
    View: class {}, div: element, svg: element, image: element, h_flex: element, v_flex: element,
    props: () => state.props, panes: () => state.panes, terminals: () => state.terminals,
    spaces: () => [], shared: (key) => state.shared[key], setShared: () => {},
    theme: () => ({}), home: () => "/opt/test-home", inRender: (fn) => fn(),
    run: (...args) => state.commands.push(args), notify: (n) => state.notices.push(n),
    openOverlay: (spec) => state.overlays.push(spec), closeOverlay: (id) => state.closed.push(id),
    addonOn: () => false, apWatch: () => {}, COMPACT_BELOW: 500, CODE_VIEW: "code-view",
    codeOfPane: () => null, baseName: (file) => file?.split("/").at(-1),
    TEXT: { label: 12 }, RADIUS: { control: 6 }, agentTitle: (_, prog) => prog,
    spaceName: () => "Assistant", plainError: (e) => e.message,
    segmented: () => element(),
    menuRow: (id, label, { disabled, onClick }) => element().id(id).child(label)
      .when(!disabled, (el) => el.on_click(onClick)),
  };
  const Pane = new Function("env", `const {${Object.keys(env).join(",")}} = env;\n${spacesSource}\n${source}\nreturn Pane;`)(env);
  const view = new Pane();
  const cx = { stop_propagation: () => {}, notify: () => {},
    write_to_clipboard: (text) => state.clipboard.push(text), focus_handle: () => ({ focus() {} }) };
  function find(el, id) {
    if (!el || typeof el !== "object") return null;
    if (el.elementId?.[0] === id) return el;
    for (const child of el.nodes ?? []) { const found = find(child, id); if (found) return found; }
    return null;
  }
  function render() { return view.render(cx); }
  function click(el) { expect(el?.handlers.on_click).toBeFunction(); el.handlers.on_click({}, cx); }
  function menu() { state.props = { copyPane: "p-clicked", overlay: "copy-popup" }; view.init({}, cx); return render(); }
  function action(key) { click(find(render(), `ph-copy-${key}`)); }
  return { state, view, cx, render, find, click, menu, action };
}

function terminal(h, { address = "t-clicked", cwd = "/opt/test-home/project", foreground, state = "live" } = {}) {
  const pane = { pane: "p-clicked", terminal: address, cwd, title: "Shell", program: { shell: true, name: "Shell" }, focused: false };
  const record = { address, cwd, foreground, state };
  h.state.panes.push(pane);
  h.state.terminals.push(record);
  return { pane, record };
}

function chat(h, { address = "remote/t-agent", pane = "remote/p-chat", cwd = "/srv/work" } = {}) {
  h.state.panes.push({ pane, mod: "chat" });
  const record = { address, state: "live", labels: { "herdr.chat": pane.split("/").at(-1) }, cwd, foreground: { cwd: `${cwd}/foreground` } };
  h.state.terminals.push(record);
  h.state.props = { copyPane: pane, overlay: "copy-popup" };
  h.view.init({}, h.cx);
  return record;
}

describe("desktop pane copy menu", () => {
  test("the unfocused clicked header opens its own compact menu and leaves focus alone", () => {
    const h = harness(); terminal(h);
    h.state.panes.push({ pane: "p-focused", terminal: "t-focused", cwd: "/other", focused: true });
    const tree = h.render();
    const button = h.find(tree, "ph-copy-p-clicked");
    expect(button.tip).toEqual(["Copy terminal ID or full path"]);
    expect(button.style_size).toEqual([24]);
    h.click(button);
    expect(h.state.overlays[0]).toMatchObject({ mod: "pane-chat", kind: "popup", props: { copyPane: "p-clicked" } });
    h.menu(); h.action("id");
    expect(h.state.clipboard).toEqual(["t-clicked"]);
    expect(h.state.commands).toEqual([]);
    expect(h.state.closed).toEqual(["copy-popup"]);
    expect(h.state.notices[0]).toMatchObject({ title: "Terminal ID copied", level: "success", timeout: 1600 });
  });

  test("paths preserve home, spaces, Unicode, and long directory names in full", () => {
    const h = harness();
    const cwd = `/opt/test-home/Project files/中文/${"long-directory/".repeat(35)}end`;
    terminal(h, { cwd }); h.menu(); h.action("path");
    expect(h.state.clipboard).toEqual([cwd]);
  });

  test("a directory change after menu rendering is resolved on selection", () => {
    const h = harness(); const { record } = terminal(h); const tree = h.menu();
    record.foreground = { cwd: "/new/current/directory" };
    h.click(h.find(tree, "ph-copy-path"));
    expect(h.state.clipboard).toEqual(["/new/current/directory"]);
  });

  test("combined text labels the remote terminal address and its remote foreground cwd", () => {
    const h = harness(); terminal(h, { address: "build-machine/t7", cwd: "/srv/remote-home", foreground: { cwd: "/srv/remote repo" } });
    h.menu(); h.action("both");
    expect(h.state.clipboard).toEqual(["Terminal: build-machine/t7\nPath: /srv/remote repo"]);
  });

  test("remote Chat resolves the live parked terminal using machine-qualified chat labels", () => {
    const h = harness();
    h.state.terminals.push({ address: "t-local", state: "live", labels: { "herdr.chat": "p-chat" }, cwd: "/wrong-machine" });
    chat(h); h.action("both");
    expect(h.state.clipboard).toEqual(["Terminal: remote/t-agent\nPath: /srv/work/foreground"]);
  });

  test("Chat re-resolves a replacement agent after the menu opens", () => {
    const h = harness(); const old = chat(h); const tree = h.render(); old.state = "exited";
    h.state.terminals.push({ address: "remote/t-new", state: "live", labels: { "herdr.chat": "p-chat" }, cwd: "/srv/new" });
    h.click(h.find(tree, "ph-copy-both"));
    expect(h.state.clipboard).toEqual(["Terminal: remote/t-new\nPath: /srv/new"]);
  });

  test("a Terminal to Chat swap under the clicked pane resolves its associated agent", () => {
    const h = harness(); const { pane, record } = terminal(h); const tree = h.menu();
    pane.mod = "chat"; pane.terminal = null; record.labels = { "herdr.chat": "p-clicked" };
    h.click(h.find(tree, "ph-copy-both"));
    expect(h.state.clipboard).toEqual(["Terminal: t-clicked\nPath: /opt/test-home/project"]);
  });

  test("a Chat to Terminal swap re-resolves the pane's current terminal", () => {
    const h = harness(); chat(h, { address: "t-old", pane: "p-clicked" }); const tree = h.render();
    h.state.panes[0] = { pane: "p-clicked", terminal: "t-new" };
    h.state.terminals.push({ address: "t-new", state: "live", cwd: "/new" });
    h.click(h.find(tree, "ph-copy-both"));
    expect(h.state.clipboard).toEqual(["Terminal: t-new\nPath: /new"]);
  });

  test("lazy Assistant actions stay disabled until a live backing terminal appears", () => {
    const h = harness(); h.state.panes.push({ pane: "p-clicked", mod: "chat" });
    h.state.shared["coordinator.slots"] = { assistant: { pane: "p-clicked", folder: "/configured/not-live" } };
    expect(h.find(h.render(), "ph-copy-p-clicked")).not.toBeNull();
    const tree = h.menu();
    for (const key of ["id", "path", "both"]) expect(h.find(tree, `ph-copy-${key}`).handlers.on_click).toBeUndefined();
    h.state.terminals.push({ address: "t-started", state: "live", cwd: "/actual", labels: { "herdr.chat": "p-clicked" } });
    h.action("both"); expect(h.state.clipboard).toEqual(["Terminal: t-started\nPath: /actual"]);
  });

  test("missing or nonabsolute cwd disables path actions but keeps the terminal ID", () => {
    for (const cwd of [null, "", "~/repo", "relative/repo"]) {
      const h = harness(); terminal(h, { cwd }); const tree = h.menu();
      for (const key of ["path", "both"]) expect(h.find(tree, `ph-copy-${key}`).handlers.on_click).toBeUndefined();
      h.action("id"); expect(h.state.clipboard).toEqual(["t-clicked"]);
    }
  });

  test("Windows drive and UNC absolute cwd values are preserved", () => {
    for (const cwd of ["C:\\Users\\Test Person\\repo", "D:/work/project", "\\\\server\\share\\repo"]) {
      const h = harness(); terminal(h, { cwd }); h.menu(); h.action("path");
      expect(h.state.clipboard).toEqual([cwd]);
    }
  });

  test("an exited or missing terminal and a closed pane cannot copy stale values", () => {
    for (const change of [h => { h.state.terminals[0].state = "exited"; }, h => { h.state.terminals = []; }, h => { h.state.panes = []; }]) {
      const h = harness(); terminal(h); const tree = h.menu(); change(h);
      h.click(h.find(tree, "ph-copy-both"));
      expect(h.state.clipboard).toEqual([]);
      expect(h.state.notices[0]).toMatchObject({ title: "Couldn't copy", level: "warning" });
    }
  });

  test("cwd disappearing after rendering reports unavailability without copying", () => {
    const h = harness(); const { record } = terminal(h); const tree = h.menu(); record.cwd = null;
    h.click(h.find(tree, "ph-copy-path")); expect(h.state.clipboard).toEqual([]);
    expect(h.state.notices[0].body).toContain("full path is unavailable");
  });

  test("artifact and code panes do not offer terminal copy actions", () => {
    for (const mod of ["art-proof", "code-view", "other-mod"]) {
      const h = harness(); h.state.panes.push({ pane: "p-clicked", mod, title: "File", cwd: "/a/file", terminal: "not-a-terminal" });
      expect(h.find(h.render(), "ph-copy-p-clicked")).toBeNull();
    }
  });

  test("clipboard errors report failure without success feedback", () => {
    const h = harness(); terminal(h); h.menu();
    h.cx.write_to_clipboard = () => { throw new Error("Clipboard unavailable"); };
    h.action("id");
    expect(h.state.notices).toEqual([{ title: "Couldn't copy", body: "Clipboard unavailable", level: "error" }]);
    expect(h.state.closed).toEqual([]);
  });

  test("popup keyboard actions skip disabled paths and Escape closes the popup", () => {
    const h = harness(); terminal(h, { cwd: null }); const tree = h.menu();
    tree.handlers.on_key_down({ key: "down" }, h.cx);
    tree.handlers.on_key_down({ key: "enter" }, h.cx);
    expect(h.state.clipboard).toEqual(["t-clicked"]);
    tree.handlers.on_key_down({ key: "escape" }, h.cx);
    expect(h.state.closed).toEqual(["copy-popup", "copy-popup"]);
  });

  test("existing header split, zoom, close and click-to-focus retain explicit targets", () => {
    const h = harness(); terminal(h); h.view.hovered = true; h.view.width = 320; const tree = h.render();
    for (const key of ["r", "d", "z", "x"]) h.click(h.find(tree, `ph-${key}-p-clicked`));
    h.click(tree);
    expect(h.state.commands).toEqual([
      ["pane.split", { direction: "right", pane: "p-clicked" }], ["pane.split", { direction: "down", pane: "p-clicked" }],
      ["pane.zoom", { pane: "p-clicked" }], ["pane.close", { pane: "p-clicked" }], ["pane.focus", { pane: "p-clicked" }],
    ]);
    expect(h.find(tree, "ph-copy-p-clicked")).not.toBeNull();
  });
});
