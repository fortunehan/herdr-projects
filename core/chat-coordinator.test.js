import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../mods/chat/main.js", import.meta.url), "utf8");
const locate = source.match(/\n  async locate\(cx\) \{[^]*?\n  \}\n/)[0];
async function recover({ labels = {}, address = "t1", machine = null, thread = false, inner = false, role = "coordinator", shown = true } = {}) {
  const t = { address, state: "live", keep: true, labels: { "herdr.role": "coordinator", "herdr.chat": "p1", ...labels } };
  const calls = [];
  const obj = new Function("hc", "panes", "spaces", "chatPane", "chatLabel", "assistant", "KINDS", `return {${locate}}`)(
    async (argv) => { calls.push(argv); return { code: 0, stdout: JSON.stringify(t) }; },
    () => shown ? [{ pane: machine ? `${machine}/p1` : "p1", tab: machine ? `${machine}/tab1` : "tab1", mod: "chat" }] : [],
    () => [{ id: machine ? `${machine}/sp1` : "sp1", machine, tabs: [{ id: machine ? `${machine}/tab1` : "tab1" }] }],
    (k) => k.labels?.["herdr.chat"] ? (address.includes("/") ? `${address.split("/")[0]}/${k.labels["herdr.chat"]}` : k.labels["herdr.chat"]) : null,
    (id) => id.split("/").at(-1), (k) => k.labels?.["herdr.role"] === "coordinator", {});
  await obj.locate.call({ addr: address, role, thread, inner, lastPane: machine ? `${machine}/p1` : "p1", checkLost: async () => false, set() {} }, {});
  return calls.filter((a) => a[0] === "label");
}

test("an Assistant recovered behind its chat gets its space and tab labels back", async () => {
  expect(await recover()).toEqual([["label", "t1", "herdr.coordinator.space=sp1", "herdr.coordinator.tab=tab1"]]);
});

test("a remote Assistant gets bare labels on its own machine", async () => {
  expect(await recover({ address: "vm/t1", machine: "vm" })).toEqual([["label", "vm/t1", "herdr.coordinator.space=sp1", "herdr.coordinator.tab=tab1"]]);
});

test("recovery keeps correct labels and fills only the missing one", async () => {
  expect(await recover({ labels: { "herdr.coordinator.space": "sp1", "herdr.coordinator.tab": "tab1" } })).toEqual([]);
  expect(await recover({ labels: { "herdr.coordinator.space": "sp1" } })).toEqual([["label", "t1", "herdr.coordinator.tab=tab1"]]);
});

test("worker views, missing panes and a different machine cannot relabel an Assistant", async () => {
  for (const args of [{ thread: true }, { inner: true }, { shown: false }, { address: "other/t1", machine: "vm" },
    { role: null, labels: { "herdr.role": "worker" } }, { labels: { "herdr.coordinator.space": "another-space" } }]) expect(await recover(args)).toEqual([]);
});

async function parkAssistant(machine = null, role = "coordinator", labelCode = 0) {
  const at = (id) => machine ? `${machine}/${id}` : id;
  const calls = [], jobs = [];
  const terminal = { address: at("t1"), labels: { "herdr.role": role, "herdr.space": "sp1", "herdr.tab": "tab1" } };
  const pane = { pane: at("p-terminal"), terminal: terminal.address, tab: at("tab1") };
  const src = readFileSync(new URL("../mods/pane-chat/main.js", import.meta.url), "utf8");
  const method = src.match(/\n  toChat\(p, cx\) \{[^]*?\n  \}\n/)[0];
  const obj = new Function("chatOf", "panes", "spaces", "terminals", "app", "hc", "run", "chatLabel", "toast", "plainError", "CHAT", "LABEL", `return {${method}}`)(
    () => null, () => [pane], () => [{ id: at("sp1"), machine, tabs: [{ id: at("tab1") }] }], () => [terminal],
    async (cmd) => {
      calls.push([cmd]);
      if (cmd === "terminal.park") { delete terminal.labels["herdr.space"]; delete terminal.labels["herdr.tab"]; }
      return { pane: at("p-chat") };
    },
    async (args) => {
      calls.push(args);
      if (!labelCode) for (const pair of args.slice(2)) { const cut = pair.indexOf("="); terminal.labels[pair.slice(0, cut)] = pair.slice(cut + 1); }
      return { code: labelCode };
    },
    () => {}, (id) => id.split("/").at(-1), (e) => calls.push(["toast", e.title]), (e) => e.message, "chat", "herdr.chat");
  const cx = { spawn: (fn) => jobs.push(fn(cx)), notify() {} };
  obj.toChat(pane, cx);
  await Promise.all(jobs);
  return { calls, terminal };
}

test("Terminal to Chat preserves an Assistant's route before parking removes pane labels", async () => {
  for (const machine of [null, "vm"]) {
    const { calls, terminal } = await parkAssistant(machine);
    expect(calls[1]).toEqual(["label", terminal.address, "herdr.chat=p-chat", "herdr.coordinator.space=sp1", "herdr.coordinator.tab=tab1"]);
    expect(calls[2]).toEqual(["terminal.park"]);
    expect(terminal.labels["herdr.coordinator.space"]).toBe("sp1");
    expect(terminal.labels["herdr.space"]).toBeUndefined();
  }
  const { terminal } = await parkAssistant(null, "worker");
  expect(terminal.labels["herdr.coordinator.space"]).toBeUndefined();
});

test("a failed label transfer keeps the Assistant in its terminal", async () => {
  const { calls, terminal } = await parkAssistant(null, "coordinator", 1);
  expect(calls.some((c) => c[0] === "terminal.park")).toBe(false);
  expect(terminal.labels["herdr.space"]).toBe("sp1");
});
