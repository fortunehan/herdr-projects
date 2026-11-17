import { expect, spyOn, test } from "bun:test";
import { act } from "./actions.ts";
import { Agents } from "./agents.ts";
import { execTemplate } from "./spaces.ts";
import { LAUNCHER_COMMANDS, MAGPIE_MODEL, magpieModels } from "../core/agents.js";
import { Live } from "./live.ts";

const launchers = ["cdnd", "magpie", "direct"] as const;

test("the settings picker can pin provider-qualified magpie models", async () => {
  const pinned: string[] = [];
  const compat = { agents: { pin(agent: string, model: string) { pinned.push(`${agent}:${model}`); return { pinned, recent: [] }; } } };
  const result = await act({} as never, { type: "model-pin", agent: "claude", model: "openrouter/vendor/model" }, compat as never);
  expect(result).toEqual({ ok: true, picks: { pinned: ["claude:openrouter/vendor/model"], recent: [] } });
});

test("composer selection uses the declared Cdnd launch instead of a stale Magpie resume record", async () => {
  const hub = fakeHub(() => ({}));
  const sent: string[] = [];
  Object.assign(hub, { send: async (_addr: string, text: string) => {
    sent.push(text);
    throw new Error("API Error: 400 model: copilot/claude-sonnet-5.5 is not a Claude model; cdnd serves Claude models only.");
  } });
  hub.terminals.set("t1", { state: "live", argv: ["sh", "-c", "template"], status: { state: "idle" },
    foreground: { name: "claude", argv: ["claude", "--model", "sonnet"] }, labels: {
      "herdr.launcher.argv": JSON.stringify(["claude-cdnd", "--model", "sonnet"]),
      "herdr.resume": JSON.stringify({ argv: ["claude-magpie"], session: "old" }),
    } });
  const agents = new Agents(hub as never);
  let restarted = false;
  agents.restart = async () => { restarted = true; return "t2"; };
  const result = await act(hub as never, JSON.parse(JSON.stringify({ type: "restart", live: true, chat: "t1",
    kind: "claude-magpie", model: "copilot/claude-sonnet-5.5", effort: "high", perm: "manual" })),
    { agents, addrOf: () => "t1", reader: () => ({ kind: "claude" }) } as never);
  expect(result).toEqual({ ok: true, terminal: "t2" });
  expect(restarted).toBe(true);
  expect(sent).toEqual([]);
});

test("serialized web launcher changes restart task workers and Assistants without live model commands", async () => {
  const calls: { cmd: string[]; options: any }[] = [];
  const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: any) => {
    calls.push({ cmd, options });
    const output = cmd[0] === "herdr-task" ? '{"terminal":"t2"}' : "t2\n";
    return { stdout: new Response(output).body, stderr: new Response("").body, exited: Promise.resolve(0) };
  }) as any);
  try {
    for (const from of launchers) for (const to of launchers) {
      if (from === to) continue;
      for (const task of [false, true]) for (const model of ["", to === "magpie" ? MAGPIE_MODEL : "sonnet"]) {
        calls.length = 0;
        const hub = fakeHub(() => ({}));
        const sent: string[] = [];
        Object.assign(hub, { send: async (_a: string, text: string) => { sent.push(text); throw new Error("must restart"); } });
        hub.terminals.set("t1", { state: "live", cwd: "/repo", argv: ["sh", "-c", "template"],
          status: { state: "idle" }, foreground: { name: "claude", argv: ["claude", "--model=old/provider", "--fallback-model", "old/fallback", "--permission-mode", "plan", "--add-dir", "/extra"] },
          labels: { "herdr.chat": "p1", "herdr.chat.origin": "t0", "herdr.role": "coordinator",
            "herdr.launcher.argv": JSON.stringify([LAUNCHER_COMMANDS[from]]), ...(task ? { "herdr.task": "repo#1" } : {}) } });
        const agents = new Agents(hub as never);
        (agents as any).used = () => {};
        const compat = { agents, addrOf: () => "t1", reader: () => ({ kind: "claude", path: "/logs/11111111-1111-1111-1111-111111111111.jsonl" }) };
        const result = await act(hub as never, JSON.parse(JSON.stringify({ type: "restart", live: true, chat: "t1", kind: "claude", launcher: to,
          model, effort: "max", perm: "plan" })), compat as never);
        expect(result).toEqual({ ok: true, terminal: "t2" });
        expect(sent).toEqual([]);
        const start = calls.find((c) => c.cmd[0] === (task ? "herdr-task" : "bash"))!;
        const argv = JSON.parse(task ? start.cmd[start.cmd.indexOf("--argv") + 1] : start.cmd[3]);
        expect(argv[0]).toBe(LAUNCHER_COMMANDS[to]);
        expect(argv.includes("--resume")).toBe(false);
        expect(argv).not.toContain("old/provider");
        expect(argv).not.toContain("old/fallback");
        expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "plan"]);
        expect(argv).toContain("/extra");
        if (model || to === "magpie") expect(argv[argv.indexOf("--model") + 1]).toBe(model || MAGPIE_MODEL);
        else expect(argv).not.toContain("--model");
        if (task) {
          expect(start.cmd.slice(1, 5)).toEqual(["switch", "repo#1", "--folder", "/repo"]);
          expect(calls.some((c) => c.cmd.includes("herdr.chat.origin=t0"))).toBe(true);
        } else {
          expect(start.options.env.HERDR_RESTART_RESUME).toBe("");
          expect(start.options.env.HERDR_RESTART_CHAT).toBe("p1");
        }
      }
    }
  } finally { spawn.mockRestore(); }
});

test("models and effort within each unchanged launcher still switch live", async () => {
  let screen = "";
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response(screen).body, stderr: new Response("").body, exited: Promise.resolve(0) })) as any);
  try {
    for (const launcher of launchers) {
      const hub = fakeHub(() => ({}));
      const sent: string[] = [];
      Object.assign(hub, { send: async (_addr: string, text: string) => { sent.push(text); screen += `\n❯ ${text}\nSet model to selected\nSet effort level to high\n`; return { code: 0 }; } });
      hub.terminals.set("t1", { state: "live", foreground: { name: "claude", argv: ["claude", "--model", "old"] },
        labels: { "herdr.launcher.argv": JSON.stringify([LAUNCHER_COMMANDS[launcher]]) } });
      const agents = new Agents(hub as never);
      (agents as any).used = () => {};
      agents.restart = async () => { throw new Error("must stay live"); };
      expect(await agents.change("t1", {}, { kind: LAUNCHER_COMMANDS[launcher], model: launcher === "magpie" ? MAGPIE_MODEL : "sonnet", effort: "high" })).toEqual({ live: true });
      expect(sent).toEqual([`/model ${launcher === "magpie" ? MAGPIE_MODEL : "sonnet"}`, "/effort high"]);
    }
  } finally { spawn.mockRestore(); }
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
  expect(hub.calls.every((c) => c.on === "vm" && c.argv.some((a) => a.includes("command -v")))).toBe(true);
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
  const missing = fakeHub((argv) => argv[2]?.includes("command -v") ? { code: 1 } : { stdout: "---\ncommand: claude\n---\nInstructions" });
  await expect(execTemplate(missing as never, "assistant", null, { agent: "claude-cdnd" })).rejects.toThrow("is not installed");
  expect(missing.calls).toHaveLength(2);
});
