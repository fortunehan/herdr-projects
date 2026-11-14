import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, menuFor, parseDefaults, sessionOf } from "../core/agents.js";
import { FIND, Conversation } from "../core/chat-log.js";
import { CLEAN_ENV, AGENT_PATH } from "../core/clean-env.js";
import { ChangesReview, completedMessage, finished, reportText, sourceKey, DEFAULT_MODEL } from "../core/changes-review.js";
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
    if (args[0] === "get") return response(state.terminals.find((t: any) => t.address === args[1]));
    if (args[0] === "kill") { state.killed.push(args[1]); state.terminals.find((t: any) => t.address === args[1]).state = "finished"; return response({}); }
    if (args[0] === "send") {
      state.sends.push(args);
      if (state.rejectSend) return { code: 1, stdout: "", stderr: "blocked" };
      if (state.receipt) writeFileSync(state.sourcePath, JSON.stringify(source.foreground.name === "codex"
        ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: args[2] }] } }
        : { type: "user", sessionId: sourceId, message: { content: args[2] } }) + "\n");
      return response({ sent: true });
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
    ChangesReview, completedMessage, finished, reportText, sourceKey, chatPane };
  const src = readFileSync(new URL("../lib/reviews.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  const api: any = new Function(...Object.keys(bindings), src + "\nreturn { reviews, reviewRecords, reviewTick, reviewSweep };")(...Object.values(bindings));
  const target = { cwd: root, mode: "uncommitted", workspace: "workspace" };
  const start = async () => api.reviews.launch(await api.reviews.prepare(target), target);
  const complete = (r: any, findings: any[] = []) => ({ type: "completed", runId: r.id, roundId: r.round.id, reportId: r.round.reportId, session: r.session, complete: true, findings, text: "Full report text" });
  return { state, api, start, complete, target, commands, source, root, top };
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
});

test("real adapter preserves findings after delivery and leaves its Chat tab open", async () => {
  const f = await fixture(), r = await f.start(); f.state.receipt = true;
  await f.api.reviews.message(f.complete(r, [{ file: "a", line: 1, summary: "Complete finding", failure_scenario: "Input fails" }]));
  await f.api.reviews.tick(r.id);
  expect((await f.api.reviewRecords())[0].state).toBe("waiting-for-source"); expect(f.state.closed).toEqual([]); expect(f.state.killed).toEqual([]);
  expect(f.state.sends[0][2]).toContain("Complete finding");
});

test("real adapter sends nothing through a busy/question source and never uses force or keys", async () => {
  const f = await fixture(), r = await f.start(); await f.api.reviews.message(f.complete(r));
  for (const status of ["working", "blocked"]) { f.source.status.state = status; await f.api.reviews.tick(r.id); }
  expect(f.state.sends).toEqual([]);
  f.source.status.state = "idle"; f.state.rejectSend = true; await f.api.reviews.tick(r.id); await f.api.reviews.tick(r.id);
  expect(f.state.sends).toHaveLength(1); expect(f.state.sends[0]).not.toContain("--force");
  expect((await f.api.reviewRecords())[0].round.delivery.state).toBe("uncertain");
});

test("source transcript identity changes cannot retarget a saved report", async () => {
  const f = await fixture(), r = await f.start(); await f.api.reviews.message(f.complete(r));
  f.state.sourcePath = join(f.top, "22222222-2222-4222-8222-222222222222.jsonl"); writeFileSync(f.state.sourcePath, "");
  await f.api.reviews.tick(r.id);
  expect((await f.api.reviewRecords())[0].round.delivery.state).toBe("identity-changed"); expect(f.state.sends).toEqual([]);
});

test("tab creation failure kills only its own created reviewer and preserves an error report", async () => {
  const f = await fixture(); f.state.tabError = true;
  await expect(f.start()).rejects.toThrow("Tab creation failed");
  expect(f.state.killed).toEqual(["t-reviewer"]); expect(f.state.closed).toEqual([]);
  expect((await f.api.reviewRecords())[0].state).toBe("failed");
  expect(f.source.state).toBe("live");
});

test("durable reservation blocks overlapping launches even through independently loaded feature engines", async () => {
  const f = await fixture(), form = await f.api.reviews.prepare(f.target);
  await f.api.reviews.launch(form, f.target);
  await expect(f.start()).rejects.toThrow("already active"); expect(f.state.launches).toHaveLength(1);
});

test("a partial source echo is not final delivery and a replacement reviewer process is never killed", async () => {
  const f = await fixture(), r = await f.start(); await f.api.reviews.message(f.complete(r)); await f.api.reviews.tick(r.id);
  writeFileSync(f.state.sourcePath, JSON.stringify({ type: "user", message: { content: r.round.reportId } }) + "\n");
  await f.api.reviews.tick(r.id); expect(f.state.closed).toEqual([]);
  const reviewer = f.state.terminals.find((t: any) => t.address === "t-reviewer"); reviewer.argv = ["codex", "different-session"];
  await f.api.reviews.cancel(r.id); expect(f.state.killed).toEqual([]); expect(f.source.state).toBe("live");
});

test("catalog/skill discovery failures block the externally callable launch boundary", async () => {
  const f = await fixture(); f.state.catalogError = true;
  await expect(f.start()).rejects.toThrow("Catalog discovery failed"); f.state.catalogError = false; f.state.probe = false;
  await expect(f.start()).rejects.toThrow("bundled skill is missing"); expect(f.state.launches).toEqual([]);
});

function transcript(r: any, findings: any[] = []) {
  return [
    { type: "user", sessionId: r.session, message: { content: "<command-name>/code-review</command-name>" } },
    { type: "assistant", sessionId: r.session, perTurnEffort: r.effort, message: { content: [{ type: "tool_use", name: "ReportFindings", id: "result", input: { level: r.depth, findings } }] } },
    { type: "user", sessionId: r.session, message: { content: [{ type: "tool_result", tool_use_id: "result", content: "Reported" }] } },
    { type: "assistant", sessionId: r.session, message: { content: [{ type: "text", text: `<changes-review-complete>${JSON.stringify({ runId: r.id, roundId: r.round.id, reportId: r.round.reportId, complete: true, limitations: [] })}</changes-review-complete>` }] } },
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
});

test("manual reviewer tab closure cancels the run without sending reports", async () => {
  const f = await fixture(), r = await f.start(); f.state.panes = [f.state.panes[0]];
  await f.api.reviewSweep();
  expect((await f.api.reviewRecords())[0].state).toBe("cancelled");
  expect(f.state.sends).toEqual([]); expect(f.state.killed).toEqual(["t-reviewer"]);
});

test("a completed review never closes the workspace when its own tab is the last one", async () => {
  const f = await fixture(), r = await f.start(); f.state.tabCount = 1; f.state.receipt = true;
  await f.api.reviews.message(f.complete(r)); await f.api.reviews.tick(r.id);
  const kept = (await f.api.reviewRecords())[0];
  expect(kept.state).toBe("closing"); expect(kept.error).toContain("last tab");
  expect(kept.round.delivery.state).toBe("confirmed"); expect(f.state.closed).toEqual([]); expect(f.state.killed).toEqual(["t-reviewer"]);
});

test("Claude source receipts use the shared transcript reader too", async () => {
  const f = await fixture(); f.source.foreground.name = "claude"; f.source.status.app = "claude-code";
  const r = await f.start(); f.state.receipt = true; await f.api.reviews.message(f.complete(r)); await f.api.reviews.tick(r.id);
  expect((await f.api.reviewRecords())[0].state).toBe("passed");
});
