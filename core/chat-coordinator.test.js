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
