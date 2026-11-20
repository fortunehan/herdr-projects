import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spaceTaskCounts } from "./task-counts.js";
import { chatPane } from "./spaces.js";
import { holdingItems } from "./tasks.js";
import { REASONS, fit, reqReason, reportReason } from "./needs.js";

// SHEP-93: the Herdr window's Needs you listed SDS-17 twice while its agent waited on a question card.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const bare = (file) => read(file).replace(/^import[\s\S]*?;\n/gm, "")
  .replace(/^export \{[^}]*\}[^;]*;\n/gm, "").replace(/^export (default )?/gm, "");
const load = (file, deps, result) => new Function(...Object.keys(deps), `${bare(file)}\nreturn ${result};`)(...Object.values(deps));

const FOLDER = "~/dev/sc-doc-scripts";
const QUESTION = "How should the sidebar make the link…";
const sds17 = { machine: null, folder: FOLDER, name: "sc-doc-scripts", ref: "SDS-17", key: "sc-doc-scripts#17",
  title: "domain-widget-scenarios: Fold Navigation Flow", space: "sp1", tab: null, attention: null, pr: null, merging: false, at: 1 };
const worker = { address: "t16s", state: "live", status: "blocked", parent: "assistant",
  labels: { "herdr.task": "sc-doc-scripts#17", "herdr.task.space": "sp1" }, report: { kind: "question" } };
const assistant = { address: "assistant", state: "live", status: "idle",
  labels: { "herdr.role": "coordinator", "herdr.coordinator.space": "sp1", "herdr.space": "sp1" } };

function inbox({ tasks = [], asks = [], terminals = [assistant, worker] } = {}) {
  const state = new Map([["inbox.tasks", tasks], ["inbox.asks", asks]]);
  const spaces = [{ id: "sp1", folder: FOLDER, tabs: [{ id: "tab1" }] }];
  const api = load("lib/inbox.js", {
    spaceTaskCounts, chatPane, REASONS, fit, reqReason, reportReason, SH: "",
    shared: (k) => state.get(k), terminals: () => terminals, agents: () => [], spaces: () => spaces,
    panes: () => [{ terminal: "assistant", pane: "pane1", tab: "tab1" }],
  }, "({ items, count, statusCounts, countsByTab, reasonOf })");
  // The Tasks panel's Needs you (mods/tasks/main.js render()): items() less those the task's own status moved past.
  const truth = new Map([[`:${FOLDER}:SDS-17`, { section: "needs" }]]);
  return { ...api, rows: () => holdingItems(api.items(), truth) };
}

const expectOne = (n) => {
  expect(n.rows()).toHaveLength(1);
  expect(n.count()).toBe(1);
  expect(n.statusCounts().need).toBe(1);
  expect([...n.countsByTab()]).toEqual([["tab1", 1]]);
};

describe("Needs you: one row per task while its agent asks (SHEP-93)", () => {
  test("the task still read as waiting while its live agent is blocked on a question card", () => {
    const n = inbox({ tasks: [{ ...sds17, kind: "waiting", why: QUESTION, live: ["t16s"] }] });
    expectOne(n);
    const [row] = n.rows();
    expect(row).toMatchObject({ kind: "blocked", terminal: "t16s", ref: "SDS-17", folder: FOLDER, title: sds17.title });
    expect(n.reasonOf(row)).toBe(QUESTION);
  });

  test("herdr-task already says asks: the blocked agent is the row, with the task's question", () => {
    const n = inbox({ tasks: [{ ...sds17, kind: "asks", why: QUESTION, live: ["t16s"] }] });
    expectOne(n);
    expect(n.reasonOf(n.rows()[0])).toBe(QUESTION);
  });

  test("a stale entry whose live list is empty still finds the agent by its herdr.task label", () => {
    const n = inbox({ tasks: [{ ...sds17, kind: "stopped", why: null, live: [] }] });
    expectOne(n);
    expect(n.rows()[0]).toMatchObject({ kind: "blocked", ref: "SDS-17" });
  });

  test("the chat's card (a hook ask) and the task's own item are one row, the ask first", () => {
    const n = inbox({ asks: [{ id: "t16s.1700000000.42", terminal: "t16s" }],
      tasks: [{ ...sds17, kind: "waiting", why: QUESTION, live: ["t16s"] }] });
    expectOne(n);
    expect(n.rows()[0]).toMatchObject({ kind: "ask", ref: "SDS-17" });
  });

  test("two of the task's agents waiting at once (its worker and its reviewer) are one row", () => {
    const reviewer = { ...worker, address: "t17r", parent: "t16s", labels: { ...worker.labels, "herdr.role": "reviewer" } };
    const n = inbox({ terminals: [assistant, worker, reviewer], tasks: [{ ...sds17, kind: "asks", why: QUESTION, live: ["t16s"] }] });
    expectOne(n);
  });

  test("other tasks, other machines' same refs, agents with no task and a failed pull stay apart", () => {
    const other = { ...worker, address: "t20x", labels: { "herdr.task": "sc-doc-scripts#18" } };
    const remote = { ...worker, address: "vm/t16s" };
    const loose = { address: "t99", state: "live", status: "blocked", labels: {} };
    const n = inbox({ terminals: [assistant, worker, other, remote, loose], tasks: [
      { ...sds17, kind: "waiting", why: QUESTION, live: ["t16s"] },
      { ...sds17, ref: "SDS-18", key: "sc-doc-scripts#18", kind: "asks", live: ["t20x"] },
      { ...sds17, machine: "vm", kind: "asks", live: ["vm/t16s"] },
      { ...sds17, kind: "pull", pull: { at: 1 }, live: [] },
    ] });
    expect(n.items().map((x) => [x.kind, x.machine ?? null, x.ref ?? null])).toEqual([
      ["blocked", null, "SDS-17"], ["blocked", null, "SDS-18"], ["blocked", "vm", "SDS-17"], ["blocked", null, null], ["pull", null, "SDS-17"],
    ]);
  });
});
