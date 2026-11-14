import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, parseDefaults, menuFor, modelSections, argvFor } from "./agents.js";
import { choicesFrom, roleSel } from "./settings.js";

function defaultsFrom(settings, custom = false) {
  const home = mkdtempSync(join(tmpdir(), "agent-defaults-"));
  try {
    const config = join(home, custom ? "custom-config" : ".claude");
    mkdirSync(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify(settings));
    const result = Bun.spawnSync(["/bin/sh", "-c", DEFAULTS, "defaults", "claude"], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: custom ? config : "" } });
    expect(result.exitCode).toBe(0);
    return parseDefaults("claude", result.stdout.toString());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("shared Claude catalog follows the CLI's custom configuration directory", () => {
  const dflt = defaultsFrom({ modelPicker: { options: [{ model: "codex/gpt-6-astra", label: "Custom Astra" }] } }, true);
  expect(menuFor("claude", dflt).models.map((m) => ({ id: m.id, name: m.name }))).toEqual([{ id: "codex/gpt-6-astra", name: "Custom Astra" }]);
});

test("Claude chat discovers Magpie's configured picker before a model is selected", () => {
  const dflt = defaultsFrom({ model: "sonnet", effortLevel: "high", modelPicker: { options: [
    { model: "codex/gpt-6.1-sol", label: "GPT-6.1-Sol · Codex", description: "via magpie" },
    { model: "copilot/claude-sonnet-5-5", label: "Claude Sonnet 5.5 · Copilot" },
    { model: "auto/gpt-6.1-sol", label: "GPT-6.1 Sol · routing group" },
  ] } });
  const menu = menuFor("claude", dflt, "sonnet");
  const model = menu.models.find((m) => m.id === "codex/gpt-6.1-sol");
  expect(model).toMatchObject({ name: "GPT-6.1-Sol · Codex", defaultEffort: "high", fast: false });
  expect(menu.models.map((m) => m.id)).toEqual(["sonnet", "codex/gpt-6.1-sol", "copilot/claude-sonnet-5-5", "auto/gpt-6.1-sol"]);
  expect(modelSections({ claude: menu }, "claude", null, "")[0].rows.some((r) => r.id === model.id)).toBe(true);
  expect(modelSections({ claude: menu }, "claude", null, "GPT-6.1-Sol Codex")[0].rows[0]).toMatchObject({ agent: "claude", id: model.id, name: model.name });
  expect(argvFor({ agent: "claude", model: model.id }, { agent: "claude", argv: ["claude"] }).argv).toContain(model.id);
});

test("configured picker preserves labels and per-model effort without requiring Magpie", () => {
  const dflt = defaultsFrom({ effortLevel: "low", modelSettings: { "vendor/reasoner": { effortLevel: "max" } }, modelPicker: { options: [
    { model: "vendor/reasoner", label: "My reasoning model" },
    { model: "vendor/unlabelled" },
    { model: "opus", label: "My Opus" },
  ] } });
  expect(menuFor("claude", dflt).models).toMatchObject([
    { id: "vendor/reasoner", name: "My reasoning model", defaultEffort: "max", fast: false },
    { id: "vendor/unlabelled", name: "vendor/unlabelled", defaultEffort: "low", fast: false },
    { id: "opus", name: "My Opus", defaultEffort: "low", fast: true },
  ]);
});

test("Settings keeps explicit models and uses the configured catalog for unset roles", () => {
  const dflt = defaultsFrom({ model: "codex/gpt-6.1-sol", modelPicker: { options: [
    { model: "copilot/claude-sonnet-5-5", label: "Claude Sonnet 5.5 · Copilot" },
    { model: "codex/gpt-6.1-sol", label: "GPT-6.1-Sol · Codex" },
  ] } });
  const choices = choicesFrom({ claude: dflt });
  expect(choices.defaults).toMatchObject({ agent: "claude", model: "codex/gpt-6.1-sol" });
  expect(roleSel("reviewer", null, choices, "codex").sel).toMatchObject({ agent: "claude", model: "copilot/claude-sonnet-5-5" });
  const own = { agent: "claude", model: "codex/gpt-6.1-sol", effort: "high" };
  expect(roleSel("reviewer", own, choices, "codex").sel).toEqual(own);
});

test("configured picker skips invalid rows and repeated IDs", () => {
  const dflt = defaultsFrom({ modelPicker: { options: [null, 4, {}, { model: 4 }, { model: " " },
    { model: "vendor/model", label: "First" }, { model: "vendor/model", label: "Repeated" },
    { model: "vendor/other", label: 4 },
  ] } });
  expect(menuFor("claude", dflt).models.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: "vendor/model", name: "First" }, { id: "vendor/other", name: "vendor/other" },
  ]);
});

test("without usable configured rows Claude keeps its built-in model list and settings", () => {
  for (const modelPicker of [undefined, {}, { options: [] }, { options: null }, { options: {} }, { options: [null, {}] }]) {
    const dflt = defaultsFrom({ model: "sonnet", effortLevel: "high", modelPicker });
    expect(dflt).toMatchObject({ model: "sonnet", effort: "high" });
    expect(menuFor("claude", dflt)).toEqual(menuFor("claude", { effort: "high" }));
  }
});
