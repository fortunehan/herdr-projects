import { expect, test } from "bun:test";
import { argvFor, claudeWindow, contextUse, current, line, menuFor, modelSections, parseDefaults, parsePicks, pickKey, withPin, withRecent, usageUse, parseUsage, USAGE_FILE, USAGE_STALE, STATUS_LINE } from "./agents.js";

const codex = { models: Array.from({ length: 250 }, (_, i) => ({ id: `gpt-${i}`, label: `GPT ${i}`, efforts: ["low", "high"] })) };
const menus = { claude: menuFor("claude", {}), codex: menuFor("codex", codex) };

test("Codex lists every model it has, not its first five", () => {
  expect(menus.codex.models.length).toBe(250);
});

test("nothing typed: pinned, then recent, then the rest of the agent shown", () => {
  const picks = withRecent(withPin(parsePicks(""), pickKey("claude", "haiku")), pickKey("claude", "sonnet"));
  const s = modelSections(menus, "claude", picks, "");
  expect(s.map((x) => x.title)).toEqual(["Pinned", "Recent", "All models"]);
  expect(s[0].rows.map((r) => r.id)).toEqual(["haiku"]);
  expect(s[1].rows.map((r) => r.id)).toEqual(["sonnet"]);
  expect(s[2].rows.some((r) => r.id === "haiku" || r.id === "sonnet")).toBe(false);
});

test("a long list is capped and counts the rest", () => {
  const [all] = modelSections(menus, "codex", null, "");
  expect(all.rows.length).toBe(200);
  expect(all.more).toBe(50);
});

test("typed: every agent's matches, and a row to use the id typed", () => {
  const s = modelSections(menus, "codex", null, "opus 1m");
  expect(s.map((x) => x.key)).toEqual(["claude"]);
  expect(s[0].rows.map((r) => r.id)).toEqual(["opus[1m]"]);
  const t = modelSections(menus, "codex", null, "gpt-7-preview").find((x) => x.key === "typed");
  expect(t.rows.map((r) => [r.agent, r.id, r.typed])).toEqual([["codex", "gpt-7-preview", true], ["claude", "gpt-7-preview", true]]);
  expect(modelSections(menus, "codex", null, "gpt-999").map((x) => x.key)).toEqual(["typed"]);
  expect(modelSections(menus, "codex", null, "gpt-12").find((x) => x.key === "typed").rows.map((r) => r.agent)).toEqual(["claude"]);
});

test("an exact id typed needs no extra row; picks survive bad files", () => {
  expect(parsePicks("not json")).toEqual({ pinned: [], recent: [] });
  expect(withPin(withPin(parsePicks(""), "a:b"), "a:b").pinned).toEqual([]);
});

test("a running model typed by id stays in its agent's list", () => {
  expect(menuFor("claude", {}, "claude-opus-4-8").models[0]).toMatchObject({ id: "claude-opus-4-8", name: "Opus 4.8" });
});

test("a pinned or recent model typed by id stays on offer", () => {
  const picks = withRecent(withPin(parsePicks(""), "claude:claude-opus-4-8"), "codex:gpt-x");
  expect(modelSections(menus, "claude", picks, "")[0].rows[0]).toMatchObject({ id: "claude-opus-4-8", name: "Opus 4.8", pinned: true });
  expect(modelSections(menus, "codex", picks, "")[0]).toMatchObject({ title: "Recent", rows: [{ id: "gpt-x" }] });
  expect(modelSections(menus, "claude", picks, "gpt-x").map((x) => x.key)).toEqual(["codex", "typed"]);
});

// SHEP-41: Fast was hidden (and stuck on) for a Codex whose config.toml set service_tier.
test("every agent with a fast mode shows the Fast switch, and turning it off sticks", () => {
  const cache = JSON.stringify({ models: [{ slug: "gpt-x", display_name: "GPT-X", supported_reasoning_levels: [{ effort: "high" }], service_tiers: [{ id: "priority" }] },
    { slug: "gpt-slow", display_name: "GPT-Slow", service_tiers: [] }] });
  const dflt = parseDefaults("codex", `model\tgpt-x\nservice_tier\tfast\nmodels\t${cache}\n`);
  const codexMenu = menuFor("codex", dflt);
  expect(codexMenu.models.find((m) => m.id === "gpt-x").fast).toBe(true);
  expect(codexMenu.models.find((m) => m.id === "gpt-slow").fast).toBe(false);
  expect(codexMenu.fastLocked).toBeUndefined();
  expect(menuFor("claude", {}).models.find((m) => m.id === "opus").fast).toBe(true);
  // off: said on the command line, so config.toml's fast loses, and the label reads it back
  const off = argvFor({ agent: "codex", model: "gpt-x", effort: "high", fast: false }, { agent: "codex", argv: ["codex", "-c", 'service_tier="fast"'] }).argv;
  expect(off.filter((a) => a.startsWith("service_tier"))).toEqual(['service_tier="default"']);
  expect(current("codex", off, {}, dflt).fast).toBe(false);
  expect(line(current("codex", off, {}, dflt))).toBe("Codex · GPT-X · High");
  const on = argvFor({ agent: "codex", model: "gpt-x", fast: true }, { agent: "codex", argv: off }).argv;
  expect(current("codex", on, {}, dflt).fast).toBe(true);
  const claudeOff = argvFor({ agent: "claude", model: "opus", fast: false }, { agent: "claude", argv: ["claude"] }).argv;
  expect(current("claude", claudeOff, {}, { fast: true }).fast).toBe(false);
});

// SHEP-8: the chat's model button shows how full the context window is.
test("Claude's context window: 1M for Opus, Sonnet and Fable from 4.6 on, 200k for Haiku and older ones", () => {
  expect(claudeWindow("claude-opus-5-5", "opus")).toBe(1000000);
  expect(claudeWindow("claude-sonnet-5-5", null)).toBe(1000000);
  expect(claudeWindow("claude-fable-5-1", null)).toBe(1000000);
  expect(claudeWindow("claude-opus-4-6", null)).toBe(1000000);
  expect(claudeWindow("claude-haiku-5-5", "haiku")).toBe(200000);
  expect(claudeWindow("claude-opus-4-5-20251101", null)).toBe(200000);
  expect(claudeWindow("claude-opus-4-20250514", null)).toBe(200000);
  expect(claudeWindow("claude-haiku-5-5", "haiku[1m]")).toBe(1000000);
  expect(claudeWindow("claude-opus-4-5", null, 250000)).toBe(1000000);
  expect(claudeWindow(null, "opus")).toBe(1000000);
  expect(claudeWindow(null, "haiku")).toBe(200000);
});

test("the context in use: its share of the window, tinted past 80%, nothing while unknown", () => {
  const c = current("claude", [], { model: "claude-opus-5-5", used: 116000, at: 2000 }, {}, 1000);
  expect(contextUse(c)).toEqual({ pct: 12, high: false, words: "12%", used: "116k", title: "116k of 1M tokens" });
  expect(contextUse(current("claude", ["--model", "haiku"], { model: "claude-haiku-5-5", used: 170000 }, {}))).toMatchObject({ pct: 85, high: true, title: "170k of 200k tokens" });
  expect(contextUse(current("claude", [], { model: "claude-opus-5-5", used: 800000 }, {})).high).toBe(false);
  expect(contextUse(current("claude", [], { model: "claude-opus-5-5", used: 810000 }, {})).high).toBe(true);
  expect(contextUse(current("claude", [], {}, {}))).toBeNull();
  expect(contextUse(current("claude", [], { used: 0 }, {}))).toBeNull();
  expect(contextUse(null)).toBeNull();
});

test("a resumed conversation's context from before this process isn't shown", () => {
  const meta = { model: "claude-opus-5-5", effort: "high", used: 400000, at: 1000 };
  const c = current("claude", ["--model", "sonnet"], meta, {}, 5000);
  expect(c.model).toBe("sonnet");
  expect(contextUse(c)).toBeNull();
  expect(contextUse(current("claude", [], { ...meta, at: 6000 }, {}, 5000)).words).toBe("40%");
});

test("Codex: its log's own usage and window, nothing without them", () => {
  expect(contextUse(current("codex", [], { model: "gpt-x", used: 129000, window: 258400, at: 2000 }, {}, 1000))).toMatchObject({ pct: 50, title: "129k of 258k tokens" });
  expect(contextUse(current("codex", [], { model: "gpt-x", used: 129000 }, {}))).toBeNull();
});

// SHEP-12: the subscription's 5-hour and 7-day windows beside the context pie.
test("usage: both windows as words, when each resets, amber past 80%", () => {
  const now = new Date(2026, 10, 8, 14, 0).getTime();
  const snap = { at: now - 60000, five_hour: { used_percentage: 34.4, resets_at: new Date(2026, 10, 8, 18, 40).getTime() / 1000 },
    seven_day: { used_percentage: 81, resets_at: new Date(2026, 10, 10, 9, 0).getTime() / 1000 } };
  const u = usageUse(snap, now);
  expect(u.words).toBe("5h 34% · 7d 81%");
  expect(u.title).toBe("5h resets 18:40, 7d resets Tue 09:00");
  expect(u.high).toBe(true);
  expect(u.windows.map((w) => w.high)).toEqual([false, true]);
  expect(usageUse({ ...snap, seven_day: { ...snap.seven_day, used_percentage: 80 } }, now).high).toBe(false);
  // past 100 or below 0 stays in range
  expect(usageUse({ five_hour: { used_percentage: 104, resets_at: now / 1000 + 60 } }, now).words).toBe("5h 100%");
});

test("usage: a window that has reset drops out, an old or missing snapshot shows nothing", () => {
  const now = new Date(2026, 10, 8, 23, 30).getTime();
  const five = { used_percentage: 20, resets_at: new Date(2026, 10, 9, 1, 15).getTime() / 1000 };
  const seven = { used_percentage: 61, resets_at: now / 1000 - 1 };
  // the 5h window resets after midnight: its day is named
  expect(usageUse({ at: now, five_hour: five, seven_day: seven }, now)).toMatchObject({ words: "5h 20%", title: "5h resets Mon 01:15" });
  expect(usageUse({ at: now, five_hour: { ...five, resets_at: now / 1000 }, seven_day: seven }, now)).toBeNull();
  expect(usageUse({ at: now - USAGE_STALE - 1, five_hour: five }, now)).toBeNull();
  expect(usageUse({ at: now - USAGE_STALE + 1000, five_hour: five }, now)).not.toBeNull();
  expect(usageUse(null, now)).toBeNull();
  expect(usageUse({}, now)).toBeNull();
  expect(usageUse({ five_hour: { used_percentage: "20", resets_at: five.resets_at } }, now)).toBeNull();
});

test("usage file: parsed down to its numbers; missing or broken is nothing", () => {
  expect(parseUsage(JSON.stringify({ at: 5, five_hour: { used_percentage: 1, resets_at: 2, extra: "x" }, cwd: "/secret" })))
    .toEqual({ at: 5, five_hour: { used_percentage: 1, resets_at: 2 } });
  expect(parseUsage(null)).toBeNull();
  expect(parseUsage("{")).toBeNull();
  expect(parseUsage("{}")).toBeNull();
  expect(USAGE_FILE).toBe("claude.json");
});

test("a Claude agent Shepherdr starts runs its status line through bin/shepherdr-statusline", () => {
  const a = argvFor({ agent: "claude", model: "opus", fast: false }, { agent: "claude", argv: ["claude"] }).argv;
  const s = JSON.parse(a[a.indexOf("--settings") + 1]);
  expect(s).toEqual({ fastMode: false, statusLine: STATUS_LINE });
  expect(STATUS_LINE.command).toContain(".local/bin/shepherdr-statusline");
});
