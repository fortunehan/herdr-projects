import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ReviewLaunchBridge, REVIEW_COMMAND, REVIEW_BRIDGE, REVIEW_RESULTS, launchTarget } from "./review-launch.js";
import { ChangesReview, sourceKey, DEFAULT_MODEL } from "./changes-review.js";
import { targetKey } from "./review-target.js";

const head = "a".repeat(40), baseline = "b".repeat(40);
const source = { address: "t-source", conversation: "source-conversation", pid: 42, root: "/checkout/worktree", kind: "codex", task: "TEST-1" };
const request = (changes = {}) => ({ version: 1, id: "launch-1", bridge: "instance", at: 1000,
  target: { cwd: "/checkout/worktree", workspace: "sp1", tab: "tab1", on: null,
    comparison: { mode: "branch", base: "chosen/topic" }, head, baseline, source: { address: source.address, pid: source.pid } }, ...changes });
const command = (r) => REVIEW_COMMAND + encodeURIComponent(JSON.stringify(r));
function fixture() {
  const shared = new Map(), opened = [], bound = [];
  const io = { now: () => 1000, token: () => "instance", read: (k) => shared.get(k), write: (k, v) => shared.set(k, v),
    bind: async (input, clicked) => { bound.push({ input, clicked }); return { ...input, binding: source }; },
    open: (target) => { opened.push(target); return "overlay-1"; } };
  const bridge = new ReviewLaunchBridge(io);
  bridge.announce();
  return { bridge, shared, opened, bound, io };
}

/** Load the exported host adapter, replacing only runtime transports; no global Bun module mocks. */
function hostFixture() {
  const f = fixture(), ts = [{ address: source.address, state: "live", foreground: { pid: 42, name: "codex", cwd: source.root }, labels: { "herdr.chat": "chat1", "herdr.task": "TEST-1" } }];
  const ps = [{ pane: "chat1", tab: "tab1", mod: "chat" }], ss = [{ id: "sp1", tabs: [{ id: "tab1" }] }];
  let observed = { root: source.root, gitdir: "/checkout/.git/worktrees/task", head, base: baseline, resolvedRef: head };
  const calls = [];
  const exec = async (cmd, args, options) => {
    calls.push({ cmd, args });
    if (cmd === "git") return { code: 0, stdout: options.cwd };
    if (cmd === "sh") return { code: 0, stdout: "/logs/source-conversation.jsonl" };
    throw new Error(`Unexpected real transport: ${cmd}`);
  };
  const deps = { exec, hc: async () => ({ code: 0, stdout: JSON.stringify(ts[0]) }), writeTextFile: () => { throw new Error("No writes allowed"); },
    openOverlay: (v) => { f.opened.push(v); return "overlay-host"; }, shared: f.io.read, setShared: f.io.write,
    panes: () => ps, terminals: () => ts, spaces: () => ss,
    fs: { realpath: async (v) => v }, dirsReady: () => { throw new Error("No real storage allowed"); },
    DEFAULTS: "", menuFor: () => {}, parseDefaults: () => {}, sessionOf: () => source.conversation,
    FIND: "find-log", Conversation: class {}, CLEAN_ENV: "", AGENT_PATH: "", chatPane: (t) => t.labels?.["herdr.chat"],
    ChangesReview, completedMessage: () => {}, sourceMessages: () => {}, finished: () => {}, reportText: () => {}, sourceKey,
    capture: async (_io, input) => { calls.push({ capture: input }); return observed; }, ReviewLaunchBridge };
  const code = readFileSync(new URL("../lib/reviews.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  const exports = new Function(...Object.keys(deps), code + "\nreturn { reviewBridge: reviewLauncher(), bindReviewLaunch, io };")(...Object.values(deps));
  return { ...f, ...exports, ts, ps, ss, calls, setObserved: (v) => { observed = { ...observed, ...v }; } };
}

test("native mod command routing reaches the bridge without consulting focused state", async () => {
  const received = [], pending = new Promise(() => {});
  let next = command(request());
  const deps = { View: class {}, reviewLauncher: () => ({ announce: () => {}, handle: async (c) => received.push(c) }),
    sweep: () => {}, watchService: () => {}, startBridge: () => {}, startTick: () => {}, startInbox: () => {}, watchViews: () => {},
    dirsReady: () => pending, nextCommand: () => { const c = next; next = null; return c ? Promise.resolve(c) : pending; },
    localStorage: { getItem: () => null }, focused: () => { throw new Error("Must not read focus for a launch command"); },
    spaces: () => { throw new Error("Must not resolve a launch from the active space"); } };
  const code = readFileSync(new URL("../mods/tabs-tasks/main.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "class");
  const Tabs = new Function(...Object.keys(deps), code + "\nreturn Tabs;")(...Object.values(deps));
  const cx = { timer: { every: () => {} }, sleep: () => pending, spawn: (fn) => fn(cx) };
  new Tabs().init({}, cx);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(received).toEqual([command(request())]);
});

test("report/storage consumers load without initializing or granting the tab host's launcher", () => {
  const code = readFileSync(new URL("../lib/reviews.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  const host = new Function("ChangesReview", "exec", code + "\nreturn { reviews, reviewLauncher };")(ChangesReview, () => { throw new Error("No process calls allowed"); });
  expect(host.reviews).toBeInstanceOf(ChangesReview);
  expect(typeof host.reviewLauncher).toBe("function");
});

test("capability announces only the bounded versioned command with a renewable expiry", () => {
  const f = fixture(), cap = f.shared.get(REVIEW_BRIDGE);
  expect(cap).toEqual({ version: 1, instance: "instance", expires: 11000, command: "tabs-tasks.review-open:", results: REVIEW_RESULTS });
  f.io.now = () => 5000; f.bridge.announce();
  expect(f.shared.get(REVIEW_BRIDGE).expires).toBe(15000);
});

test("producer command opens only the existing pinned dialog through the actual exported host bridge", async () => {
  const f = hostFixture(); f.reviewBridge.announce();
  const r = request({ bridge: f.shared.get(REVIEW_BRIDGE).instance, at: Date.now() });
  const result = await f.reviewBridge.handle(command(r));
  expect(result.status).toBe("opened");
  expect(f.opened).toHaveLength(1);
  expect(f.opened[0]).toMatchObject({ mod: "changes-review", kind: "dialog", props: { bound: true,
    target: { cwd: source.root, mode: "ref", ref: "chosen/topic", workspace: "sp1", tab: "tab1", task: "TEST-1", binding: source,
      expected: { head, base: baseline, gitdir: "/checkout/.git/worktrees/task" } } } });
  expect(f.calls.some((c) => c.cmd === "hc" || c.args?.includes("run"))).toBe(false);
});

test("duplicate in-flight and completed requests open once, conflicting ids fail", async () => {
  const f = fixture(); let release;
  f.io.bind = () => new Promise((resolve) => { release = resolve; });
  const r = request(), first = f.bridge.handle(command(r)), again = f.bridge.handle(command(r));
  release(launchTarget(r));
  expect(await first).toEqual(await again);
  expect((await f.bridge.handle(command(r))).status).toBe("opened");
  expect(f.opened).toHaveLength(1);
  expect((await f.bridge.handle(command(request({ target: { ...r.target, cwd: "/other" } })))).error).toContain("reused");
});

test("missing, unknown, expired and malformed bridge requests never open a dialog", async () => {
  const f = fixture();
  for (const patch of [{ bridge: undefined }, { bridge: "old-instance" }, { version: 2 }, { at: -10000 }, { at: 9000 }]) {
    expect((await f.bridge.handle(command(request(patch)))).status).toBe("error");
  }
  expect((await f.bridge.handle(REVIEW_COMMAND + "%invalid")).status).toBe("error");
  expect(await f.bridge.handle("unrelated-command")).toBe(false);
  expect(f.opened).toEqual([]); expect(f.bound).toEqual([]);
});

test("native Annotator snapshot modes preserve actual automatic/explicit ref and reject Last commit", () => {
  const r = request();
  for (const [mode, mapped] of [["branch", "ref"], ["base", "base"], ["uncommitted", "uncommitted"]]) {
    const t = { ...r.target, comparison: { mode, base: "origin/develop" } };
    expect(launchTarget({ ...r, target: t })).toMatchObject({ mode: mapped, ref: mode === "uncommitted" ? "" : "origin/develop" });
  }
  for (const patch of [{ comparison: { mode: "last_commit" } }, { comparison: { mode: "branch", base: null } },
    { comparison: { mode: "branch", base: "-bad" } }, { cwd: "relative" }, { on: "remote" }, { pending: true }, { retained: true },
    { workspace: "remote/sp1" }, { tab: null }, { source: { address: "remote/t1", pid: 42 } }, { source: { address: "t1" } }, { head: undefined }, { baseline: "bad" }]) {
    expect(() => launchTarget({ ...r, target: { ...r.target, ...patch } })).toThrow();
  }
});

test("host binding rejects stale HEAD/base, wrong checkout, process, workspace or source tab", async () => {
  for (const mutate of [f => f.setObserved({ head: baseline }), f => f.setObserved({ base: head }),
    f => f.ts[0].foreground.pid++, f => f.ts[0].foreground.cwd = "/different", f => f.ss.splice(0),
    f => f.ps[0].tab = "other-tab", f => f.ts[0].state = "ended", f => f.ts[0].labels["herdr.review"] = "review-other"]) {
    const f = hostFixture(); mutate(f);
    await expect(f.bindReviewLaunch(launchTarget(request()), request().target)).rejects.toThrow();
    expect(f.opened).toEqual([]);
  }
});

test("unrelated global/focused state is never used and genuine bind/open failures are visible", async () => {
  const f = fixture(); f.shared.set("changes.review.target", { cwd: "/unrelated" });
  f.io.bind = async () => { throw new Error("permission denied reading checkout"); };
  expect((await f.bridge.handle(command(request()))).error).toBe("permission denied reading checkout");
  expect(f.shared.get(REVIEW_RESULTS).at(-1).status).toBe("error");
  f.io.bind = async (t) => t; f.io.open = () => { throw new Error("native overlay failed"); };
  expect((await f.bridge.handle(command(request({ id: "second" })))).error).toBe("native overlay failed");
});

test("bound prepare pins one conversation, its checkout and workspace without changing defaults", async () => {
  const f = hostFixture(), input = await f.bindReviewLaunch(launchTarget(request()), request().target);
  const observation = { ...input.expected, mode: input.mode, inventory: [], digest: "digest" };
  let available = [source, { ...source, address: "unrelated", conversation: "another" }];
  const io = { exec: async () => ({ code: 0, stdout: JSON.stringify(observation) }),
    catalog: async () => ({ models: [{ id: DEFAULT_MODEL }], origin: "configured" }), probe: async () => ({ ok: true }),
    sources: async (t) => { expect(t.workspace).toBe("sp1"); expect(t.tab).toBe("tab1"); return available; } };
  const review = new ChangesReview(io), form = await review.prepare(input);
  expect(form.sources).toEqual([source]); expect(form.source).toBe(sourceKey(source));
  expect(form).toMatchObject({ model: DEFAULT_MODEL, effort: "high", depth: "high", guidance: "" });
  available = [{ ...source, conversation: "replacement" }];
  await expect(review.prepare(input)).rejects.toThrow("bound Source");
  available = [source]; observation.gitdir = "/replaced/worktree";
  await expect(review.prepare(input)).rejects.toThrow("bound checkout");
});

test("host source discovery revalidates original tab and leaves ordinary my-changes discovery intact", async () => {
  const f = hostFixture();
  expect(await f.io.sources({ root: source.root, binding: source, workspace: "sp1", tab: "tab1" })).toHaveLength(1);
  f.ps[0].tab = "other-tab";
  expect(await f.io.sources({ root: source.root, binding: source, workspace: "sp1", tab: "tab1" })).toEqual([]);
  expect(await f.io.sources({ root: source.root })).toHaveLength(1);
});

test("actual dialog refresh, timer and Run use pinned input; ordinary entry still follows Changes", async () => {
  const calls = [], global = { cwd: "/unrelated", mode: "base" }, clicked = { cwd: "/clicked", mode: "ref", ref: "chosen", workspace: "sp1" };
  const deps = { View: class {}, div: () => {}, v_flex: () => {}, h_flex: () => {}, InputState: {}, Input: {}, TextareaState: {}, Textarea: {}, TextView: {},
    props: () => {}, theme: () => {}, closeOverlay: () => {}, shared: () => global,
    reviews: { prepare: async (t) => { calls.push(t); return { target: t, sourcesKey: "same", models: [] }; }, launch: async (_f, t) => calls.push(t) },
    reviewRecords: async () => [], disabled: () => null, LEVELS: [], sourceKey, reportText: () => {}, effortReason: () => {}, finished: () => {}, targetKey,
    keepKeys: () => {}, dropKeys: () => {} };
  const code = readFileSync(new URL("../mods/changes-review/main.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "class");
  const Dialog = new Function(...Object.keys(deps), code + "\nreturn ReviewDialog;")(...Object.values(deps));
  const tasks = [], cx = { spawn: (fn) => { tasks.push(fn(cx)); }, notify: () => {} };
  const dialog = new Dialog(); dialog.p = { bound: true, target: clicked }; dialog.form = {}; dialog.prompt = { value: () => "" };
  dialog.refresh(cx); await Promise.all(tasks.splice(0));
  dialog.launch(cx); await Promise.all(tasks.splice(0));
  expect(calls).toEqual([clicked, clicked]);
  dialog.p.bound = false; dialog.refresh(cx); await Promise.all(tasks.splice(0));
  expect(calls.at(-1)).toBe(global);
  const myChanges = readFileSync(new URL("../mods/my-changes/main.js", import.meta.url), "utf8");
  expect(myChanges).toContain('setShared("changes.review.target", target)');
  const tabs = readFileSync(new URL("../mods/tabs-tasks/main.js", import.meta.url), "utf8");
  expect(tabs).toContain("reviewBridge.announce()"); expect(tabs).toContain("await reviewBridge.handle(c)");
});
