import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as agent from "./agents.js";

const menuSource = readFileSync(new URL("../mods/chat-models/main.js", import.meta.url), "utf8");
function method(source, name) {
  const match = source.match(new RegExp(`\\n  ${name}\\([^]*?\\n  \\}\\n`));
  if (!match) throw new Error(`Missing ${name}`);
  return match[0];
}
function composerPick(from, to, model) {
  let request;
  const methods = new Function("normalizePick", "permAcross", "setShared", "closeOverlay", `return {${method(menuSource, "choose")},${method(menuSource, "restart")}}`)(
    agent.normalizePick, agent.permAcross, (_key, value) => { request = JSON.parse(JSON.stringify(value)); }, () => {});
  const menu = { ...methods, p: { pane: "p1" }, sel: agent.viewPick({ agent: "claude", launcher: from, model: "old", perm: "auto" }), level: () => "high" };
  menu.choose({ agent: agent.LAUNCHER_COMMANDS[to], id: model, efforts: ["high"], fast: false });
  menu.restart({ spawn() {} });
  return request.pick;
}

for (const from of ["cdnd", "magpie", "direct"]) for (const to of ["cdnd", "magpie", "direct"]) {
  test(`composer ${from} to ${to} ${from === to ? "resumes" : "hands off"} with the selected model and permissions`, async () => {
    const model = to === "magpie" ? agent.MAGPIE_MODEL : "sonnet";
    const pick = composerPick(from, to, model);
    const terminal = { address: "t1", argv: ["sh", "-c", "template"], foreground: { argv: ["claude", "--model", "old", "--fallback-model=old/provider", "--add-dir", "/repo"] },
      labels: { "herdr.launcher.argv": JSON.stringify([agent.LAUNCHER_COMMANDS[from]]) } };
    let built;
    const source = readFileSync(new URL("../mods/chat/main.js", import.meta.url), "utf8");
    const chat = new Function("agent", "hc", "toast", `return {${method(source, "applyPick")}}`)(
      { ...agent, restart: async (_t, value) => { built = value; return "t2"; } }, async () => ({ stdout: JSON.stringify(terminal) }), () => {});
    const pending = [];
    const cx = { spawn(fn) { pending.push(fn(cx)); }, notify() {}, timer: { after() {} } };
    chat.applyPick.call({ ...chat, myPane: () => "p1", t: terminal, addr: "t1", kind: "claude", path: "11111111-1111-1111-1111-111111111111.jsonl", follow_to() {} }, pick, cx);
    await Promise.all(pending);
    expect(built.argv[0]).toBe(agent.LAUNCHER_COMMANDS[to]);
    expect(built.argv).toContain(model);
    expect(built.argv.slice(built.argv.indexOf("--permission-mode"), built.argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "auto"]);
    expect(built.argv).toContain("/repo");
    expect(built.argv).not.toContain("old");
    expect(built.resume).toBe(from === to);
    expect(built.argv.includes("--resume")).toBe(from === to);
    expect(built.argv.includes("--fallback-model=old/provider")).toBe(from === to);
  });
}

test("normalized composer choices retain their launcher across serialization", () => {
  let request;
  const menu = new Function("normalizePick", "setShared", "closeOverlay", `return {${method(menuSource, "restart")}}`)(agent.normalizePick, (_key, value) => { request = JSON.parse(JSON.stringify(value)); }, () => {});
  menu.restart.call({ sel: { agent: "claude", launcher: "magpie", model: agent.MAGPIE_MODEL, perm: "plan" }, p: { pane: "p1" }, level: () => "max" }, { spawn() {} });
  expect(request.pick).toEqual({ agent: "claude", launcher: "magpie", model: agent.MAGPIE_MODEL, perm: "plan", effort: "max" });
});

test("desktop restart forwards the selected launcher and preserves the task or Assistant chat", async () => {
  const source = readFileSync(new URL("../lib/agent.js", import.meta.url), "utf8").split("export async function restart(")[1];
  for (const task of [false, true]) {
    const calls = [];
    const restart = new Function("exec", "hc", "appHome", "requireLauncher", "chatLabel", `return async function restart(${source}`)(
      async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: cmd === "herdr-task" ? '{"terminal":"t2"}' : "t2\n" }; },
      async (args) => { calls.push(["hc", args]); }, () => "/layout", async () => {}, (pane) => pane);
    const built = agent.argvFor(composerPick("cdnd", "magpie", agent.MAGPIE_MODEL), { agent: "claude", launcher: "cdnd", session: "S1" });
    expect(await restart({ address: "t1", cwd: "/repo", labels: { "herdr.chat.origin": "t0", ...(task ? { "herdr.task": "repo#1" } : {}) } }, built, "p1")).toBe("t2");
    if (task) {
      expect(calls[0]).toEqual(["herdr-task", ["switch", "repo#1", "--folder", "/repo", "--argv", JSON.stringify(built.base), "--json"]]);
      expect(calls[1]).toEqual(["hc", ["label", "t2", "herdr.chat=p1", "herdr.chat.origin=t0"]]);
    } else {
      expect(calls[0][1][1]).toContain('HERDR_RESTART_RESUME= bash');
      expect(calls[0][1].slice(-3)).toEqual(["/layout/mods/coordinator/restart.sh", "t1", JSON.stringify(built.argv)]);
    }
  }
});
