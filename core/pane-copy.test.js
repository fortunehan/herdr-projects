import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../mods/pane-chat/main.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default class Pane", "class Pane");
const spacesSource = readFileSync(new URL("./spaces.js", import.meta.url), "utf8")
  .split("// A space's Assistant:")[0].replace(/^export /gm, "").replace(/\bCHAT\b/g, "CHAT_LABEL");

/** Exercise real header handlers with isolated live data, clipboard and application dispatch. */
function harness() {
  const state = { props: { pane: "p-clicked" }, panes: [], terminals: [], shared: {}, clipboard: [], notices: [], commands: [], overlays: [], closed: [], executions: [], jobs: [], platform: "macos", app: "/Applications/Chosen Terminal.app" };
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
    View: class {}, div: element, svg: (path) => { const el = element(); el.asset = path; return el; }, image: element, h_flex: element, v_flex: element,
    props: () => state.props, panes: () => state.panes, terminals: () => state.terminals,
    spaces: () => [], shared: (key) => state.shared[key], setShared: () => {},
    theme: () => ({}), home: () => "/opt/test-home", inRender: (fn) => fn(), window: () => ({ platform: state.platform }),
    run: (...args) => state.commands.push(args), notify: (n) => state.notices.push(n),
    exec: async (...args) => {
      state.executions.push(args);
      return state.exec ? state.exec(...args) : { code: 0, stdout: args[0] === "/usr/bin/osascript" ? JSON.stringify(state.app) : "", stderr: "" };
    },
    openOverlay: (spec) => state.overlays.push(spec), closeOverlay: (id) => state.closed.push(id),
    addonOn: () => state.autopilot ?? false, apWatch: () => {}, apSpace: () => ({}), apHeartbeatLink: () => element().id("heartbeat"), apGroup: () => element().id("autopilot"), COMPACT_BELOW: 500, CODE_VIEW: "code-view",
    codeOfPane: () => null, baseName: (file) => file?.split("/").at(-1),
    TEXT: { label: 12 }, RADIUS: { control: 6 }, agentTitle: (_, prog) => prog,
    spaceName: () => "Assistant", plainError: (e) => e.message,
    segmented: (id) => element().id(id), uiButton: (id) => element().id(id), endAgent: () => ({ ask: "End agent?", cancel: "Cancel", verb: "End agent" }),
    menuRow: (id, label, { disabled, onClick }) => element().id(id).child(label)
      .when(!disabled, (el) => el.on_click(onClick)),
  };
  const Pane = new Function("env", `const {${Object.keys(env).join(",")}} = env;\n${spacesSource}\n${source}\nreturn Pane;`)(env);
  const view = new Pane(); view.hovered = true;
  const cx = { stop_propagation: () => {}, notify: () => {},
    spawn: (fn) => state.jobs.push(fn(cx)),
    write_to_clipboard: (text) => state.clipboard.push(text), focus_handle: () => ({ focus() {} }) };
  function find(el, id) {
    if (!el || typeof el !== "object") return null;
    if (el.elementId?.[0] === id) return el;
    for (const child of el.nodes ?? []) { const found = find(child, id); if (found) return found; }
    return null;
  }
  function render() { return view.render(cx); }
  function click(el) { expect(el?.handlers.on_click).toBeFunction(); el.handlers.on_click({}, cx); }
  function menu(pane = "p-clicked") { state.props = { openPane: pane, overlay: "open-popup" }; view.init({}, cx); return render(); }
  function copy(key, pane = "p-clicked") { click(find(render(), `ph-copy-${key}-${pane}`)); }
  async function open(key, tree = menu()) { click(find(tree, `ph-open-${key}`)); await Promise.all(state.jobs); }
  return { state, view, cx, render, find, click, menu, copy, open };
}

function terminal(h, { address = "t-clicked", cwd = "/opt/test-home/project", foreground, state = "live" } = {}) {
  const pane = { pane: "p-clicked", terminal: address, cwd, title: "Shell", program: { shell: true, name: "Shell" }, focused: false };
  const record = { address, cwd, foreground, state };
  h.state.panes.push(pane); h.state.terminals.push(record);
  return { pane, record };
}

function chat(h, { address = "remote/t-agent", pane = "remote/p-chat", cwd = "/srv/work" } = {}) {
  h.state.panes.push({ pane, mod: "chat" });
  const record = { address, state: "live", labels: { "herdr.chat": pane.split("/").at(-1) }, cwd, foreground: { cwd: `${cwd}/foreground` } };
  h.state.terminals.push(record); h.state.props = { pane };
  return record;
}

const actions = ["terminal", "vscode", "finder", "xcode"];

describe("desktop pane direct copy", () => {
  test("copy and Open share the hover group with splits, before the stable mode switch", () => {
    const h = harness(); const { pane } = terminal(h); pane.app = "codex"; h.state.autopilot = true;
    const ids = ["ph-copy-path-p-clicked", "ph-copy-id-p-clicked", "ph-open-p-clicked", "ph-r-p-clicked", "ph-d-p-clicked", "ph-z-p-clicked", "ph-x-p-clicked"];
    h.view.hovered = false;
    for (const id of ids) expect(h.find(h.render(), id)).toBeNull();
    expect(h.find(h.render(), "ph-mode-p-clicked")).not.toBeNull();
    expect(h.find(h.render(), "autopilot")).not.toBeNull();
    h.view.hovered = true;
    const tree = h.render();
    for (const id of ids) expect(h.find(tree, id).style_size).toEqual([24]);
    const order = tree.nodes.map(n => n?.elementId?.[0]);
    expect(order.indexOf("autopilot")).toBeLessThan(order.indexOf(ids[0]));
    for (const id of ids) expect(order.indexOf(id)).toBeLessThan(order.indexOf("ph-mode-p-clicked"));
    expect(h.find(tree, ids[0]).tip[0]).toContain("Copy path");
    expect(h.find(tree, ids[1]).tip[0]).toContain("hc terminal address");
    expect(h.find(tree, ids[1]).tip[0]).toContain("remote machine prefix");
    expect(h.find(tree, ids[0]).nodes[0].style_size).toEqual([14]);
    expect(h.find(tree, ids[0]).nodes[0].asset).not.toBe(h.find(tree, ids[1]).nodes[0].asset);
  });

  test("one click copies the unfocused clicked terminal without opening a popup or changing focus", () => {
    const h = harness(); terminal(h);
    h.state.panes.push({ pane: "p-focused", terminal: "t-focused", cwd: "/other", focused: true });
    h.copy("id");
    expect(h.state.clipboard).toEqual(["t-clicked"]);
    expect(h.state.overlays).toEqual([]); expect(h.state.closed).toEqual([]); expect(h.state.commands).toEqual([]);
    expect(h.state.notices[0]).toMatchObject({ title: "Panel ID copied", level: "success", timeout: 1600 });
  });

  test("copy preserves full paths with home, quotes, Unicode, shell characters and long names", () => {
    const h = harness(); const cwd = `/opt/test-home/Project 'files' 中文/$(touch nope);\n${"long-directory/".repeat(35)}end`;
    terminal(h, { cwd }); h.copy("path"); expect(h.state.clipboard).toEqual([cwd]);
  });

  test("a directory change after header rendering is resolved on click", () => {
    const h = harness(); const { record } = terminal(h); const tree = h.render(); record.foreground = { cwd: "/new/current/directory" };
    h.click(h.find(tree, "ph-copy-path-p-clicked")); expect(h.state.clipboard).toEqual(["/new/current/directory"]);
  });

  test("remote terminal addresses include their machine prefix", () => {
    const h = harness(); terminal(h, { address: "build-machine/t7" }); h.copy("id"); expect(h.state.clipboard).toEqual(["build-machine/t7"]);
  });

  test("remote Chat resolves its live backing terminal and foreground cwd on the correct machine", () => {
    const h = harness(); h.state.terminals.push({ address: "t-local", state: "live", labels: { "herdr.chat": "p-chat" }, cwd: "/wrong-machine" });
    chat(h); h.copy("id", "remote/p-chat"); h.copy("path", "remote/p-chat");
    expect(h.state.clipboard).toEqual(["remote/t-agent", "/srv/work/foreground"]);
  });

  test("Chat re-resolves a replacement agent after rendering", () => {
    const h = harness(); const old = chat(h); const tree = h.render(); old.state = "exited";
    h.state.terminals.push({ address: "remote/t-new", state: "live", labels: { "herdr.chat": "p-chat" }, cwd: "/srv/new" });
    h.click(h.find(tree, "ph-copy-id-remote/p-chat")); expect(h.state.clipboard).toEqual(["remote/t-new"]);
  });

  test("Terminal to Chat and Chat to Terminal swaps resolve the current terminal", () => {
    const h = harness(); const { pane, record } = terminal(h); const tree = h.render();
    pane.mod = "chat"; pane.terminal = null; record.labels = { "herdr.chat": "p-clicked" };
    h.click(h.find(tree, "ph-copy-id-p-clicked"));
    h.state.panes[0] = { pane: "p-clicked", terminal: "t-new" }; h.state.terminals.push({ address: "t-new", state: "live", cwd: "/new" });
    h.click(h.find(tree, "ph-copy-path-p-clicked")); expect(h.state.clipboard).toEqual(["t-clicked", "/new"]);
  });

  test("lazy Assistant does not copy its configured folder; it resolves a newly started terminal", () => {
    const h = harness(); h.state.panes.push({ pane: "p-clicked", mod: "chat" });
    h.state.shared["coordinator.slots"] = { assistant: { pane: "p-clicked", folder: "/configured/not-live" } };
    h.copy("path"); expect(h.state.clipboard).toEqual([]); expect(h.state.notices[0].body).toContain("No live terminal");
    h.state.terminals.push({ address: "t-started", state: "live", cwd: "/actual", labels: { "herdr.chat": "p-clicked" } });
    h.copy("path"); expect(h.state.clipboard).toEqual(["/actual"]);
  });

  test("unavailable cwd reports an error but panel ID is still copyable", () => {
    for (const cwd of [null, "", "~/repo", "relative/repo"]) {
      const h = harness(); terminal(h, { cwd }); h.copy("path"); h.copy("id");
      expect(h.state.clipboard).toEqual(["t-clicked"]); expect(h.state.notices[0].body).toContain("full path is unavailable");
    }
  });

  test("Windows drive and UNC cwd values are copied unchanged", () => {
    for (const cwd of ["C:\\Users\\Test Person\\repo", "D:/work/project", "\\\\server\\share\\repo"]) {
      const h = harness(); terminal(h, { cwd }); h.copy("path"); expect(h.state.clipboard).toEqual([cwd]);
    }
  });

  test("exited, missing, closed and nonterminal targets cannot copy stale data", () => {
    for (const change of [h => { h.state.terminals[0].state = "exited"; }, h => { h.state.terminals = []; }, h => { h.state.panes = []; }, h => { h.state.panes[0].mod = "code-view"; }]) {
      const h = harness(); terminal(h); const tree = h.render(); change(h);
      h.click(h.find(tree, "ph-copy-id-p-clicked")); expect(h.state.clipboard).toEqual([]);
      expect(h.state.notices[0]).toMatchObject({ title: "Couldn't copy", level: "warning" });
    }
  });

  test("artifact and code panes have no copy or Open controls", () => {
    for (const mod of ["art-proof", "code-view", "other-mod"]) {
      const h = harness(); h.state.panes.push({ pane: "p-clicked", mod, title: "File", cwd: "/a/file", terminal: "not-a-terminal" });
      for (const id of ["ph-copy-path-p-clicked", "ph-copy-id-p-clicked", "ph-open-p-clicked"]) expect(h.find(h.render(), id)).toBeNull();
    }
  });

  test("clipboard failures have no success feedback", () => {
    const h = harness(); terminal(h); h.cx.write_to_clipboard = () => { throw new Error("Clipboard unavailable"); }; h.copy("id");
    expect(h.state.notices).toEqual([{ title: "Couldn't copy", body: "Clipboard unavailable", level: "error" }]);
  });

  test("split, zoom, close and click-to-focus retain explicit pane targets", () => {
    const h = harness(); terminal(h); const tree = h.render();
    for (const key of ["r", "d", "z", "x"]) h.click(h.find(tree, `ph-${key}-p-clicked`)); h.click(tree);
    expect(h.state.commands).toEqual([
      ["pane.split", { direction: "right", pane: "p-clicked" }], ["pane.split", { direction: "down", pane: "p-clicked" }],
      ["pane.zoom", { pane: "p-clicked" }], ["pane.close", { pane: "p-clicked" }], ["pane.focus", { pane: "p-clicked" }],
    ]);
  });

  test("Chat end confirmation replaces all hovered controls", () => {
    const h = harness(); chat(h, { address: "t-agent", pane: "p-clicked" }); h.view.ending = true;
    const tree = h.render(); expect(h.find(tree, "ph-end-p-clicked")).not.toBeNull();
    for (const id of ["ph-copy-id-p-clicked", "ph-copy-path-p-clicked", "ph-open-p-clicked", "ph-r-p-clicked"]) expect(h.find(tree, id)).toBeNull();
    expect(h.find(tree, "ph-mode-p-clicked")).not.toBeNull();
  });
});

describe("desktop pane Open menu", () => {
  test("clicked header opens exactly the four application options", () => {
    const h = harness(); terminal(h); h.click(h.find(h.render(), "ph-open-p-clicked"));
    expect(h.state.overlays[0]).toMatchObject({ mod: "pane-chat", kind: "popup", props: { openPane: "p-clicked" } });
    const tree = h.menu(); const rows = tree.nodes.filter(n => n?.elementId?.[0]?.startsWith("ph-open-"));
    expect(rows.map(n => n.elementId[0])).toEqual(actions.map(a => `ph-open-${a}`));
    expect(rows.map(n => n.nodes[0])).toEqual(["Open in Terminal", "Open in VS Code", "Open in Finder", "Open in Xcode"]);
    expect(h.state.commands).toEqual([]);
  });

  test("default terminal is selected anew per action and the clicked current directory is passed as data", async () => {
    const h = harness(); const { record } = terminal(h); const tree = h.menu();
    const path = "/work/quote' \" 中文/$(touch nope);\nfolder"; record.foreground = { cwd: path };
    await h.open("terminal", tree);
    expect(h.state.executions[0]).toEqual(["/usr/bin/test", ["-d", path]]);
    const lookup = h.state.executions[1]; expect(lookup[0]).toBe("/usr/bin/osascript");
    expect(lookup[1].at(-1)).toBe("terminal"); expect(lookup[1].join(" ")).toContain("public.unix-executable");
    expect(lookup[1].join(" ")).not.toContain(path);
    expect(h.state.executions[2]).toEqual(["/usr/bin/open", ["-a", h.state.app, "--", path]]);
    h.state.app = "/Applications/Another Terminal.app"; await h.open("terminal", tree);
    expect(h.state.executions.at(-1)[1][1]).toBe(h.state.app); expect(h.state.commands).toEqual([]);
    expect(h.state.closed).toEqual(["open-popup", "open-popup"]);
  });

  test("native lookup queries the configured executable handler and the requested app's bundle ID", async () => {
    const h = harness(); terminal(h); await h.open("terminal");
    const script = h.state.executions[1][1][3];
    const lookups = [];
    let missing = false;
    const selected = { isNil: () => missing, path: "/Applications/System Choice.app" };
    const native = { NSWorkspace: { sharedWorkspace: {
      URLForApplicationToOpenContentType: type => { lookups.push(["default", type]); return selected; },
      URLForApplicationWithBundleIdentifier: id => { lookups.push(["bundle", id]); return selected; },
    } }, UTType: { typeWithIdentifier: id => id } };
    const run = new Function("ObjC", "$", `${script}\nreturn run;`)({ import() {}, unwrap: x => x }, native);
    expect(JSON.parse(run(["terminal"]))).toBe(selected.path);
    for (const key of actions.slice(1)) run([key]);
    expect(lookups).toEqual([["default", "public.unix-executable"], ["bundle", "com.microsoft.VSCode"], ["bundle", "com.apple.finder"], ["bundle", "com.apple.dt.Xcode"]]);
    missing = true;
    expect(() => run(["terminal"])).toThrow("No default terminal application is configured.");
    expect(() => run(["vscode"])).toThrow("isn't installed");
    expect(script).not.toContain("com.apple.Terminal");
  });

  test("VS Code, Finder and Xcode use their registered apps and checked argument arrays", async () => {
    for (const key of actions.slice(1)) {
      const h = harness(); terminal(h); await h.open(key);
      expect(h.state.executions[1][1].at(-1)).toBe(key);
      expect(h.state.executions[2]).toEqual(["/usr/bin/open", ["-a", h.state.app, "--", "/opt/test-home/project"]]);
    }
  });

  test("Open in local Chat uses its backing terminal's latest foreground cwd", async () => {
    const h = harness(); const record = chat(h, { address: "t-chat", pane: "p-clicked" }); const tree = h.menu();
    record.foreground.cwd = "/chat/current"; await h.open("finder", tree);
    expect(h.state.executions.at(-1)[1].at(-1)).toBe("/chat/current");
  });

  test("remote paths, missing terminals and missing cwd disable all options with an explanation", () => {
    for (const options of [{ address: "remote/t7" }, { cwd: null }, { state: "exited" }]) {
      const h = harness(); terminal(h, options); const tree = h.menu();
      for (const key of actions) expect(h.find(tree, `ph-open-${key}`).handlers.on_click).toBeUndefined();
      expect(h.find(tree, "pane-open-reason")).not.toBeNull(); expect(h.state.executions).toEqual([]);
    }
  });

  test("becoming remote or closed after rendering never dispatches a local app", async () => {
    for (const change of [h => { h.state.panes = []; }, h => { h.state.panes[0].terminal = "remote/t7"; h.state.terminals[0].address = "remote/t7"; }]) {
      const h = harness(); terminal(h); const tree = h.menu(); change(h); await h.open("vscode", tree);
      expect(h.state.executions).toEqual([]); expect(h.state.notices[0].level).toBe("warning");
    }
  });

  test("foreign Windows paths are not passed to macOS applications", () => {
    const h = harness(); terminal(h, { cwd: "C:\\work\\repo" }); const tree = h.menu();
    for (const key of actions) expect(h.find(tree, `ph-open-${key}`).handlers.on_click).toBeUndefined();
  });

  test("unsupported host platforms explain why external Open is unavailable", () => {
    for (const platform of ["linux", "windows"]) {
      const h = harness(); terminal(h); h.state.platform = platform; const tree = h.menu();
      for (const key of actions) expect(h.find(tree, `ph-open-${key}`).handlers.on_click).toBeUndefined();
      expect(h.find(tree, "pane-open-reason")).not.toBeNull();
    }
  });

  test("missing directories and missing default terminal fail without launching a substitute", async () => {
    for (const step of ["/usr/bin/test", "/usr/bin/osascript"]) {
      const h = harness(); terminal(h);
      h.state.exec = (cmd) => ({ code: cmd === step ? 1 : 0, stdout: "", stderr: cmd === "/usr/bin/osascript" ? "No default terminal application is configured." : "" });
      await h.open("terminal"); expect(h.state.executions.some(([cmd]) => cmd === "/usr/bin/open")).toBe(false);
      expect(h.state.notices[0].body).toContain(step === "/usr/bin/test" ? "directory" : "default terminal");
      expect(h.state.closed).toEqual([]);
    }
  });

  test("missing applications and failed launches surface their checked errors", async () => {
    for (const failed of ["/usr/bin/osascript", "/usr/bin/open"]) {
      const h = harness(); terminal(h);
      h.state.exec = cmd => ({ code: cmd === failed ? 1 : 0, stdout: JSON.stringify(h.state.app), stderr: cmd === failed ? "Requested app unavailable" : "" });
      await h.open("xcode"); expect(h.state.notices[0]).toMatchObject({ title: "Couldn't open Xcode", body: "Requested app unavailable", level: "error" });
      expect(h.state.closed).toEqual([]);
    }
  });

  test("rejected process starts report failure", async () => {
    const h = harness(); terminal(h); h.state.exec = () => { throw new Error("Process could not start"); };
    await h.open("finder"); expect(h.state.notices[0].body).toBe("Process could not start");
  });

  test("keyboard navigation, activation and Escape follow the existing popup pattern", async () => {
    const h = harness(); terminal(h); const tree = h.menu();
    tree.handlers.on_key_down({ key: "up" }, h.cx); tree.handlers.on_key_down({ key: "enter" }, h.cx);
    await Promise.all(h.state.jobs); expect(h.state.executions[1][1].at(-1)).toBe("xcode");
    tree.handlers.on_key_down({ key: "escape" }, h.cx); expect(h.state.closed).toEqual(["open-popup", "open-popup"]);
  });

  test("keyboard activation rechecks disabled remote targets", async () => {
    const h = harness(); terminal(h, { address: "remote/t7" }); const tree = h.menu();
    tree.handlers.on_key_down({ key: "down" }, h.cx); tree.handlers.on_key_down({ key: "enter" }, h.cx);
    await Promise.all(h.state.jobs); expect(h.state.executions).toEqual([]);
  });
});
