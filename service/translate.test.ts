import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Translator } from "./translate.ts";

// a stub translation endpoint on 127.0.0.1, never a real API: [zh]/[en] in front of each string; `mode` breaks it
let mode: "ok" | "short" | "401" | "garbage" = "ok";
const seen: { auth: string | null; body: any }[] = [];
const stub = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const body = await req.json();
    seen.push({ auth: req.headers.get("authorization"), body });
    if (mode === "401") return Response.json({ error: { message: "Incorrect API key provided: sk-stub-secret" } }, { status: 401 });
    const texts: string[] = JSON.parse(body.messages[1].content);
    const to = body.messages[0].content.includes("Simplified Chinese") ? "zh" : "en";
    let out: unknown = texts.map((t) => `[${to}]${t}`);
    if (mode === "short" && texts.length > 1) out = (out as string[]).slice(1);
    if (mode === "garbage") return Response.json({ choices: [{ message: { content: "I can't do that." } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
  },
});
afterAll(() => stub.stop(true));

const base = `http://127.0.0.1:${stub.port}/v1`;
const make = (cfg: Partial<{ on: boolean; base_url: string; model: string; key: string }> = {}, recipe: any = null) => {
  const dir = join(mkdtempSync(join(tmpdir(), "shep-tr-")), "translations");
  let keyAsks = 0;
  const t = new Translator({
    config: () => ({ on: true, base_url: base, model: "stub-model", key: "TR_KEY", agreed: 1, ...cfg }),
    key: async (name) => { keyAsks++; return name === "TR_KEY" ? { key: "sk-stub-secret" } : { error: `there's no secret ${name}` }; },
    recipe: async () => recipe,
    dir,
  });
  return { t, dir, keyAsks: () => keyAsks };
};
const reset = () => { mode = "ok"; seen.length = 0; };

const MSG = "# Plan\n\nI fixed the merge step.\n\n- Ran `bun test`\n- All green\n\n```\nherdr-task ready SHEP-1\n```\n\n`bin/sync-shared --check`";

describe("a message", () => {
  test("one request with every block; the translation under each, none for code; the key only in the header", async () => {
    reset();
    const { t } = make();
    const r: any = await t.message(MSG);
    expect(r).toEqual({ ok: true, target: "zh", blocks: ["[zh]Plan", "[zh]I fixed the merge step.", "[zh]Ran `bun test`", "[zh]All green", null, null], failed: [] });
    expect(seen.length).toBe(1);
    expect(seen[0].auth).toBe("Bearer sk-stub-secret");
    expect(seen[0].body.model).toBe("stub-model");
    expect(JSON.stringify(seen[0].body)).not.toContain("sk-stub-secret");
    expect(JSON.parse(seen[0].body.messages[1].content)).toEqual(["Plan", "I fixed the merge step.", "Ran `bun test`", "All green"]);
  });

  test("Chinese goes to English", async () => {
    reset();
    const r: any = await make().t.message("## 结果\n\n合并步骤修好了。");
    expect(r).toMatchObject({ ok: true, target: "en", blocks: ["[en]结果", "[en]合并步骤修好了。"] });
  });

  test("kept: asked again (another screen), it comes from the cache, with no request", async () => {
    reset();
    const { t, dir } = make();
    const a = await t.message("Hello there, world.");
    const b = await t.message("Hello there, world.");
    expect(b).toEqual(a);
    expect(seen.length).toBe(1);
    expect(readdirSync(dir).length).toBe(1);
    expect(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")).not.toContain("sk-stub");
  });

  test("two presses at once make one request", async () => {
    reset();
    const { t } = make();
    const [a, b] = await Promise.all([t.message("Same words twice."), t.message("Same words twice.")]);
    expect(a).toEqual(b);
    expect(seen.length).toBe(1);
  });

  test("a count that doesn't match is asked again block by block", async () => {
    reset();
    mode = "short";
    const r: any = await make().t.message("One paragraph here.\n\nAnother paragraph here.\n\nA third one.");
    expect(r.blocks).toEqual(["[zh]One paragraph here.", "[zh]Another paragraph here.", "[zh]A third one."]);
    expect(seen.map((s) => JSON.parse(s.body.messages[1].content).length)).toEqual([3, 1, 1, 1]);
  });

  test("a refused key: one short line, the key never in it", async () => {
    reset();
    mode = "401";
    const r: any = await make().t.message("Some words to translate.");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("refused the key (401)");
    expect(r.error).not.toContain("sk-stub-secret");
    expect(seen.length).toBe(1);
  });

  test("an answer that is never the translation fails, and nothing is kept", async () => {
    reset();
    mode = "garbage";
    const { t, dir } = make();
    const r: any = await t.message("Some words to translate.");
    expect(r).toMatchObject({ ok: false });
    expect(() => readdirSync(dir)).toThrow();
  });

  test("off, not set up, or no key: says so, and calls nothing", async () => {
    reset();
    expect(await make({ on: false }).t.message("Words here.")).toMatchObject({ ok: false, error: expect.stringContaining("off") });
    expect(await make({ base_url: "" }).t.message("Words here.")).toMatchObject({ ok: false, error: expect.stringContaining("isn't set up") });
    expect(await make({ key: "NOPE" }).t.message("Words here.")).toMatchObject({ ok: false, error: expect.stringContaining("no secret NOPE") });
    expect(seen.length).toBe(0);
  });

  test("the key is found once and kept in memory", async () => {
    reset();
    const m = make();
    await m.t.message("First message.");
    await m.t.message("Second message.");
    expect(m.keyAsks()).toBe(1);
  });
});

describe("an artifact", () => {
  const recipe = { blocks: [{ type: "heading", text: "证明" }, { type: "text", md: "合并步骤修好了。\n\n- 测试通过" }, { type: "code", text: "ls" }, { type: "image", src: "a.png", caption: "改动之后" }] };
  test("each text block's translation by its place, into English", async () => {
    reset();
    const r: any = await make({}, recipe).t.artifact("art1", 2, null);
    expect(r).toEqual({ ok: true, target: "en", units: { "0.text": "[en]证明", "1.md.0": "[en]合并步骤修好了。", "1.md.1": "[en]测试通过", "3.caption": "[en]改动之后" }, failed: [] });
    expect(seen.length).toBe(1);
  });
  test("not a recipe", async () => {
    reset();
    expect(await make({}, null).t.artifact("x", 1, null)).toMatchObject({ ok: false });
  });
});

describe("Test connection", () => {
  test("says the model answered, or why not", async () => {
    reset();
    const ok = make();
    expect(await ok.t.test()).toEqual({ ok: true });
    expect(ok.t.lastTest?.text).toContain("Connected: stub-model answered");
    mode = "401";
    const bad = make();
    expect(await bad.t.test()).toMatchObject({ ok: false, error: expect.stringContaining("refused the key") });
  });
  test("works before it's turned on", async () => {
    reset();
    expect(await make({ on: false }).t.test()).toEqual({ ok: true });
  });
});

// Settings › Translation in the web app (service/settings.ts)
const file = join(mkdtempSync(join(tmpdir(), "shep-settings-")), "shepherdr.json");
writeFileSync(file, JSON.stringify({ everywhere: { agents: { reactions: false } } }));
describe("Settings › Translation", () => {
  test("its rows, one page for every space; a change keeps the rest of the file", async () => {
    process.env.HERDR_TASK_SETTINGS = file;
    const { Settings } = await import("./settings.ts?translation");
    const s = new Settings();
    s.start();
    s.secretNames = () => ["TR_KEY", "OTHER"];
    const page = () => s.sections(null).find((x) => x.name === "Translation")!;
    expect(page().global).toBe(true);
    expect(page().rows.map((r) => r.key)).toEqual(["translation.on", "translation.base_url", "translation.model", "translation.key", "translation.test"]);
    expect(page().rows[0]).toMatchObject({ value: "off", confirm: expect.stringContaining("Only that endpoint is called") });
    s.set("translation.base_url", "https://api.example.com/v1");
    s.set("translation.model", "gpt-x");
    s.set("translation.key", "TR_KEY");
    s.set("translation.on", "on");
    const f = JSON.parse(readFileSync(file, "utf8"));
    expect(f.everywhere.agents).toEqual({ reactions: false });
    expect(f.everywhere.translation).toMatchObject({ on: true, base_url: "https://api.example.com/v1", model: "gpt-x", key: "TR_KEY" });
    expect(typeof f.everywhere.translation.agreed).toBe("number");
    expect(s.translation()).toMatchObject({ on: true, model: "gpt-x" });
    // asked only the first time
    expect(page().rows[0].confirm).toBeUndefined();
    expect(page().rows[0].hint).toContain("https://api.example.com/v1");
    expect(page().rows.find((r) => r.key === "translation.key")!.options).toEqual(["OTHER", "TR_KEY"]);
    expect(() => s.set("translation.base_url", "not a url")).toThrow();
    expect(() => s.set("translation.key", "bad name")).toThrow();
    expect(() => s.set("translation.on", "on", "sp1", { id: "sp1", name: "x", machine: null })).toThrow();
    s.set("translation.on", "off");
    expect(JSON.parse(readFileSync(file, "utf8")).everywhere.translation.on).toBeUndefined();
  });
});
