import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Translator, hasMedia } from "./translate.ts";

// a stub translation endpoint on 127.0.0.1, never a real API: [zh]/[en] in front of each string; `mode` breaks it
let mode: "ok" | "short" | "401" | "500key" | "garbage" | "keyecho" | "keyprose" = "ok";
const seen: { auth: string | null; body: any }[] = [];
const stub = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const body = await req.json();
    seen.push({ auth: req.headers.get("authorization"), body });
    if (mode === "401") return Response.json({ error: { message: `${"x".repeat(150)} Incorrect API key provided: sk-stub-secret-0123456789` } }, { status: 401 });
    if (mode === "500key") return Response.json({ error: { message: `${"y".repeat(150)} upstream said sk-stub-secret-0123456789 is odd` } }, { status: 500 });
    const texts: string[] = JSON.parse(body.messages[1].content);
    const to = body.messages[0].content.includes("Simplified Chinese") ? "zh" : "en";
    let out: unknown = texts.map((t) => `[${to}]${t}`);
    if (mode === "short" && texts.length > 1) out = (out as string[]).slice(1);
    // the key in a translation, its first letter escaped twice over (in the answer's JSON and in the array's)
    if (mode === "keyecho") return new Response(`{"choices":[{"message":{"content":"[\\"key \\\\u0073k-stub-secret-0123456789 here\\"]"}}]}`, { headers: { "content-type": "application/json" } });
    // an answer in words around its array, the key's first letter escaped in it
    if (mode === "keyprose") return new Response(`{"choices":[{"message":{"content":"Translation: [\\"key \\\\u0073k-stub-secret-0123456789 here\\"] done"}}]}`, { headers: { "content-type": "application/json" } });
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
    key: async (name) => { keyAsks++; return name === "TR_KEY" ? { key: "sk-stub-secret-0123456789" } : { error: `there's no secret ${name}` }; },
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
    expect(r).toMatchObject({ ok: true, target: "zh", blocks: ["[zh]Plan", "[zh]I fixed the merge step.", "[zh]Ran `bun test`", "[zh]All green", null, null], failed: [] });
    // the window's parts, made here from marked's parse: each block, its translation under it, code as it is
    expect(r.parts.map((p: any) => p.type)).toEqual(["md", "tr", "md", "tr", "md", "tr", "md", "tr", "code", "md"]);
    expect(r.parts[8]).toEqual({ type: "code", lang: "", code: "herdr-task ready SHEP-1" });
    expect(seen.length).toBe(1);
    expect(seen[0].auth).toBe("Bearer sk-stub-secret-0123456789");
    expect(seen[0].body.model).toBe("stub-model");
    expect(JSON.stringify(seen[0].body)).not.toContain("sk-stub-secret-0123456789");
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
    expect(r.error).not.toContain("sk-stub-secret-0123456789");
    expect(seen.length).toBe(1);
  });

  test("an endpoint's own words never carry a piece of the key, however long they are", async () => {
    reset();
    mode = "401";
    const a: any = await make().t.message("Some words to translate.");
    expect(a.error).toBe("Couldn't translate: the endpoint refused the key (401)");
    mode = "500key";
    const b: any = await make().t.message("Some words to translate.");
    expect(b.error).toContain("answered 500");
    for (let n = 4; n <= "sk-stub-secret-0123456789".length; n++) expect(b.error).not.toContain("sk-stub-secret-0123456789".slice(0, n));
  });

  test("turned off or pointed elsewhere while it translates: nothing more is sent, to the old endpoint or the new", async () => {
    reset();
    mode = "short";
    let cfg = { on: true, base_url: base, model: "stub-model", key: "TR_KEY", agreed: 1 };
    // the whole request comes back with the wrong count, and meanwhile the person turns it off and changes the URL
    const t2 = new Translator({ config: () => cfg, key: async () => ({ key: "sk-stub-secret-0123456789" }), recipe: async () => null, dir: join(mkdtempSync(join(tmpdir(), "shep-tr-")), "t"),
      fetchFn: (async (u: any, i: any) => { const res = await fetch(u, i); cfg = { ...cfg, on: false, base_url: "http://old.invalid/v1" }; return res; }) as typeof fetch });
    const r2: any = await t2.message("One paragraph here.\n\nAnother paragraph here.");
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining("changed while it translated") });
    expect(seen.length).toBe(1);
  });

  test("a translation that carries the key, however it is escaped, is neither shown nor kept", async () => {
    reset();
    mode = "keyecho";
    const { t, dir } = make();
    const r: any = await t.message("Some words to translate.");
    expect(r.ok).toBe(true);
    expect(r.blocks[0]).toBe("key … here");
    expect(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")).not.toContain("stub-secret");
  });

  test("an answer wrapped in words, the key escaped in it: still taken out", async () => {
    reset();
    mode = "keyprose";
    const { t, dir } = make();
    const r: any = await t.message("Some words to translate.");
    expect(r.blocks[0]).toBe("key … here");
    expect(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")).not.toContain("stub-secret");
  });

  test("turned off while the key is looked up: nothing goes to the old endpoint", async () => {
    reset();
    let cfg = { on: true, base_url: base, model: "stub-model", key: "TR_KEY", agreed: 1 };
    const t = new Translator({ config: () => cfg, recipe: async () => null, dir: join(mkdtempSync(join(tmpdir(), "shep-tr-")), "t"),
      key: async () => { cfg = { ...cfg, on: false, base_url: "http://old.invalid/v1" }; return { key: "sk-stub-secret-0123456789" }; } });
    expect(await t.message("Private draft.")).toMatchObject({ ok: false, error: expect.stringContaining("changed while it translated") });
    expect(seen.length).toBe(0);
  });

  // a chat's conversation as the service reads it: a1 complete, a2 the newest reply its agent still writes
  const convo: Record<string, { text: string; raw: string; writing: boolean; media?: boolean }> = {
    a1: { text: "A whole reply here.", raw: "A whole reply here.", writing: false },
    a2: { text: "Unfinished reply.", raw: "Unfinished reply.", writing: true },
    a3: { text: "- Intro. echo KeepThisPrivate\n\nReady now.", raw: "- Intro.\n  # Before: ![proof](/tmp/proof.png)\n      echo KeepThisPrivate\n\nReady now.", writing: false, media: true },
    a4: { text: "- Intro. pwd\n\nReady now.", raw: "- Intro.\n  # ![proof](/tmp/proof.png)\n      pwd\n\nReady now.", writing: false, media: true },
  };
  const chatT = () => new Translator({ config: () => ({ on: true, base_url: base, model: "stub-model", key: "TR_KEY", agreed: 1 }), key: async () => ({ key: "sk-stub-secret-0123456789" }),
    recipe: async () => null, dir: join(mkdtempSync(join(tmpdir(), "shep-tr-")), "t"), messageOf: async (w, id) => (w.chat === "sp1" ? convo[id] ?? null : null) });

  test("a message's words are read from its chat by its id, never taken from the caller; one still being written is refused", async () => {
    reset();
    const t = chatT();
    expect(await t.handle({ text: "Unfinished reply.", chat: "sp1", id: "a2" })).toMatchObject({ ok: false, error: expect.stringContaining("still being written") });
    // a finished message's id with other words: its own words go, not the caller's
    const r: any = await t.handle({ text: "Unfinished reply.", chat: "sp1", id: "a1" });
    expect(r).toMatchObject({ ok: true, blocks: ["[zh]A whole reply here."] });
    expect(seen.map((x) => JSON.parse(x.body.messages[1].content))).toEqual([["A whole reply here."]]);
    // no chat, no id, or no such message: nothing at all
    expect(await t.handle({ text: "Half a reply" })).toMatchObject({ ok: false });
    expect(await t.handle({ text: "x", chat: "other", id: "a1" })).toMatchObject({ ok: false });
    expect(seen.length).toBe(1);
  });

  test("pictures as marked parses them: reference images count, examples in code don't", () => {
    expect(hasMedia("See ![shot][img].\n\n[img]: https://example.test/shot.png")).toBe(true);
    expect(hasMedia("Look ![a](/tmp/a.png) here")).toBe(true);
    expect(hasMedia("<video src=\"x.mp4\"></video>")).toBe(true);
    expect(hasMedia("Example:\n\n    ![shot](https://example.test/shot.png)\n\nDone.")).toBe(false);
    expect(hasMedia("Inline `![x](y.png)` and\n\n```\n![x](y.png)\n```")).toBe(false);
    expect(hasMedia("| a | b |\n|---|---|\n| ![p](q.png) | x |")).toBe(true);
  });

  test("a key too short to watch for in answers isn't used", async () => {
    reset();
    const t = new Translator({ config: () => ({ on: true, base_url: base, model: "stub-model", key: "TR_KEY", agreed: 1 }), key: async () => ({ key: "test" }),
      recipe: async () => null, dir: join(mkdtempSync(join(tmpdir(), "shep-tr-")), "t") });
    expect(await t.message("Update state.")).toMatchObject({ ok: false, error: expect.stringContaining("too short") });
    expect(await t.test()).toMatchObject({ ok: false, error: expect.stringContaining("too short") });
    expect(seen.length).toBe(0);
  });

  test("a reply with any picture or clip (its chat's flag) isn't translated, and nothing is sent", async () => {
    reset();
    const t = new Translator({ config: () => ({ on: true, base_url: base, model: "stub-model", key: "TR_KEY", agreed: 1 }), key: async () => ({ key: "sk-stub-secret-0123456789" }),
      recipe: async () => null, dir: join(mkdtempSync(join(tmpdir(), "shep-tr-")), "t"),
      messageOf: async () => ({ text: "![x](/tmp/a b.png)", raw: "![x](/tmp/a b.png)", writing: false, media: true }) });
    expect(await t.handle({ chat: "sp1", id: "p1" })).toMatchObject({ ok: false, error: expect.stringContaining("pictures or clips") });
    expect(seen.length).toBe(0);
  });

  test("a reply whose pictures its chat takes out isn't translated, and nothing is sent", async () => {
    reset();
    for (const id of ["a3", "a4"]) expect(await chatT().handle({ chat: "sp1", id })).toMatchObject({ ok: false, error: expect.stringContaining("pictures or clips") });
    expect(seen.length).toBe(0);
  });

  test("a translation holding the key as any page could render it is dropped whole", () => {
    const t: any = make().t;
    const used = new Set(["sk-stub-secret-0123456789"]);
    expect(t.scrub(["see &#115;k-stub-secret-0123456789 now", "and &#x73;k\\-stub-secret-0123456789", "named &sfr;k-stub-secret-0123456789", "split sk-**stub**-secret-0123456789", "linked sk-[stub](https://example.com)-secret-0123456789", "plain words", "bad &#1114112; entity"], used))
      .toEqual([null, null, null, null, null, "plain words", null]);
    // a named reference without its semicolon, and numeric ones, too; a plain ampersand isn't one
    // (a name with no semicolon marked escapes: the page shows "&AElig" as typed)
    expect(t.scrub(["named &copy; here", "Use &#169; here", "Use &#xA9; here", "Research at AT&T", "See R&D", "legacy &AElig bar"], used))
      .toEqual([null, null, null, "Research at AT&T", "See R&D", "legacy &AElig bar"]);
    // an ordinary sentence is kept whole
    expect(t.scrub(["Update state.", "Restart the service &amp; check"], used)).toEqual(["Update state.", "Restart the service &amp; check"]);
    // the key itself, written plainly: taken out, the rest kept
    expect(t.scrub(["key sk-stub-secret-0123456789 here"], used)).toEqual(["key … here"]);
  });

  test("a kept translation comes back only where its block has words (a code slot never does)", async () => {
    reset();
    const { t, dir } = make();
    await t.message("First paragraph.\n\nSecond paragraph.");
    const f = join(dir, readdirSync(dir)[0]);
    // the same file written by an older layout: code in a slot that has words now, and a word slot holding code
    writeFileSync(f, JSON.stringify({ target: "zh", blocks: ["[old]Second", "[old]code"] }));
    const r: any = await t.message("First paragraph.\n\nSecond paragraph.");
    expect(r.blocks).toEqual(["[old]Second", "[old]code"]);
    const r2: any = await t.message("```\nls\n```\n\nWords here.");
    writeFileSync(join(dir, readdirSync(dir).find((x) => !f.endsWith(x))!), JSON.stringify({ target: "zh", blocks: ["[old]ls", "[zh]Words here."] }));
    const r3: any = await t.message("```\nls\n```\n\nWords here.");
    expect(r2.blocks[0]).toBeNull();
    expect(r3.blocks).toEqual([null, "[zh]Words here."]);
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
    expect(r).toMatchObject({ ok: true, target: "en", units: { "0.text": "[en]证明", "1.md.0": "[en]合并步骤修好了。", "1.md.1": "[en]测试通过", "3.caption": "[en]改动之后" }, failed: [] });
    expect(r.mdParts["1.md"]).toEqual([{ type: "md", text: "合并步骤修好了。", depth: 0 }, { type: "tr", text: "[en]合并步骤修好了。", depth: 0 },
      { type: "md", text: "- 测试通过", depth: 0 }, { type: "tr", text: "[en]测试通过", depth: 0 }]);
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
    expect(await ok.t.test()).toMatchObject({ ok: true, text: expect.stringContaining("Connected") });
    expect(ok.t.lastTest?.text).toContain("Connected: stub-model answered");
    mode = "401";
    const bad = make();
    expect(await bad.t.test()).toMatchObject({ ok: false, error: expect.stringContaining("refused the key") });
  });
  test("works before it's turned on", async () => {
    reset();
    expect(await make({ on: false }).t.test()).toMatchObject({ ok: true });
  });
});

// Settings › Translation in the web app (service/settings.ts)
const file = join(mkdtempSync(join(tmpdir(), "shep-settings-")), "shepherdr.json");
writeFileSync(file, JSON.stringify({ everywhere: { agents: { reactions: false } } }));
describe("Settings › Translation", () => {
  test("its rows, one page for every space; a change keeps the rest of the file", async () => {
    const was = process.env.HERDR_TASK_SETTINGS;
    process.env.HERDR_TASK_SETTINGS = file;
    const { Settings } = await import("./settings.ts");
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
    // a change the window makes to the file applies at once (the service reads it each time)
    const f2 = JSON.parse(readFileSync(file, "utf8"));
    f2.everywhere.translation = { ...f2.everywhere.translation, on: true, model: "from-the-window" };
    writeFileSync(file, JSON.stringify(f2));
    expect(s.translation()).toMatchObject({ on: true, model: "from-the-window" });
    process.env.HERDR_TASK_SETTINGS = was;
  });
});
