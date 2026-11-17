import { expect, test } from "bun:test";
import { act } from "./actions.ts";
import { Agents } from "./agents.ts";
import { execTemplate } from "./spaces.ts";
import { magpieModels } from "../core/agents.js";
import { Live } from "./live.ts";

test("the settings picker can pin provider-qualified magpie models", async () => {
  const pinned: string[] = [];
  const compat = { agents: { pin(agent: string, model: string) { pinned.push(`${agent}:${model}`); return { pinned, recent: [] }; } } };
  const result = await act({} as never, { type: "model-pin", agent: "claude", model: "openrouter/vendor/model" }, compat as never);
  expect(result).toEqual({ ok: true, picks: { pinned: ["claude:openrouter/vendor/model"], recent: [] } });
});

function fakeHub(reply: (argv: string[], on?: string) => { code?: number; stdout?: string; stderr?: string }) {
  const calls: { argv: string[]; on?: string }[] = [];
  return { terminals: new Map<string, any>(), calls, async call(method: string, args: any) {
    expect(method).toBe("machine.exec");
    calls.push(args);
    const r = reply(args.argv, args.on);
    return { code: r.code ?? 0, stdout: Buffer.from(r.stdout ?? "").toString("base64"), stderr: Buffer.from(r.stderr ?? "").toString("base64") };
  } };
}

test("unstarted Assistant menus retain a wrapper selection with its default model", async () => {
  const agents = new Agents(fakeHub(() => ({})) as never);
  agents.catalog = async () => ({ claude: {}, codex: {}, magpie: magpieModels("  copilot/other    Other  low/high\n") });
  agents.picks = () => ({ pinned: [], recent: [] });
  let menu = await agents.freshMenu("p:sp1", null, { agent: "claude", launcher: "magpie" });
  expect(menu.current).toMatchObject({ agent: "claude-magpie", model: "copilot/claude-sonnet-5.5", effort: "high" });
  expect(Object.keys(menu.menus)).toEqual(["claude", "codex", "claude-magpie", "claude-cdnd"]);
  expect(menu.menus["claude-magpie"].models.some((m: any) => m.id === "copilot/other")).toBe(true);
  agents.freshPicks.set("p:sp1", { agent: "claude", launcher: "cdnd", model: "typed/model", effort: "max" });
  menu = await agents.freshMenu("p:sp1", null, { agent: "codex" });
  expect(menu.current).toMatchObject({ agent: "claude-cdnd", model: "typed/model", effort: "max" });
  expect(menu.menus["claude-cdnd"].models[0].id).toBe("typed/model");
  const sent: any[] = [];
  const live: any = Object.create(Live.prototype);
  live.pages = new Set([{ data: { keys: ["p:sp1"] }, readyState: 1, send(text: string) { sent.push(JSON.parse(text)); } }]);
  live.compat = { addrOf: () => null, agents };
  live.refreshFresh();
  expect(sent[0].chat.agent).toMatchObject({ kind: "claude", model: "typed/model", effort: "max" });
  expect(sent[0].chat.working).toBe(false);
});

test("task and Assistant changes preflight a missing launcher on the target machine", async () => {
  const hub = fakeHub(() => ({ code: 1 }));
  const agents = new Agents(hub as never);
  for (const role of ["task", "coordinator"]) {
    const t = { state: "live", argv: ["claude"], foreground: { name: "claude", argv: ["claude"] }, labels: role === "task" ? { "herdr.task": "repo#1" } : {} };
    hub.terminals.set("vm/t1", t);
    await expect(agents.restart("vm/t1", {}, { kind: "claude-cdnd", model: "sonnet" })).rejects.toThrow("claude-cdnd is not installed");
  }
  expect(hub.calls).toHaveLength(2);
  expect(hub.calls.every((c) => c.on === "vm" && c.argv.includes('command -v "$1" >/dev/null 2>&1'))).toBe(true);
});

test("Assistant one-off templates use the chosen wrapper and keep the Claude session environment clean", async () => {
  const hub = fakeHub((argv) => ({ stdout: argv[2]?.includes('cat "$dir/$1.md"') ? "---\ncommand: claude\n---\nAssistant instructions\n" : "" }));
  for (const launcher of ["magpie", "cdnd"]) {
    const tpl = await execTemplate(hub as never, "assistant", "vm", { agent: "claude", launcher, model: "custom/model", effort: "high" });
    expect(tpl.argv?.slice(0, 5)).toEqual([`claude-${launcher}`, "--model", "custom/model", "--effort", "high"]);
    expect(tpl.words).toBe("Assistant instructions");
    const write = hub.calls.findLast((c) => c.argv[2]?.includes('printf "%s"'))!;
    expect(write.argv.at(-1)).toContain(`exec 'claude-${launcher}'`);
    expect(write.argv.at(-1)).toContain('do unset "$v"; done');
    expect(write.on).toBe("vm");
    tpl.done();
  }
  const missing = fakeHub((argv) => argv[2]?.startsWith("command -v") ? { code: 1 } : { stdout: "---\ncommand: claude\n---\nInstructions" });
  await expect(execTemplate(missing as never, "assistant", null, { agent: "claude-cdnd" })).rejects.toThrow("is not installed");
  expect(missing.calls).toHaveLength(2);
});
