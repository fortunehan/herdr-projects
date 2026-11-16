import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { agentKey, argvFor, freshArgv, forkArgv, launchArgv, magpieArgv, magpieModels, MAGPIE_MODEL, MAGPIE_RUN, current, line } from "./agents.js";
import { chooseLauncher, chooseModel, choicesFrom, mergeWorker, roleSel, workerChoices } from "./settings.js";
import { kindOf } from "./chat-reader.js";
import { cliOf, starting } from "./screens.js";
import { subagentCli } from "./chat-view.js";

test("Claude identity, status and startup cards accept the magpie command", () => {
  expect(agentKey("/bin/claude-magpie")).toBe("claude");
  expect(kindOf({ foreground: { name: "claude-magpie" } })).toBe("claude");
  expect(kindOf({ status: { app: "claude-code" }, foreground: { name: "claude-magpie" } })).toBe("claude");
  expect(cliOf({ agent: "claude-magpie" })).toBe("claude");
  expect(starting({ state: "live", foreground: { name: "claude-magpie" } })).toBe(true);
  expect(subagentCli({ argv: ["claude-magpie"] })).toBe("claude");
  const c = current("claude", ["claude-magpie", "--model", MAGPIE_MODEL, "--effort", "high"], {}, {});
  expect(line(c)).toBe(`Claude Code · ${MAGPIE_MODEL} · High`);
});

test("generated argv uses magpie defaults and Claude permissions, Codex stays Codex", () => {
  const pick = { agent: "claude", launcher: "magpie", perm: "auto" };
  const a = argvFor(pick, {});
  expect(a.base.slice(0, 5)).toEqual(["claude-magpie", "--model", MAGPIE_MODEL, "--effort", "high"]);
  expect(a.base.slice(-2)).toEqual(["--permission-mode", "auto"]);
  expect(argvFor({ ...pick, model: "other/model", effort: "max" }, { agent: "claude", session: "S1" }).argv).toContain("other/model");
  expect(argvFor({ agent: "codex", launcher: "magpie" }, {}).argv[0]).toBe("codex");
});

test("fresh start and fork keep the saved launcher, model and effort through wrappers", () => {
  const base = ["claude-magpie", "--model", MAGPIE_MODEL, "--effort", "high"];
  for (const argv of [base, magpieArgv(base)]) {
    const resumed = [...argv, "--resume", "S1", "old words"];
    expect(freshArgv("claude", resumed)).toEqual(argv);
    expect(forkArgv("claude", argv, "S1")).toEqual([...argv, "--resume", "S1", "--fork-session"]);
  }
  const terminal = { argv: magpieArgv(base), foreground: { argv: ["claude", "--effort", "high"] } };
  expect(launchArgv(terminal)).toEqual(terminal.argv);
  const recovered = { ...terminal, argv: ["/bin/zsh"], labels: { "herdr.resume": JSON.stringify({ argv: magpieArgv(base), session: "S1" }) } };
  expect(freshArgv("claude", launchArgv(recovered))).toEqual(magpieArgv(base));
  expect(forkArgv("claude", launchArgv(recovered), "S1")).toEqual([...magpieArgv(base), "--resume", "S1", "--fork-session"]);
  recovered.labels["herdr.resume"] = JSON.stringify({ argv: base, session: "S1" });
  expect(freshArgv("claude", launchArgv(recovered))).toEqual(base);
});

test("launcher layers drop models only on a change and keep effort", () => {
  const parent = { agent: "claude", launcher: "magpie", model: "space/model", effort: "max" };
  expect(mergeWorker(parent, { launcher: "magpie" })).toEqual(parent);
  expect(mergeWorker(parent, { launcher: "direct" })).toEqual({ agent: "claude", launcher: "direct", effort: "max" });
  expect(mergeWorker(parent, { launcher: "direct", model: "sonnet" }).model).toBe("sonnet");
  expect(mergeWorker(parent, { agent: "codex" })).toEqual({ agent: "codex" });
  expect(chooseLauncher({ ...parent, launcher: "direct" }, "magpie")).toMatchObject({ launcher: "magpie", model: MAGPIE_MODEL, effort: "max" });
  expect(chooseLauncher(parent, "direct").model).toBeNull();
});

test("magpie model catalog uses provider IDs, supports nested IDs and falls back to a typed model", () => {
  const catalog = magpieModels("  Copilot\n  copilot/claude-sonnet-5.5     Claude Sonnet 5.5  low/medium/high/max\n  openrouter/vendor/model     Model\n  http://127.0.0.1:3425/v1\n");
  expect(catalog.models.map((m) => m.id)).toEqual([MAGPIE_MODEL, "openrouter/vendor/model"]);
  expect(catalog.models[0].efforts).toEqual(["low", "medium", "high", "max"]);
  const choices = choicesFrom({ claude: {}, codex: {}, magpie: catalog });
  const pick = roleSel("worker", { launcher: "magpie" }, choices, "claude").sel;
  expect(pick).toMatchObject({ agent: "claude", launcher: "magpie", model: MAGPIE_MODEL });
  expect(workerChoices(choices, pick).menus.claude).toBe(catalog);
  expect(choices.menus.claude.models[0].id).toBe("opus");
  expect(magpieModels("").models[0].id).toBe(MAGPIE_MODEL);
  const codexMenu = { ...choices.menus, codex: { models: [{ id: "gpt-x", efforts: ["high"] }] } };
  expect(chooseModel(codexMenu, {}, pick, "codex", "gpt-x").launcher).toBeUndefined();
});

test("Python and JavaScript use the same fallback program, valid under bash", () => {
  const src = readFileSync(new URL("../mods/tasks/bin/herdr_task/launch.py", import.meta.url), "utf8");
  expect(src.match(/MAGPIE_RUN = r'''([\s\S]*?)'''/)[1]).toBe(MAGPIE_RUN);
  const result = Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(MAGPIE_RUN) });
  expect(result.exitCode).toBe(0);
});
