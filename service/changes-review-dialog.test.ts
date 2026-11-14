import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { built, byId, element, handler } from "./fake-gpui";
import { disabled, LEVELS, sourceKey, reportText, effortReason, DEFAULT_MODEL, finished } from "../core/changes-review.js";
import { targetKey } from "../core/review-target.js";

const target = { cwd: "/checkout", mode: "ref", ref: "develop", task: "TASK-1", base: "main", workspace: "space" };
const source = { address: "source", conversation: "conversation", root: "/checkout", pid: 1, kind: "codex", name: "Work owner" };
const form = () => ({ target: { root: target.cwd, task: target.task, mode: target.mode, ref: "develop", resolvedRef: "resolved-commit", base: "merge-base" }, input: target,
  targetKey: targetKey(target), catalog: "configured", models: [{ id: DEFAULT_MODEL, name: "GPT-6-Astra · Codex", efforts: LEVELS }, { id: "provider/second", name: "Custom label" }],
  model: DEFAULT_MODEL, effort: "high", depth: "high", guidance: "", sources: [source], source: sourceKey(source), sourcesKey: "sources", loading: false });
const input = (p: any) => { let value = p?.value ?? ""; const listeners: any = {}; return { value: () => value, set_value: (s: string) => { value = s; listeners.change?.(); }, on: (k: string, f: any) => { listeners[k] = f; }, set_rows() {}, release() {} }; };
const text = () => built.flatMap((e) => e.kids.filter((x: any) => typeof x === "string")).join("\n");
let jobs: Promise<any>[], callbacks: any[], state: any;
const cx: any = { notify() {}, timer: { every: (_ms: number, f: any) => callbacks.push(f) }, spawn: (f: any) => { jobs.push(f(cx)); } };
beforeEach(() => { built.length = 0; jobs = []; callbacks = []; state = { target, form: form(), launches: [], closed: [], error: null }; });
async function settle() { while (jobs.length) { const now = jobs; jobs = []; await Promise.all(now); } }
function view() {
  const bindings = {
    View: class {}, div: element, v_flex: element, h_flex: element,
    InputState: { new: input }, TextareaState: { new: input }, Input: { new: () => element() }, Textarea: { new: () => element() }, TextView: { new: (s: string) => element().child(s) },
    props: () => ({ target, report: state.report, overlay: "overlay" }), theme: () => ({}), closeOverlay: (id: string) => state.closed.push(id), shared: () => state.target,
    reviews: { prepare: async () => { if (state.error) throw new Error(state.error); return structuredClone(state.form); }, launch: async (f: any, target: any) => {
      state.launches.push({ form: f, target }); if (state.launchError) throw new Error(state.launchError); return { id: "review" };
    }, recipients: async () => [source], recover: async (id: string, action: any) => {
      (state.recoveries ??= []).push({ id, action }); if (state.recoveryError) throw new Error(state.recoveryError);
    }, tick: async () => {}, cancel: async (id: string) => (state.cancellations ??= []).push(id) },
    reviewRecords: async () => state.records ?? [], disabled, LEVELS, sourceKey, reportText, effortReason, finished, targetKey, keepKeys() {}, dropKeys() {},
  };
  const src = readFileSync(new URL("../mods/changes-review/main.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "class");
  const Dialog = new Function(...Object.keys(bindings), src + "\nreturn ReviewDialog;")(...Object.values(bindings));
  const v = new Dialog(); v.init({}, cx); return v;
}
const click = (id: string) => handler(byId(id)!, "on_click")!({}, cx);

test("dialog displays the complete confirmed target, bound source and sole CLI without replacing preview/commit controls", async () => {
  const v = view(); await settle(); v.render(cx);
  for (const s of ["Review", "Checkout", "/checkout", "Followed task", "TASK-1", "Branch · develop", "resolved-commit / merge-base", "Agent CLI", "Claude Code", "GPT-6-Astra · Codex", "Source session", "conversation", "Model effort", "Review depth", "Prompt", "Run", "Cancel"])
    expect(text()).toContain(s);
  expect(text()).toContain("three completed reviews"); expect(text()).toContain("CLI permission policy");
  expect(text()).not.toContain("Cloud"); expect(byId("review-run")).toBeDefined();
});

test("model selection keeps configured order, labels and exact provider IDs; levels are independent", async () => {
  const v = view(); await settle(); v.render(cx); click("review-model"); built.length = 0; v.render(cx);
  expect(text().indexOf("GPT-6-Astra · Codex · codex/gpt-6-astra")).toBeLessThan(text().indexOf("Custom label · provider/second"));
  click("review-model-provider/second"); built.length = 0; v.render(cx);
  click("review-effort-low"); click("review-depth-max");
  v.prompt.set_value("Check edge cases"); built.length = 0; v.render(cx); click("review-run"); await settle();
  expect(state.launches[0].form.model).toBe("provider/second"); expect(state.launches[0].form.effort).toBe("low");
  expect(state.launches[0].form.depth).toBe("max"); expect(state.launches[0].form.guidance).toBe("Check edge cases");
});

test("Run is disabled while loading and after failed catalog or missing-source discovery", async () => {
  const v = view(); v.render(cx); click("review-run"); expect(state.launches).toEqual([]);
  await settle(); state.error = "Catalog discovery failed"; v.refresh(cx); await settle(); built.length = 0; v.render(cx);
  expect(text()).toContain("Catalog discovery failed"); click("review-run"); expect(state.launches).toEqual([]);
  state.error = null; state.form.sources = []; state.form.source = null; v.refresh(cx); await settle(); built.length = 0; v.render(cx);
  expect(text()).toContain("No matching live Source session"); click("review-run"); expect(state.launches).toEqual([]);
});

test("missing Astra requires explicit choice and fallback is not represented as a discovery failure", async () => {
  state.form.model = null; state.form.catalog = "fallback";
  const v = view(); await settle(); v.render(cx);
  expect(text()).toContain("Built-in fallback catalog loaded"); expect(text()).toContain("Choose a model");
  click("review-run"); expect(state.launches).toEqual([]);
});

test("recoverable launch errors retain guidance and both choices, and repeated Run clicks have one launch", async () => {
  const v = view(); await settle(); v.form.effort = "medium"; v.form.depth = "xhigh"; v.prompt.set_value("My guidance");
  state.launchError = "Unsupported model"; v.render(cx); click("review-run"); click("review-run"); await settle();
  built.length = 0; v.render(cx);
  expect(state.launches).toHaveLength(1); expect(text()).toContain("Unsupported model");
  expect(v.form.effort).toBe("medium"); expect(v.form.depth).toBe("xhigh"); expect(v.prompt.value()).toBe("My guidance"); expect(state.closed).toEqual([]);
});

test("target/recipient changes invalidate the form before launch until refreshed", async () => {
  const v = view(); await settle(); state.target = { ...target, ref: "another" };
  callbacks[0](cx); await settle(); v.render(cx); expect(text()).toContain("changed. Refresh this dialog"); click("review-run"); expect(state.launches).toEqual([]);
  state.target = target; state.form.sourcesKey = "replacement"; callbacks[0](cx); await settle();
  expect(v.form.stale).toBe(true);
});

function record(state = "undelivered") {
  return { id: "review-retained", state, input: target, target: { ...form().target, inventory: [], limitations: [] }, source,
    model: DEFAULT_MODEL, effort: "high", depth: "high", completedReviews: 2, rounds: [],
    round: { id: "round-2", reportId: "report-2", findings: [], responses: [], delivery: { state: "uncertain" }, processing: "unknown" } };
}

test("retained reports stay reachable from Changes after the source conversation is unavailable", async () => {
  state.records = [record()]; state.form.sources = []; state.form.source = null;
  const v = view(); await settle(); v.render(cx);
  expect(text()).toContain("Retained reviews"); click("review-retained-review-retained"); await settle(); built.length = 0; v.render(cx);
  expect(text()).toContain("Review report"); expect(text()).toContain("Completed reviews: 2 / 3");
  expect(text()).toContain("uncertain"); expect(byId("review-retry")).toBeDefined();
});

test("recovery requires explicit recipient selection and preserves a visible ambiguous-delivery error", async () => {
  state.records = [record()]; state.report = "review-retained";
  const v = view(); await settle(); v.render(cx);
  click("review-rebind"); expect(state.recoveries).toBeUndefined();
  click("review-rebind-source"); built.length = 0; v.render(cx); click("review-rebind"); await settle();
  expect(state.recoveries[0]).toEqual({ id: "review-retained", action: { type: "rebind", source: sourceKey(source) } });
  state.recoveryError = "Delivery remains ambiguous. No resend was made";
  built.length = 0; v.render(cx); click("review-retry"); await settle(); built.length = 0; v.render(cx);
  expect(text()).toContain("Delivery remains ambiguous"); expect(v.record.completedReviews).toBe(2);
});

test("ended limit-reached reports have no actions that could restart an automatic exchange", async () => {
  state.records = [record("limit-reached")]; state.report = "review-retained";
  const v = view(); await settle(); v.render(cx);
  expect(text()).toContain("Limit reached"); expect(byId("review-retry")).toBeUndefined();
  expect(byId("review-rebind")).toBeUndefined(); expect(byId("review-stop")).toBeUndefined();
});
