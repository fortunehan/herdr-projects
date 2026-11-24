// SHEP-116: the Herdr window's Tasks panel listed APM-1 twice under Needs you ("Needs you 2") while its worker waited on
// one question. The worker, resumed in a login shell, had two hook requests up for it (mods/chat/ask-hook.sh read only
// the shell's argv, so it didn't step aside for the worker's own hook), and neither carried the task: APM-1 is in Ready
// (it asked after saying ready, SHEP-95), so herdr-task's list gave it no inbox entry to find it by. Its folder (the
// marketplace) isn't the folder of the space whose Assistant started it (my-work-skills).
import { beforeEach, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit, type Element } from "./fake-gpui";

const shared = new Map<string, unknown>();
const none = async () => ({ code: 1, stdout: "", stderr: "" });
const tree = { id: "root", children: [{ id: "tasks", children: [{ id: "tasks-list" }, { id: "tasks-thread" }] }] };
const theme = { foreground: "#fafafa", muted: "#a1a1aa", dim: "#7c7c85", hover: "#ffffff0a", selected: "#ffffff12", border: "#ffffff1f", background: "#111114" };

const MARKET = "/work/90024-ai-plugins-marketplace", SKILLS = "/work/my-work-skills";
const skillsSpace = { id: "sp7f", name: "my-work-skills", folder: SKILLS, machine: null, tabs: [{ id: "tbSkills" }] };
const marketSpace = { id: "spf7", name: "plugins-marketplace", folder: MARKET, machine: null, tabs: [{ id: "tbMarket" }] };
const assistant = { address: "t14k", state: "live", status: "done",
  labels: { "herdr.role": "coordinator", "herdr.coordinator.space": "sp7f", "herdr.coordinator.tab": "tbSkills" } };
const worker = { address: "t14s", state: "live", status: "blocked", parent: "t14k", program: { key: "claude" },
  labels: { "herdr.task": "Codes-90024-ai-plugins-marketplace#1", "herdr.task.space": "sp7f", "herdr.agent": "claude" } };
const apm1 = { id: 1, title: "Contribute branch-impact-analysis skill", state: "ready", space: "sp7f", ready_at: 1,
  waits: "Scanning sanitized source skill", agents: [{ address: "t14s", at: 1 }] };
const lists = () => [
  { machine: null, folder: MARKET, name: "90024-ai-plugins-marketplace", slug: "Codes-90024-ai-plugins-marketplace", prefix: "APM", tasks: [apm1] },
  { machine: null, folder: SKILLS, name: "my-work-skills", slug: "Codes-my-work-skills", prefix: "MWS", tasks: [] },
];
// lib/inbox.js readTasksNow's "inbox.agents" entry for APM-1 (it has no "inbox.tasks" one: Ready, its status needs).
const working = { machine: null, folder: MARKET, name: "90024-ai-plugins-marketplace", ref: "APM-1", key: "Codes-90024-ai-plugins-marketplace#1",
  title: apm1.title, space: "sp7f", live: ["t14s"] };
// The two hook requests for its one question: the global hook's and the worker's own (herdr-task _allow's).
const twoAsks = [{ id: "t14s.1795423217.48123", terminal: "t14s" }, { id: "t14s.1795423217.48301", terminal: "t14s" }];

let spaceList: any[] = [];
mock.module("herdr", () => fakeHerdr({
  run: () => {}, layout: () => tree, exec: none, hc: none, theme: () => theme, settings: () => ({}),
  shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => { shared.set(k, v); },
  agents: () => [], panes: () => [{ terminal: "t14k", pane: "pSkills", tab: "tbSkills" }], terminals: () => [assistant, worker],
  spaces: () => spaceList, machines: () => [],
}));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase());
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Tasks } = await import("../mods/tasks/main.js");
const inbox = await import("../mods/tasks/inbox.js");

beforeEach(() => { shared.clear(); });

const words = (e: Element | string): string[] => (typeof e === "string" ? [e] : (e?.kids ?? []).flatMap((k: any) => words(k)));
const cx: any = { timer: { after: () => {}, every: () => {} }, spawn: () => {}, notify: () => {} };

function panel({ here = null as null | string, asks = twoAsks as any[], agents = [working] as any[] | undefined } = {}) {
  spaceList = [skillsSpace, marketSpace].map((s) => ({ ...s, active: s.id === here }));
  shared.set("inbox.tasks", []);
  shared.set("inbox.asks", asks);
  if (agents) shared.set("inbox.agents", agents);
  const p: any = Object.create(Tasks.prototype);
  Object.assign(p, { lists: lists(), ready: true, error: null, here: Boolean(here), filter: "all", shutKeys: new Set(), allDone: new Set(),
    asks: new Map(), reading: new Set(), prefixes: new Map(), warns: new Map(), archivedOpen: false, width: 360,
    query: { value: () => "", set_value: () => {} }, listFocus: {} });
  const text = words(p.render(cx)).join(" ");
  return { text, rows: text.split(apm1.title).length - 1, chip: text.match(/Needs you (\d+)/)?.[1] ?? null };
}

for (const [name, here] of [["every space", null], ["This space: the Assistant's space", "sp7f"], ["This space: the task's folder's space", "spf7"]] as const) {
  test(`${name}: two requests from APM-1's one worker are one row, Needs you 1`, () => {
    expect(panel({ here })).toMatchObject({ rows: 1, chip: "1" });
  });
}

test("the row is the worker's card, and in the task's folder's space too: its ask carries the task", () => {
  const { text } = panel({ here: "spf7" });
  expect(text).toContain("APM-1 Question for you");
  const [item] = inbox.items();
  expect(item).toMatchObject({ kind: "ask", terminal: "t14s", ref: "APM-1", folder: MARKET, space: "sp7f" });
});

test("an inbox read from before inbox.agents (no entry for the task) still shows one row", () => {
  expect(panel({ agents: undefined })).toMatchObject({ rows: 1, chip: "1" });
});

test("the counts say one: Needs you, the bottom bar's need and the Assistant's tab", () => {
  panel({ here: "sp7f" });
  expect(inbox.items()).toHaveLength(1);
  expect(inbox.count()).toBe(1);
  expect(inbox.statusCounts().need).toBe(1);
  expect([...inbox.countsByTab()]).toEqual([["tbSkills", 1]]);
});

test("its agent blocked with no request (answered elsewhere, or no hook) is still one row", () => {
  expect(panel({ asks: [] })).toMatchObject({ rows: 1, chip: "1" });
  expect(inbox.items()).toMatchObject([{ kind: "blocked", terminal: "t14s", ref: "APM-1" }]);
});
