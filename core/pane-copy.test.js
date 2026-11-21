import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const source = readFileSync(new URL("../mods/pane-chat/main.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default class Pane", "class Pane");
const spacesSource = readFileSync(new URL("./spaces.js", import.meta.url), "utf8")
  .split("// A space's Assistant:")[0].replace(/^export /gm, "").replace(/\bCHAT\b/g, "CHAT_LABEL");
const openSource = `${readFileSync(new URL("./open-editor.js", import.meta.url), "utf8").replace(/^export /gm, "")}\nconst openTitle = title;`;

/** Exercise real header handlers with isolated live data, clipboard and application dispatch. */
function harness() {
  const state = { props: { pane: "p-clicked" }, panes: [], terminals: [], shared: {}, clipboard: [], notices: [], commands: [], overlays: [], closed: [], executions: [], options: [], jobs: [], platform: "macos" };
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
    spaces: () => state.spaces ?? [], shared: (key) => state.shared[key], setShared: () => {},
    theme: () => ({}), home: () => "/opt/test-home", inRender: (fn) => fn(), window: () => ({ platform: state.platform }),
    run: (...args) => state.commands.push(args), notify: (n) => state.notices.push(n),
    exec: async (cmd, args, options) => {
      state.executions.push([cmd, args]); state.options.push(options);
      return state.exec ? state.exec(cmd, args) : { code: 0, stdout: "", stderr: "" };
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
  const Pane = new Function("env", `const {${Object.keys(env).join(",")}} = env;\n${spacesSource}\n${openSource}\n${source}\nreturn Pane;`)(env);
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

const actions = ["vscode", "iterm", "finder", "xcode"];

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
    expect(rows.map(n => n.nodes[0])).toEqual(["Open in VS Code", "Open in iTerm2", "Open in Finder", "Open in Xcode"]);
    expect(h.state.commands).toEqual([]);
  });

  test("each option runs one open command on the clicked current directory, passed as data", async () => {
    const finds = { iterm: ["-a", "iTerm"], vscode: ["-b", "com.microsoft.VSCode"], finder: ["-b", "com.apple.finder"], xcode: ["-b", "com.apple.dt.Xcode"] };
    for (const key of actions) {
      const h = harness(); const { record } = terminal(h); const tree = h.menu();
      const path = "/work/quote' \" 中文/$(touch nope);\nfolder"; record.foreground = { cwd: path };
      await h.open(key, tree);
      expect(h.state.executions).toEqual([["/usr/bin/open", [...finds[key], "--", path]]]);
      expect(h.state.options[0].timeout).toBeGreaterThan(0);
      expect(h.state.notices).toEqual([]); expect(h.state.closed).toEqual(["open-popup"]); expect(h.state.commands).toEqual([]);
    }
  });

  test("Open in local Chat uses its backing terminal's latest foreground cwd", async () => {
    const h = harness(); const record = chat(h, { address: "t-chat", pane: "p-clicked" }); const tree = h.menu();
    record.foreground.cwd = "/chat/current"; await h.open("finder", tree);
    expect(h.state.executions.at(-1)[1].at(-1)).toBe("/chat/current");
  });

  // SHEP-97: the Assistant's chat pane in the window, its agent as `hc get` shows a coordinator (parked behind the
  // chat, herdr.chat naming the chat pane, herdr.role=coordinator).
  function assistant(h, { foreground = { cwd: "/h/Codes/Lab/shepherdr", argv: ["claude"] }, cwd = "/h/Codes/Lab/shepherdr", resume = "/h/Codes/Lab/shepherdr" } = {}) {
    const pane = "pe2ed2f65e0bc49f3d4e0c4fd1b757e69";
    h.state.panes.push({ pane, mod: "chat", tab: "tb7a3", focused: true });
    h.state.spaces = [{ id: "sp20", folder: "/h/Codes/Lab/shepherdr-space", machine: null, tabs: [{ id: "tb7a3" }] }];
    h.state.terminals.push({ address: "t14j", state: "live", status: "working", cwd, foreground,
      labels: { "herdr.chat": pane, "herdr.role": "coordinator", "herdr.agent": "claude", "herdr.coordinator.space": "sp20", "herdr.coordinator.tab": "tb7a3",
        ...(resume ? { "herdr.resume": JSON.stringify({ kind: "claude", session: "s", cwd: resume }) } : {}) } });
    h.state.props = { pane };
    return pane;
  }

  test("the Assistant's chat pane opens every app on its agent's folder", async () => {
    for (const key of actions) {
      const h = harness(); const pane = assistant(h); const tree = h.menu(pane);
      expect(h.find(tree, "pane-open-reason")).toBeNull();
      await h.open(key, tree);
      expect(h.state.notices).toEqual([]); expect(h.state.closed).toEqual(["open-popup"]);
      expect(h.state.executions).toHaveLength(1);
      expect(h.state.executions[0][1].slice(-2)).toEqual(["--", "/h/Codes/Lab/shepherdr"]);
    }
  });

  test("an Assistant whose terminal has no cwd now uses its agent's start folder, then its space's", async () => {
    const h = harness(); const pane = assistant(h, { foreground: null, cwd: null }); await h.open("vscode", h.menu(pane));
    expect(h.state.executions.at(-1)).toEqual(["/usr/bin/open", ["-b", "com.microsoft.VSCode", "--", "/h/Codes/Lab/shepherdr"]]);
    const g = harness(); const p2 = assistant(g, { foreground: null, cwd: "", resume: null }); await g.open("vscode", g.menu(p2));
    expect(g.state.executions.at(-1)[1].at(-1)).toBe("/h/Codes/Lab/shepherdr-space");
    g.state.props = { pane: p2 }; g.copy("path", p2); expect(g.state.clipboard).toEqual(["/h/Codes/Lab/shepherdr-space"]);
  });

  // SHEP-97's cause: herdr's exec rejects a program that isn't on disk (macOS 26 has no /usr/bin/test), as it did
  // for every Open from the Assistant's chat pane. Here exec refuses, as the window's does, any program this Mac lacks.
  test.if(process.platform === "darwin")("every Open starts only programs this Mac has", async () => {
    for (const key of actions) {
      const h = harness(); const pane = assistant(h);
      h.state.exec = (cmd) => {
        if (!existsSync(cmd)) throw new Error(`No such file or directory (os error 2): ${cmd}`);
        return { code: 0, stdout: "", stderr: "" };
      };
      await h.open(key, h.menu(pane));
      expect(h.state.notices).toEqual([]); expect(h.state.closed).toEqual(["open-popup"]);
    }
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

  test("a missing directory names the folder", async () => {
    for (const key of actions) {
      const h = harness(); terminal(h);
      h.state.exec = () => ({ code: 1, stdout: "", stderr: "The file /opt/test-home/project does not exist." });
      await h.open(key);
      expect(h.state.notices[0]).toMatchObject({ level: "error", body: "The folder is missing: /opt/test-home/project" });
      expect(h.state.closed).toEqual([]);
    }
  });

  test("a failed launch shows the command and its stderr", async () => {
    const h = harness(); terminal(h);
    h.state.exec = () => ({ code: 1, stdout: "", stderr: "LSOpenURLsWithRole() failed with error -10810 for the file /opt/test-home/project." });
    await h.open("xcode");
    expect(h.state.notices[0]).toEqual({ title: "Couldn't open Xcode", level: "error",
      body: "Opening Xcode failed: LSOpenURLsWithRole() failed with error -10810 for the file /opt/test-home/project. (open -b com.apple.dt.Xcode -- /opt/test-home/project)" });
    expect(h.state.closed).toEqual([]);
  });

  test("an app that isn't installed says so", async () => {
    const h = harness(); terminal(h);
    h.state.exec = () => ({ code: 1, stdout: "", stderr: "Unable to find application named 'iTerm'" });
    await h.open("iterm");
    expect(h.state.notices[0]).toMatchObject({ title: "Couldn't open iTerm2", body: "iTerm2 isn't installed. (open -a iTerm -- /opt/test-home/project)" });
  });

  test("a failure with no stderr still says why, never a bare failed", async () => {
    const h = harness(); terminal(h);
    h.state.exec = () => ({ code: 2, stdout: "", stderr: "" });
    await h.open("finder");
    expect(h.state.notices[0].body).toBe("Opening Finder failed: it exited with 2 (open -b com.apple.finder -- /opt/test-home/project)");
  });

  test("rejected process starts report failure", async () => {
    const h = harness(); terminal(h); h.state.exec = () => { throw new Error("Process could not start"); };
    await h.open("finder");
    expect(h.state.notices[0].body).toBe("/usr/bin/open couldn't run: Process could not start (open -b com.apple.finder -- /opt/test-home/project)");
  });

  test("keyboard navigation, activation and Escape follow the existing popup pattern", async () => {
    const h = harness(); terminal(h); const tree = h.menu();
    tree.handlers.on_key_down({ key: "up" }, h.cx); tree.handlers.on_key_down({ key: "enter" }, h.cx);
    await Promise.all(h.state.jobs); expect(h.state.executions[0]).toEqual(["/usr/bin/open", ["-b", "com.apple.dt.Xcode", "--", "/opt/test-home/project"]]);
    tree.handlers.on_key_down({ key: "escape" }, h.cx); expect(h.state.closed).toEqual(["open-popup", "open-popup"]);
  });

  test("keyboard activation rechecks disabled remote targets", async () => {
    const h = harness(); terminal(h, { address: "remote/t7" }); const tree = h.menu();
    tree.handlers.on_key_down({ key: "down" }, h.cx); tree.handlers.on_key_down({ key: "enter" }, h.cx);
    await Promise.all(h.state.jobs); expect(h.state.executions).toEqual([]);
  });
});
