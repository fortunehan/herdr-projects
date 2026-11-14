import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, menuFor, parseDefaults, sessionOf } from "../core/agents.js";
import { FIND, Conversation } from "../core/chat-log.js";
import { CLEAN_ENV, AGENT_PATH } from "../core/clean-env.js";
import { ChangesReview, completedMessage, sourceMessages, finished, reportText, sourceKey, DEFAULT_MODEL } from "../core/changes-review.js";
import { CAPTURE } from "../core/review-target.js";
import { chatPane } from "../core/spaces.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const environment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const response = (value: any) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const run = (cmd: string, args: string[], cwd?: string) => {
  const p = Bun.spawnSync([cmd, ...args], { cwd, env: environment });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

/** The real window adapter and feature engine, with controlled process/Herdr boundaries and real Git/storage. */
async function fixture() {
  const top = mkdtempSync(join(tmpdir(), "review-boundary-")); roots.push(top);
  const root = join(top, "checkout"), data = join(top, "reviews"); mkdirSync(root);
  for (const args of [["init", "-qb", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"]]) run("git", args, root);
  writeFileSync(join(root, "a"), "base\n"); run("git", ["add", "-A"], root); run("git", ["commit", "-qm", "base"], root);
  writeFileSync(join(root, "a"), "modified\n");
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const sourcePath = join(top, `${sourceId}.jsonl`); writeFileSync(sourcePath, "");
  const source: any = { address: "t-source", state: "live", cwd: root, title: "Work owner", labels: {}, status: { state: "idle", app: "codex" }, foreground: { pid: 101, name: "codex", cwd: root, argv: ["codex"] } };
  const state: any = { terminals: [source], panes: [{ pane: "source-pane", tab: "source-tab", mod: "chat" }], launches: [], sends: [], killed: [], closed: [], tabs: [],
    catalog: [{ model: "vendor/first", label: "First" }, { model: DEFAULT_MODEL, label: "GPT-6-Astra · Codex" }], sourcePath,
    catalogError: false, probe: true, receipt: false, tabError: false, rejectSend: false, json: data, tabCount: 2, reviewPath: null };
  const commands: any[] = [];
  const exec = async (cmd: string, args: string[], opts: any = {}) => {
    commands.push({ cmd, args, opts });
    if (cmd === "python3" && !args.includes(CAPTURE)) return state.probe ? response({ ok: true }) : { code: 1, stdout: "", stderr: "Required bundled skill is missing" };
    if (cmd === "sh" && args[1].includes("effortLevel")) return state.catalogError ? { code: 1, stdout: "", stderr: "Catalog discovery failed" } : { code: 0, stdout: `picker\t${JSON.stringify(state.catalog)}\n`, stderr: "" };
    if (cmd === "sh" && args[1] === FIND) return { code: 0, stdout: Number(args.at(-1)) === 101 ? state.sourcePath : state.reviewPath ?? "pending", stderr: "" };
    if (cmd === "herdr-app") {
      const name = args[1], values: any = {};
      for (let i = 2; i < args.length; i += 2) values[args[i].slice(2)] = args[i + 1];
      if (name === "tab.new") {
        if (state.tabError) return { code: 1, stdout: "", stderr: "Tab creation failed" };
        const properties = JSON.parse(values.props);
        state.tabs.push({ ...values, props: properties });
        state.panes.push({ pane: "review-pane", tab: "review-tab", mod: "chat" });
        return response({ pane: "review-pane", tab: "review-tab" });
      }
      if (name === "tab.close") { state.closed.push(values.id); state.panes = state.panes.filter((p: any) => p.tab !== values.id); }
      return response({});
    }
    return run(cmd, args, opts.cwd);
  };
  const hc = async (args: string[]) => {
    if (args[0] === "run") {
      state.launches.push(args);
      const session = args[args.indexOf("--session-id") + 1];
      const review = args.find((a) => a.startsWith("herdr.review="))!.slice("herdr.review=".length);
      const reviewer = { address: "t-reviewer", state: "live", labels: { "herdr.review": review }, argv: ["claude", "--session-id", session], status: { state: "idle" }, foreground: { pid: 202 } };
      state.terminals.push(reviewer);
      return response(reviewer);
    }
    if (args[0] === "get") {
      const t = state.terminals.find((t: any) => t.address === args[1]);
      return t ? response(t) : { code: 1, stdout: "", stderr: "Terminal is gone" };
    }
    if (args[0] === "kill") { state.killed.push(args[1]); state.terminals.find((t: any) => t.address === args[1]).state = "finished"; return response({}); }
    if (args[0] === "send") {
      state.sends.push(args);
      if (state.rejectSend && !state.acceptDespiteError) return { code: 1, stdout: "", stderr: "blocked" };
      if (state.receipt) {
        const reviewer = args[1] === "t-reviewer";
        appendFileSync(reviewer ? state.reviewPath : state.sourcePath, JSON.stringify(!reviewer && source.foreground.name === "codex"
          ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: args[2] }] } }
          : { type: "user", sessionId: reviewer ? sessionOf("claude", state.reviewPath) : sessionOf("claude", state.sourcePath), message: { content: args[2] } }) + "\n");
      }
      return state.rejectSend ? { code: 1, stdout: "", stderr: "connection lost after admission" } : response({ sent: true });
    }
    throw new Error(`Unplanned core command: ${args[0]}`);
  };
  const writeTextFile = async (path: string, text: string, expected: string | null) => {
    const old = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (old !== expected) throw new Error("Stale snapshot");
    await fs.mkdir(join(path, ".."), { recursive: true }); await fs.writeFile(path, text);
  };
  const bindings = { exec, hc, writeTextFile, openOverlay: () => {}, panes: () => state.panes, terminals: () => state.terminals,
    spaces: () => [{ id: "workspace", machine: null, tabs: (state.tabCount === 2 ? [{ id: "source-tab" }] : []).concat([{ id: "review-tab" }]) }], fs,
    dirsReady: async () => ({ reviews: data }), DEFAULTS, menuFor, parseDefaults, sessionOf, FIND, Conversation, CLEAN_ENV, AGENT_PATH,
    ChangesReview, completedMessage, sourceMessages, finished, reportText, sourceKey, chatPane, shared: (key: string) => state.shared?.[key] };
  const src = readFileSync(new URL("../lib/reviews.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  const reload = () => new Function(...Object.keys(bindings), src + "\nreturn { reviews, reviewRecords, reviewTick, reviewSweep };")(...Object.values(bindings));
  const api: any = reload();
  const target = { cwd: root, mode: "uncommitted", workspace: "workspace" };
  const start = async () => api.reviews.launch(await api.reviews.prepare(target), target);
  const complete = (r: any, findings: any[] = []) => ({ type: "completed", runId: r.id, roundId: r.round.id, reportId: r.round.reportId, session: r.session, complete: true, findings, text: "Full report text" });
  return { state, api, reload, start, complete, target, commands, source, root, top };
}

test("desktop launch opens centered Chat with exact model, separate levels and bound source, then retains a source-linked pass", async () => {
  const f = await fixture();
  const form = await f.api.reviews.prepare(f.target);
  expect(form.models.map((m: any) => m.id)).toEqual(["vendor/first", DEFAULT_MODEL]);
  expect(form.models[1].name).toBe("GPT-6-Astra · Codex");
  form.effort = "low"; form.depth = "xhigh";
  const r = await f.api.reviews.launch(form, f.target);
  const launch = f.state.launches[0];
  expect(launch[launch.indexOf("--cwd") + 1]).toBe(r.target.root);
  expect(launch[launch.indexOf("--model") + 1]).toBe(DEFAULT_MODEL);
  expect(launch[launch.indexOf("--effort") + 1]).toBe("low"); expect(launch.at(-1)).toStartWith("/code-review xhigh ");
  expect(f.state.tabs[0].mod).toBe("chat"); expect(f.state.tabs[0].space).toBe("workspace");
  expect(f.state.tabs[0].props.review).toBe(r.id); expect(f.state.tabs[0].props.terminal).toBe("t-reviewer");
  expect(f.state.panes.some((p: any) => p.pane === "source-pane")).toBe(true);
  await f.api.reviews.message(f.complete(r)); f.state.receipt = true; await f.api.reviews.tick(r.id);
  const kept = (await f.api.reviewRecords())[0];
  expect(kept.state).toBe("passed"); expect(kept.source.conversation).toBe("11111111-1111-4111-8111-111111111111");
  expect(kept.round.processing).toBe("unknown"); expect(f.state.closed).toEqual(["review-tab"]); expect(f.state.killed).toEqual(["t-reviewer"]);
  expect(readFileSync(join(f.state.json, `${r.id}.md`), "utf8")).toContain("No findings reported.");
  expect(f.state.sends[0].slice(-2)).toEqual(["--if", "idle"]);
  expect(f.commands.some((c) => /split|window|install/.test(c.args[1] ?? "") && c.cmd === "herdr-app")).toBe(false);
}, 15000);

test("real adapter preserves findings after delivery and leaves its Chat tab open", async () => {
  const f = await fixture(), r = await f.start(); f.state.receipt = true;
  await f.api.reviews.message(f.complete(r, [{ file: "a", line: 1, summary: "Complete finding", failure_scenario: "Input fails" }]));
  await f.api.reviews.tick(r.id);
  expect((await f.api.reviewRecords())[0].state).toBe("waiting-for-source"); expect(f.state.closed).toEqual([]); expect(f.state.killed).toEqual([]);
  expect(f.state.sends[0][2]).toContain("Complete finding");
}, 15000);

test("real adapter sends nothing through a busy/question source and never uses force or keys", async () => {
  const f = await fixture(), r = await f.start(); await f.api.reviews.message(f.complete(r));
  for (const status of ["working", "blocked"]) { f.source.status.state = status; await f.api.reviews.tick(r.id); }
  expect(f.state.sends).toEqual([]);
  f.source.status.state = "idle"; f.state.rejectSend = true; await f.api.reviews.tick(r.id); await f.api.reviews.tick(r.id);
  expect(f.state.sends).toHaveLength(1); expect(f.state.sends[0]).not.toContain("--force");
  expect((await f.api.reviewRecords())[0].round.delivery.state).toBe("uncertain");
}, 15000);

test("source transcript identity changes cannot retarget a saved report", async () => {
  const f = await fixture(), r = await f.start(); await f.api.reviews.message(f.complete(r));
  f.state.sourcePath = join(f.top, "22222222-2222-4222-8222-222222222222.jsonl"); writeFileSync(f.state.sourcePath, "");
  await f.api.reviews.tick(r.id);
  expect((await f.api.reviewRecords())[0].state).toBe("undelivered"); expect(f.state.sends).toEqual([]);
}, 15000);

test("tab creation failure kills only its own created reviewer and preserves an error report", async () => {
  const f = await fixture(); f.state.tabError = true;
  await expect(f.start()).rejects.toThrow("Tab creation failed");
  expect(f.state.killed).toEqual(["t-reviewer"]); expect(f.state.closed).toEqual([]);
  expect((await f.api.reviewRecords())[0].state).toBe("failed");
  expect(f.source.state).toBe("live");
}, 15000);

test("durable reservation blocks overlapping launches even through independently loaded feature engines", async () => {
  const f = await fixture(), form = await f.api.reviews.prepare(f.target);
  await f.api.reviews.launch(form, f.target);
  await expect(f.start()).rejects.toThrow("already active"); expect(f.state.launches).toHaveLength(1);
}, 15000);

test("a partial source echo is not final delivery and a replacement reviewer process is never killed", async () => {
  const f = await fixture(), r = await f.start(); await f.api.reviews.message(f.complete(r)); await f.api.reviews.tick(r.id);
  writeFileSync(f.state.sourcePath, JSON.stringify({ type: "user", message: { content: r.round.reportId } }) + "\n");
  await f.api.reviews.tick(r.id); expect(f.state.closed).toEqual([]);
  const reviewer = f.state.terminals.find((t: any) => t.address === "t-reviewer"); reviewer.argv = ["codex", "different-session"];
  await f.api.reviews.cancel(r.id); expect(f.state.killed).toEqual([]); expect(f.source.state).toBe("live");
}, 15000);

test("catalog/skill discovery failures block the externally callable launch boundary", async () => {
  const f = await fixture(); f.state.catalogError = true;
  await expect(f.start()).rejects.toThrow("Catalog discovery failed"); f.state.catalogError = false; f.state.probe = false;
  await expect(f.start()).rejects.toThrow("bundled skill is missing"); expect(f.state.launches).toEqual([]);
}, 15000);

function transcript(r: any, findings: any[] = [], limitations: string[] = []) {
  return [
    { type: "user", sessionId: r.session, message: { content: "<command-name>/code-review</command-name>" } },
    { type: "assistant", sessionId: r.session, perTurnEffort: r.effort, message: { content: [{ type: "tool_use", name: "ReportFindings", id: "result", input: { level: r.depth, findings } }] } },
    { type: "user", sessionId: r.session, message: { content: [{ type: "tool_result", tool_use_id: "result", content: "Reported" }] } },
    { type: "assistant", sessionId: r.session, message: { content: [{ type: "text", text: `<changes-review-complete>${JSON.stringify({ runId: r.id, roundId: r.round.id, reportId: r.round.reportId, complete: true, limitations })}</changes-review-complete>` }] } },
    { type: "system", sessionId: r.session, subtype: "turn_duration" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n";
}

test("normal transcript/watch boundary completes a clean review and a findings review remains pending", async () => {
  for (const findings of [[], [{ file: "a", line: 1, summary: "Evidence-backed finding" }]]) {
    const f = await fixture(), r = await f.start();
    f.state.reviewPath = join(f.top, `${r.session}.jsonl`); writeFileSync(f.state.reviewPath, transcript(r, findings));
    f.state.receipt = true; await f.api.reviewSweep();
    const kept = (await f.api.reviewRecords())[0];
    expect(kept.round.findings).toEqual(findings); expect(kept.round.delivery.state).toBe("confirmed");
    expect(kept.state).toBe(findings.length ? "waiting-for-source" : "passed");
    expect(f.state.closed).toEqual(findings.length ? [] : ["review-tab"]);
  }
}, 15000);

test("manual reviewer tab closure cancels the run without sending reports", async () => {
  const f = await fixture(), r = await f.start(); f.state.panes = [f.state.panes[0]];
  await f.api.reviewSweep();
  expect((await f.api.reviewRecords())[0].state).toBe("cancelled");
  expect(f.state.sends).toEqual([]); expect(f.state.killed).toEqual(["t-reviewer"]);
}, 15000);

test("a completed review never closes the workspace when its own tab is the last one", async () => {
  const f = await fixture(), r = await f.start(); f.state.tabCount = 1; f.state.receipt = true;
  await f.api.reviews.message(f.complete(r)); await f.api.reviews.tick(r.id);
  const kept = (await f.api.reviewRecords())[0];
  expect(kept.state).toBe("closing"); expect(kept.error).toContain("last tab");
  expect(kept.round.delivery.state).toBe("confirmed"); expect(f.state.closed).toEqual([]); expect(f.state.killed).toEqual(["t-reviewer"]);
}, 15000);

test("Claude source receipts use the shared transcript reader too", async () => {
  const f = await fixture(); f.source.foreground.name = "claude"; f.source.status.app = "claude-code";
  const r = await f.start(); f.state.receipt = true; await f.api.reviews.message(f.complete(r)); await f.api.reviews.tick(r.id);
  expect((await f.api.reviewRecords())[0].state).toBe("passed");
}, 15000);

const finding = { file: "a", line: 1, summary: "Wrong result", failure_scenario: "Input returns an incorrect value" };
const retained = async (f: any) => (await f.api.reviewRecords())[0];
function sourceResponse(r: any, overrides: any = {}) {
  return { runId: r.id, roundId: r.round.id, reportId: r.round.reportId, deliveryId: r.round.delivery.id,
    binding: sourceKey(r.source), responseId: `response-${r.round.number}-${Math.random()}`, status: "completed",
    accepted: r.round.findings.map((_: any, i: number) => ({ findingId: `${r.round.reportId}-finding-${i + 1}`, disposition: "fixed", detail: "Corrected the behavior under existing task authorization" })),
    rejected: [], decisions: [], checks: [{ command: "project check", outcome: "passed", detail: "Relevant checks passed" }], ...overrides };
}
function reply(f: any, response: any, kind = f.source.foreground.name) {
  const text = `<changes-review-source>${JSON.stringify(response)}</changes-review-source>`;
  appendFileSync(f.state.sourcePath, JSON.stringify(kind === "codex"
    ? { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }
    : { type: "assistant", sessionId: sessionOf("claude", f.state.sourcePath), message: { content: [{ type: "text", text }] } }) + "\n");
}
async function reviewResult(f: any, r: any, findings: any[]) {
  f.state.reviewPath ??= join(f.top, `${r.session}.jsonl`);
  appendFileSync(f.state.reviewPath, transcript(r, findings));
  f.state.receipt = true;
  await f.api.reviewSweep();
  return retained(f);
}

for (const last of [2, 3]) test(`source repair commits stay in the captured comparison through a round ${last} pass`, async () => {
  const f = await fixture(), first = await f.start();
  let r = await reviewResult(f, first, [finding]);
  const initialHead = r.target.head;
  for (let number = 2; number <= last; number++) {
    writeFileSync(join(f.root, "a"), `repair ${number}\n`);
    run("git", ["add", "-A"], f.root); expect(run("git", ["commit", "-qm", `repair ${number}`], f.root).code).toBe(0);
    reply(f, sourceResponse(r));
    await f.api.reviewSweep(); r = await retained(f);
    expect(r.round.number).toBe(number); expect(r.completedReviews).toBe(number - 1);
    expect(r.target.head).toBe(initialHead); expect(r.round.startedObservation.inventory.map((x: any) => x.path)).toContain("a");
    expect(f.state.sends.at(-1)[1]).toBe("t-reviewer"); expect(f.state.sends.at(-1)[2]).toStartWith("/code-review high ");
    r = await reviewResult(f, r, number === last ? [] : [finding]);
  }
  expect(r.state).toBe("passed"); expect(r.completedReviews).toBe(last);
  expect(r.rounds).toHaveLength(last - 1); expect(r.rounds.every((x: any) => x.response.status === "completed")).toBe(true);
  expect(f.state.launches).toHaveLength(1); expect(f.state.closed).toEqual(["review-tab"]);
  expect(readFileSync(join(f.state.json, `${first.id}.md`), "utf8")).toContain("project check");
}, 15000);

test("third review with disagreement ends at the limit, sends explicit unresolved items, and never starts a fourth", async () => {
  const f = await fixture(), first = await f.start(); let r = await reviewResult(f, first, [finding]);
  for (let n = 2; n <= 3; n++) {
    reply(f, sourceResponse(r, { accepted: [], rejected: [{ findingId: `${r.round.reportId}-finding-1`, reason: "This is intentional; the caller requires this behavior" }], checks: [{ command: "caller contract", outcome: "skipped", detail: "No source change; inspect the caller contract" }] }));
    await f.api.reviewSweep(); r = await retained(f);
    expect(f.state.sends.at(-1)[2]).toContain("the caller requires this behavior");
    r = await reviewResult(f, r, [finding]);
  }
  expect(r.state).toBe("limit-reached"); expect(r.completedReviews).toBe(3);
  const final = f.state.sends.at(-1)[2]; expect(final).toContain("Final conclusion: limit-reached"); expect(final).toContain("Wrong result"); expect(final).toContain("No repair or recheck request follows");
  const count = f.state.sends.length;
  reply(f, sourceResponse(r)); await f.api.reviewSweep(); await f.reload().reviewSweep();
  await f.api.reviews.message(f.complete(r)); await f.api.reviews.recover(r.id, { type: "retry" });
  expect(f.state.sends).toHaveLength(count); expect(f.state.launches).toHaveLength(1); expect((await retained(f)).round.number).toBe(3);
}, 15000);

test("human judgment visibly pauses; duplicate waits, silence and partial replies cannot resolve it", async () => {
  const f = await fixture(), first = await f.start(); let r = await reviewResult(f, first, [finding]);
  const waiting = sourceResponse(r, { status: "waiting-for-decision", accepted: [], checks: [], decisions: [{ findingId: `${r.round.reportId}-finding-1`, question: "Should the existing behavior change?" }] });
  reply(f, waiting); await f.api.reviewSweep();
  expect((await retained(f)).state).toBe("waiting-for-decision");
  const count = f.state.sends.length;
  reply(f, waiting); reply(f, sourceResponse(r, { accepted: [], checks: [] }));
  await f.api.reviewSweep(); await f.reload().reviewSweep();
  expect((await retained(f)).state).toBe("waiting-for-decision"); expect(f.state.sends).toHaveLength(count); expect(f.state.closed).toEqual([]);
  reply(f, sourceResponse(r, { accepted: [{ findingId: `${r.round.reportId}-finding-1`, disposition: "unchanged", detail: "The person chose to preserve existing behavior" }] }));
  await f.api.reviewSweep(); r = await retained(f);
  expect(r.round.number).toBe(2); expect(r.rounds[0].responses).toHaveLength(2); expect(r.completedReviews).toBe(1);
}, 15000);

test("busy reviewer and open source/reviewer dialogs admit no messages or policy changes", async () => {
  const f = await fixture(), first = await f.start();
  f.state.shared = { "chat.screens": { "t-source": [{ state: "open" }] } };
  let r = await reviewResult(f, first, [finding]);
  expect(f.state.sends).toEqual([]); expect(r.round.delivery.state).toBe("waiting");
  f.state.shared = {}; await f.api.reviewSweep(); r = await retained(f);
  reply(f, sourceResponse(r));
  f.state.shared = { "chat.screens": { "t-reviewer": [{ state: "open" }] } };
  await f.api.reviewSweep(); expect((await retained(f)).round.request.state).toBe("waiting");
  const count = f.state.sends.length;
  const reviewer = f.state.terminals.find((t: any) => t.address === "t-reviewer");
  f.state.shared = {}; reviewer.status.state = "working"; await f.api.reviewSweep(); expect(f.state.sends).toHaveLength(count);
  reviewer.status.state = "idle"; await f.api.reviewSweep(); expect(f.state.sends).toHaveLength(count + 1);
  expect(f.state.sends.every((s: string[]) => s.slice(-2).join(" ") === "--if idle")).toBe(true);
  expect(f.commands.some((c: any) => /keys|policy|settings/.test(c.args[0]))).toBe(false);
}, 15000);

test("source replacement requires explicit validated rebinding and carries reconciliation without repeated repairs", async () => {
  const f = await fixture(), first = await f.start(); let r = await reviewResult(f, first, [finding]);
  const priorBody = f.state.sends[0][2];
  f.state.sourcePath = join(f.top, "22222222-2222-4222-8222-222222222222.jsonl"); writeFileSync(f.state.sourcePath, "");
  await f.api.reviewSweep(); expect((await retained(f)).state).toBe("undelivered"); expect(f.state.sends).toHaveLength(1);
  const candidates = await f.api.reviews.recipients(r.id);
  await expect(f.api.reviews.recover(r.id, { type: "rebind", source: "stale selection" })).rejects.toThrow("no longer matches");
  await f.api.reviews.recover(r.id, { type: "rebind", source: sourceKey(candidates[0]) });
  await f.api.reviewSweep(); r = await retained(f);
  expect(r.source.conversation).toBe("22222222-2222-4222-8222-222222222222");
  expect(r.completedReviews).toBe(1); expect(r.round.delivery.recoveryOnly).toBe(true);
  const body = f.state.sends.at(-1)[2]; expect(body).toContain("do NOT repeat repairs"); expect(body).not.toBe(priorBody);
  expect(r.recovery.some((x: any) => x.source?.conversation === first.source.conversation)).toBe(true);
  reply(f, sourceResponse(r)); await f.api.reviewSweep(); expect((await retained(f)).round.number).toBe(2);
}, 15000);

test("source exit before first delivery can be rebound explicitly without an incorrect recipient send", async () => {
  const f = await fixture(), first = await f.start(); await f.api.reviews.message(f.complete(first, [finding]));
  f.source.state = "finished"; await f.api.reviewSweep(); expect(f.state.sends).toEqual([]);
  expect(await f.api.reviews.recipients(first.id)).toEqual([]);
  f.source.state = "live"; f.state.sourcePath = join(f.top, "33333333-3333-4333-8333-333333333333.jsonl"); writeFileSync(f.state.sourcePath, "");
  const [candidate] = await f.api.reviews.recipients(first.id);
  await f.api.reviews.recover(first.id, { type: "rebind", source: sourceKey(candidate) });
  f.state.receipt = true; await f.api.reviewSweep();
  expect(f.state.sends).toHaveLength(1); expect(f.state.sends[0][2]).toContain(candidate.conversation);
  expect((await retained(f)).completedReviews).toBe(1);
}, 15000);

test("explicit ambiguous final retries retain identity and require a full receipt before closure", async () => {
  const f = await fixture(), r = await f.start(); await f.api.reviews.message(f.complete(r));
  f.state.rejectSend = true; await f.api.reviews.tick(r.id);
  expect(f.state.closed).toEqual([]); expect((await retained(f)).state).toBe("undelivered");
  await f.api.reviews.recover(r.id, { type: "retry" }); await f.api.reviews.tick(r.id);
  expect(f.state.closed).toEqual([]); expect((await retained(f)).round.delivery.attempts).toHaveLength(1);
  const sent = f.state.sends[0][2];
  appendFileSync(f.state.sourcePath, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: sent }] } }) + "\n");
  await f.reload().reviewSweep(); expect((await retained(f)).state).toBe("passed");
  expect(f.state.sends).toHaveLength(2); expect(f.state.closed).toEqual(["review-tab"]);
  expect(f.state.sends[0][2]).toBe(f.state.sends[1][2]); expect((await retained(f)).completedReviews).toBe(1);
}, 15000);

test("transport error after actual admission is reconciled in both directions without extra work", async () => {
  const f = await fixture(), first = await f.start();
  f.state.rejectSend = true; f.state.acceptDespiteError = true;
  let r = await reviewResult(f, first, [finding]); expect(r.round.delivery.state).toBe("confirmed");
  reply(f, sourceResponse(r)); await f.api.reviewSweep(); r = await retained(f);
  expect(r.round.number).toBe(2); expect(r.round.request.state).toBe("uncertain");
  await f.reload().reviewSweep(); r = await retained(f);
  expect(r.round.request.state).toBe("confirmed"); expect(f.state.sends).toHaveLength(2);
  r = await reviewResult(f, r, []); expect(r.state).toBe("passed"); expect(r.completedReviews).toBe(2);
}, 15000);

test("duplicated and reordered source/reviewer output across recovery cannot repeat repairs or consume reviews", async () => {
  const f = await fixture(), first = await f.start(); let r = await reviewResult(f, first, [finding]);
  const answer = sourceResponse(r);
  reply(f, { ...answer, reportId: "another report" }); await f.api.reviewSweep(); expect((await retained(f)).round.number).toBe(1);
  reply(f, answer); reply(f, answer); await f.api.reviewSweep(); r = await retained(f);
  expect(r.round.number).toBe(2); const sends = f.state.sends.length;
  await f.reload().reviewSweep(); await f.api.reviews.message(f.complete(first));
  expect((await retained(f)).completedReviews).toBe(1); expect(f.state.sends).toHaveLength(sends);
  r = await reviewResult(f, r, []); expect(r.completedReviews).toBe(2);
  expect(r.rounds[0].responses).toHaveLength(1); expect(f.state.launches).toHaveLength(1);
}, 15000);

test("reviewer loss during a human pause is a failure; recovery never launches a replacement", async () => {
  const f = await fixture(), first = await f.start(); const r = await reviewResult(f, first, [finding]);
  reply(f, sourceResponse(r, { accepted: [], checks: [], status: "waiting-for-decision", decisions: [{ findingId: `${r.round.reportId}-finding-1`, question: "Which behavior?" }] }));
  await f.api.reviewSweep();
  f.state.terminals.find((t: any) => t.address === "t-reviewer").state = "finished";
  await f.reload().reviewSweep();
  expect((await retained(f)).state).toBe("failed"); expect((await retained(f)).round.response.status).toBe("waiting-for-decision");
  expect(f.state.launches).toHaveLength(1); expect(f.state.closed).toEqual([]);
}, 15000);

test("cancellation and manual closure reject late responses, recovery actions and fourth-round callbacks", async () => {
  for (const manual of [false, true]) {
    const f = await fixture(), first = await f.start(); const r = await reviewResult(f, first, [finding]);
    if (manual) { f.state.panes = f.state.panes.filter((p: any) => p.tab !== "review-tab"); await f.api.reviewSweep(); }
    else await f.api.reviews.cancel(r.id);
    const sends = f.state.sends.length;
    reply(f, sourceResponse(r)); await f.reload().reviewSweep(); await f.api.reviews.recover(r.id, { type: "retry" });
    await f.api.reviews.message(f.complete(r));
    expect((await retained(f)).state).toBe("cancelled"); expect((await retained(f)).completedReviews).toBe(1);
    expect(f.state.sends).toHaveLength(sends); expect(f.state.closed).toEqual([]); expect(f.source.state).toBe("live");
  }
}, 15000);

test("an unavailable comparison stays paused across recovery until an explicit resume", async () => {
  const f = await fixture(), first = await f.start(); let r = await reviewResult(f, first, [finding]);
  reply(f, sourceResponse(r));
  const blob = run("git", ["rev-parse", "HEAD:a"], f.root).stdout.trim();
  const conflict = `0 ${"0".repeat(40)}\ta\n` + [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\ta\n`).join("");
  expect(Bun.spawnSync(["git", "update-index", "--index-info"], { cwd: f.root, env: environment, stdin: Buffer.from(conflict) }).exitCode).toBe(0);
  await f.api.reviewSweep(); r = await retained(f);
  expect(r.state).toBe("paused"); expect(r.error).toContain("Resolve merge conflicts"); expect(r.completedReviews).toBe(1);
  await f.reload().reviewSweep(); expect((await retained(f)).state).toBe("paused");
  run("git", ["add", "a"], f.root);
  await f.api.reviews.recover(r.id, { type: "resume" }); await f.api.reviewSweep();
  r = await retained(f); expect(r.round.number).toBe(2); expect(r.rounds[0].responses).toHaveLength(1); expect(f.state.launches).toHaveLength(1);
}, 15000);

test("third completed review with an incomplete inspection ends at the limit even without findings", async () => {
  const f = await fixture(), first = await f.start(); let r = await reviewResult(f, first, [finding]);
  for (let n = 2; n <= 3; n++) {
    reply(f, sourceResponse(r)); await f.api.reviewSweep(); r = await retained(f);
    if (n === 2) r = await reviewResult(f, r, [finding]);
    else {
      appendFileSync(f.state.reviewPath, transcript(r, [], ["One file could not be inspected"]));
      await f.api.reviewSweep(); r = await retained(f);
    }
  }
  expect(r.state).toBe("limit-reached"); expect(r.completedReviews).toBe(3);
  expect(f.state.sends.at(-1)[2]).toContain("One file could not be inspected"); expect(f.state.closed).toEqual(["review-tab"]);
}, 15000);

test("recheck CLI failure retains partial output, completed count and the earlier report", async () => {
  const f = await fixture(), first = await f.start(); let r = await reviewResult(f, first, [finding]);
  reply(f, sourceResponse(r)); await f.api.reviewSweep(); r = await retained(f);
  appendFileSync(f.state.reviewPath, JSON.stringify({ type: "assistant", sessionId: r.session, isApiErrorMessage: true, message: { content: [{ type: "text", text: "Provider rejected this recheck" }] } }) + "\n");
  await f.api.reviewSweep(); r = await retained(f);
  expect(r.state).toBe("failed"); expect(r.completedReviews).toBe(1); expect(r.rounds[0].findings).toEqual([finding]);
  expect(r.round.text).toContain("Provider rejected"); expect(f.state.closed).toEqual([]); expect(f.state.launches).toHaveLength(1);
}, 15000);

test("a replacement reviewer with the old labels and session arguments is left untouched", async () => {
  const f = await fixture(), first = await f.start(); await reviewResult(f, first, [finding]);
  f.state.terminals.find((t: any) => t.address === "t-reviewer").foreground.pid = 999;
  await f.api.reviewSweep();
  expect((await retained(f)).state).toBe("failed"); expect(f.state.killed).toEqual([]); expect(f.state.closed).toEqual([]);
}, 15000);

test("Claude and Codex source answers require all finding dispositions, reasons, checks and the pinned identity", async () => {
  for (const kind of ["claude", "codex"]) {
    const f = await fixture(); f.source.foreground.name = kind; f.source.status.app = kind;
    const first = await f.start(); let r = await reviewResult(f, first, [finding]);
    for (const invalid of [{ binding: "wrong conversation" }, { accepted: [], rejected: [{ findingId: `${r.round.reportId}-finding-1`, reason: "" }] }, { checks: [] }, { accepted: [] }]) reply(f, sourceResponse(r, invalid));
    await f.api.reviewSweep(); expect((await retained(f)).round.number).toBe(1);
    reply(f, sourceResponse(r)); await f.api.reviewSweep(); r = await retained(f); expect(r.round.number).toBe(2);
    expect(r.rounds[0].responses).toHaveLength(1);
  }
}, 15000);
