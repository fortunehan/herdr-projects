import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import * as T from "./translate.js";

const MSG = [
  "# Plan",
  "",
  "I fixed the **merge** step and ran `bun test`.",
  "Second line of the same paragraph.",
  "",
  "- First item with a [link](https://example.com)",
  "- Second item",
  "  - Nested item",
  "1. One",
  "2. Two",
  "",
  "> A quoted line",
  "",
  "```bash",
  "herdr-task ready SHEP-1",
  "```",
  "",
  "| Name | Status |",
  "| --- | --- |",
  "| Build | passed |",
  "| `lint` | SHEP-96 |",
  "",
  "---",
  "",
  "`bin/sync-shared --check`",
  "",
  "See https://github.com/x/y/pull/1",
].join("\n");

describe("mdBlocks", () => {
  test("splits headings, paragraphs, items, quotes, cells and code in reading order", () => {
    const b = T.mdBlocks(MSG);
    expect(b.map((x) => x.kind)).toEqual(["heading", "para", "item", "item", "item", "item", "item", "quote", "code",
      "cell", "cell", "cell", "cell", "cell", "cell", "rule", "para", "para"]);
    expect(b[0].text).toBe("Plan");
    expect(b[1].text).toBe("I fixed the **merge** step and ran `bun test`. Second line of the same paragraph.");
    expect(b[4]).toMatchObject({ text: "Nested item", depth: 1 });
    expect(b[5]).toMatchObject({ text: "One", ordered: true });
    expect(b[7].text).toBe("A quoted line");
    expect(b[8]).toMatchObject({ kind: "code", lang: "bash", code: "herdr-task ready SHEP-1", skip: true });
    expect(b.slice(9, 15).map((x) => x.text)).toEqual(["Name", "Status", "Build", "passed", "`lint`", "SHEP-96"]);
  });

  test("code, commands, links, paths and ids get no translation", () => {
    const b = T.mdBlocks(MSG);
    const skipped = b.filter((x) => x.skip).map((x) => x.kind + ":" + x.text);
    expect(skipped).toEqual(["code:", "cell:`lint`", "cell:SHEP-96", "rule:", "para:`bin/sync-shared --check`"]);
  });

  test("Chinese with lists and a table", () => {
    const b = T.mdBlocks("## 结果\n\n修好了合并步骤。\n\n* 第一项\n* 第二项\n\n|列|值|\n|-|-|\n|状态|通过|");
    expect(b.map((x) => [x.kind, x.text])).toEqual([["heading", "结果"], ["para", "修好了合并步骤。"], ["item", "第一项"], ["item", "第二项"],
      ["cell", "列"], ["cell", "值"], ["cell", "状态"], ["cell", "通过"]]);
    expect(b.every((x) => !x.skip)).toBe(true);
  });

  test("a list item's indented code isn't sent; a third-level item is an item; a link's reference is no block", () => {
    const md = "- Run this:\n\n      echo KeepThisPrivate\n\n- alpha\n  - beta\n    - gamma\n\nRead [the guide][help].\n\n[help]: https://example.invalid/guide";
    const b = T.mdBlocks(md);
    expect(T.messageTexts(md).texts).toEqual(["Run this:", "alpha", "beta", "gamma", "Read [the guide][help]."]);
    expect(b.map((x) => x.kind)).toEqual(["item", "item", "item", "item", "para", "def"]);
    // the window draws each part on its own: the reference goes with each, so the link still links
    expect(T.windowParts(md).find((x) => x.type === "md" && x.text.startsWith("Read")).text).toContain("[help]: https://example.invalid/guide");
  });

  test("a heading or a list in a quote, and an indented code block", () => {
    const b = T.mdBlocks("> ## Quoted heading\n> words under it\n\nText.\n\n    const sample = \"hello world\";\n    more();\n\nAfter.");
    expect(b.map((x) => [x.kind, x.text])).toEqual([["heading", "Quoted heading"], ["quote", "words under it"], ["para", "Text."], ["code", ""], ["para", "After."]]);
    expect(b[3]).toMatchObject({ skip: true, code: 'const sample = "hello world";\nmore();' });
    expect(T.messageTexts("    const sample = \"hello world\";").texts).toEqual([]);
  });

  test("a setext heading, a task list and a loose list item", () => {
    const b = T.mdBlocks("Title\n=====\n\n- [x] done thing\n- loose item\n\n  its second paragraph\n- last");
    expect(b.map((x) => [x.kind, x.text])).toEqual([["heading", "Title"], ["item", "done thing"], ["item", "loose item its second paragraph"], ["item", "last"]]);
  });

  test("its blocks are the page's blocks, in order (as marked renders them)", () => {
    // the web app finds each block in the rendered page: h1-h6, p (not in a list item), li, th/td, in reading order
    const domKinds = (md) => {
      const out = [];
      const walk = (tokens, inLi = false) => {
        for (const t of tokens) {
          if (t.type === "heading") out.push("h");
          else if (t.type === "paragraph" && !inLi) out.push("p");
          else if (t.type === "blockquote") walk(t.tokens, inLi);
          else if (t.type === "list") for (const it of t.items) { out.push("li"); walk(it.tokens, true); }
          else if (t.type === "table") { t.header.forEach(() => out.push("td")); t.rows.forEach((r) => r.forEach(() => out.push("td"))); }
          else if (t.type === "text" && t.tokens && !inLi) walk(t.tokens, inLi);
        }
      };
      walk(marked.lexer(md));
      return out;
    };
    const samples = [MSG, "## 结果\n\n修好了。\n\n* 一\n* 二\n\n|列|值|\n|-|-|\n|a|b|", "Title\n=====\n\n- [x] done\n- loose\n\n  more\n- last",
      "Text\n- list right after\n- two\n\nEnd.", "> one\n>\n> two\n\nafter", "1. a\n   1. b\n2. c",
      "> ## Quoted heading\n> words\n\n    indented code\n\nEnd.", "> - quoted item\n> - another",
      "- Run this:\n\n      echo KeepThisPrivate\n\n- alpha\n  - beta\n    - gamma\n\nRead [the guide][help].\n\n[help]: https://example.invalid/guide"];
    for (const md of samples) expect(T.mdBlocks(md).map(T.domKind).filter(Boolean)).toEqual(domKinds(md));
  });
});

describe("direction", () => {
  test("English goes to Chinese", () => expect(T.direction("I fixed the merge step.")).toBe("zh"));
  test("Chinese goes to English", () => expect(T.direction("我修好了合并步骤，测试都通过了。")).toBe("en"));
  test("Chinese with English terms and code still goes to English", () =>
    expect(T.direction("我修好了 SHEP-96 的 merge 步骤，运行 `bun test service core web --timeout 60000` 都通过了")).toBe("en"));
  test("English with a little Chinese goes to Chinese", () => expect(T.direction("The button now says 翻译 when the person writes in English all day long.")).toBe("zh"));
  test("code and links don't count", () => expect(T.direction("我改了这个：\n\n```\nconst a = 'very long english code here and more words'\n```\n\n见 [link text in English](https://x.y)")).toBe("en"));
  test("an indented code block doesn't count either", () => expect(T.direction("Build ready.\n\n    // 这是一段很长的中文注释，写在代码里面\n    构建();")).toBe("zh"));
});

describe("the request and its answer", () => {
  test("one request with a JSON array, in the target's name", () => {
    const b = T.requestBody("m1", ["Hello", "World"], "zh");
    expect(b.model).toBe("m1");
    expect(b.messages[0].content).toContain("Simplified Chinese");
    expect(JSON.parse(b.messages[1].content)).toEqual(["Hello", "World"]);
  });
  test("an array of as many strings", () => expect(T.parseTranslations('["你好","世界"]', 2)).toEqual(["你好", "世界"]));
  test("inside a code fence or an object", () => {
    expect(T.parseTranslations('```json\n["a","b"]\n```', 2)).toEqual(["a", "b"]);
    expect(T.parseTranslations('{"translations":["a","b"]}', 2)).toEqual(["a", "b"]);
    expect(T.parseTranslations('Here you go: ["a","b"] done', 2)).toEqual(["a", "b"]);
  });
  test("a wrong count or shape is refused", () => {
    expect(T.parseTranslations('["a"]', 2)).toBeNull();
    expect(T.parseTranslations('["a", 3]', 2)).toBeNull();
    expect(T.parseTranslations("not json", 1)).toBeNull();
  });
  test("the endpoint's URL", () => {
    expect(T.endpointOf("https://api.example.com/v1/")).toBe("https://api.example.com/v1/chat/completions");
    expect(T.endpointOf("http://127.0.0.1:9/v1/chat/completions")).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(T.endpointOf("ftp://x")).toBeNull();
    expect(T.endpointOf("")).toBeNull();
  });
  test("an answer is made inert: no pictures, no HTML, links only to the original's addresses", () => {
    expect(T.inert('看 ![x](https://evil.example/p.png) <img src="https://evil.example/q.png"> [文档](https://docs.example/a) [坏](https://evil.example/b)', "See [docs](https://docs.example/a)"))
      .toBe("看 x  [文档](https://docs.example/a) 坏");
  });
});

describe("translateTexts", () => {
  const fake = (bad = 0) => {
    const calls = [];
    return { calls, ask: async (texts) => { calls.push(texts); return calls.length <= bad ? JSON.stringify(texts.slice(1)) : JSON.stringify(texts.map((t) => `[zh]${t}`)); } };
  };
  test("one request for every block", async () => {
    const f = fake();
    expect(await T.translateTexts(["a", "b", "c"], "zh", f.ask)).toEqual(["[zh]a", "[zh]b", "[zh]c"]);
    expect(f.calls.length).toBe(1);
  });
  test("a count that doesn't match is asked again block by block", async () => {
    const f = fake(1);
    expect(await T.translateTexts(["a", "b", "c"], "zh", f.ask)).toEqual(["[zh]a", "[zh]b", "[zh]c"]);
    expect(f.calls.length).toBe(4);
    expect(f.calls.slice(1).every((c) => c.length === 1)).toBe(true);
  });
  test("a block that fails on its own is null, the rest translated", async () => {
    const ask = async (texts) => (texts.length > 1 ? "[]" : texts[0] === "b" ? "nope" : JSON.stringify([`[zh]${texts[0]}`]));
    expect(await T.translateTexts(["a", "b", "c"], "zh", ask)).toEqual(["[zh]a", null, "[zh]c"]);
  });
  test("every block in ONE request, however many", async () => {
    const f = fake();
    const texts = Array.from({ length: 120 }, (_, i) => `block ${i}`);
    expect((await T.translateTexts(texts, "zh", f.ask)).length).toBe(120);
    expect(f.calls.map((c) => c.length)).toEqual([120]);
  });
  test("a one-block message whose answer doesn't match is asked once more", async () => {
    const calls = [];
    const ask = async (texts) => { calls.push(texts); return calls.length === 1 ? "[]" : JSON.stringify([`[zh]${texts[0]}`]); };
    expect(await T.translateTexts(["only"], "zh", ask)).toEqual(["[zh]only"]);
    expect(calls.length).toBe(2);
  });
  test("an endpoint's error (busy, out of quota) is never asked again block by block", async () => {
    const calls = [];
    const ask = async (texts) => { calls.push(texts.length); throw new Error("the endpoint is busy or out of quota (429)"); };
    await expect(T.translateTexts(["a", "b", "c"], "zh", ask)).rejects.toThrow("429");
    expect(calls).toEqual([3]);
  });
  test("an endpoint's own words never show", () => {
    expect(T.apiError(500, '{"error":{"message":"bad key sk-123"}}')).toBe("the endpoint answered 500");
    expect(T.apiError(429)).not.toContain(":  ");
  });
  test("a refused key fails at once, not block by block", async () => {
    let n = 0;
    const ask = async () => { n++; throw new Error("the endpoint refused the key (401)"); };
    await expect(T.translateTexts(["a", "b"], "zh", ask)).rejects.toThrow("refused the key");
    expect(n).toBe(1);
  });
  test("nothing translated throws", async () => {
    await expect(T.translateTexts(["a", "b"], "zh", async () => "garbage")).rejects.toThrow("wasn't the translation");
  });
});

describe("windowParts", () => {
  test("each block, then its translation; code as it is; a table then its translated table", () => {
    const md = "Hello world.\n\n```\nls\n```\n\n| Name | Value |\n|---|---|\n| one | `x` |";
    const { at, texts } = T.messageTexts(md);
    expect(texts).toEqual(["Hello world.", "Name", "Value", "one"]);
    const tr = [];
    at.forEach((i, k) => (tr[i] = ["你好世界。", "甲", "乙", "一"][k]));
    expect(T.windowParts(md, tr)).toEqual([
      { type: "md", text: "Hello world.", depth: 0 }, { type: "tr", text: "你好世界。", depth: 0 },
      { type: "code", lang: "", code: "ls" },
      { type: "table", rows: [[{ text: "Name", tr: "甲", fail: false }, { text: "Value", tr: "乙", fail: false }], [{ text: "one", tr: "一", fail: false }, { text: "`x`", tr: null, fail: false }]] },
    ]);
  });
  test("a failed block says so under it", () => {
    expect(T.windowParts("One.\n\nTwo.", ["一。", null], [1])).toEqual([{ type: "md", text: "One.", depth: 0 }, { type: "tr", text: "一。", depth: 0 }, { type: "md", text: "Two.", depth: 0 }, { type: "fail", depth: 0 }]);
  });
  test("a nested list item keeps its depth", () => {
    const parts = T.windowParts("- One\n  - Two", ["一", "二"]);
    expect(parts.filter((x) => x.type === "md").map((x) => [x.text, x.depth])).toEqual([["- One", 0], ["- Two", 1]]);
  });
});

describe("recipes", () => {
  const recipe = { blocks: [
    { type: "heading", text: "Proof" },
    { type: "text", md: "First paragraph.\n\n- an item\n\n```\ncode\n```" },
    { type: "table", columns: ["Name", { label: "Result" }], rows: [["Build", "passed"], ["`x`", "SHEP-9"]] },
    { type: "image", src: "a.png", caption: "After the change" },
    { type: "code", text: "ls -la" },
    { type: "check", command: "bun test", summary: "All tests pass", output: "ok" },
    { type: "columns", columns: [[{ type: "callout", title: "Note", md: "Inside a column." }]] },
    { type: "details", summary: "More", blocks: [{ type: "list", items: ["one item", "`code`"] }] },
    { type: "tabs", tabs: [{ label: "First tab", blocks: [] }] },
    { type: "chart", kind: "pie", labels: ["Passed", "Failed"], series: [{ name: "Tests run", values: [3, 1] }] },
    { type: "button", label: "Send" },
  ] };
  test("every text block's place and words; code, buttons and bare code skipped", () => {
    expect(T.recipeUnits(recipe)).toEqual([
      { key: "0.text", text: "Proof" },
      { key: "1.md.0", text: "First paragraph." }, { key: "1.md.1", text: "an item" },
      { key: "2.col.0", text: "Name" }, { key: "2.col.1", text: "Result" }, { key: "2.cell.0.0", text: "Build" }, { key: "2.cell.0.1", text: "passed" },
      { key: "3.caption", text: "After the change" },
      { key: "5.summary", text: "All tests pass" },
      { key: "6.c0.0.title", text: "Note" }, { key: "6.c0.0.md.0", text: "Inside a column." },
      { key: "7.summary", text: "More" },
      { key: "7.b.0.items.0", text: "one item" },
      { key: "8.tab.0", text: "First tab" },
      { key: "9.series.0", text: "Tests run" }, { key: "9.label.0", text: "Passed" }, { key: "9.label.1", text: "Failed" },
    ]);
  });
  test("a Chinese artifact goes to English", () => {
    expect(T.recipeDirection({ blocks: [{ type: "heading", text: "证明" }, { type: "text", md: "合并步骤修好了，所有测试都通过。" }] })).toBe("en");
  });
});

describe("settings and the key", () => {
  test("the settings block, Everywhere's", () => {
    expect(T.configOf({ everywhere: { translation: { on: true, base_url: " https://x/v1 ", model: "m", key: "K" } } })).toEqual({ on: true, base_url: "https://x/v1", model: "m", key: "K", agreed: 0 });
    expect(T.configOf({})).toEqual({ on: false, base_url: "", model: "", key: "", agreed: 0 });
  });
  test("what stops it", () => {
    expect(T.notReady({ on: false })).toBe(T.WORDS.off);
    expect(T.notReady({ on: true, base_url: "x", model: "m", key: "K" })).toBe(T.WORDS.notSet);
    expect(T.notReady({ on: true, base_url: "https://x", model: "m", key: "K" })).toBeNull();
  });
  const vault = JSON.stringify({ secrets: [{ name: "TR_KEY", scope: "everywhere", value: "sk-here" }, { name: "TR_KEY", scope: "space", space: "s", value: "no" }] });
  test("the vault here", async () => {
    expect(await T.findKey({ where: async () => ({ here: true }), vault: () => vault, ask: async () => null }, "TR_KEY")).toEqual({ key: "sk-here" });
    expect((await T.findKey({ where: async () => ({ here: true }), vault: () => vault, ask: async () => null }, "OTHER")).error).toContain("no secret OTHER");
  });
  test("the machine that keeps the secrets, into memory only", async () => {
    const asked = [];
    const io = { where: async () => ({ here: false, set: true, name: "mini" }), vault: () => null, ask: async (m, s) => { asked.push(m); expect(s).toContain('"TR_KEY"'); return '{"key": "sk-there"}'; } };
    expect(await T.findKey(io, "TR_KEY")).toEqual({ key: "sk-there" });
    expect(asked).toEqual(["mini"]);
    expect((await T.findKey({ ...io, ask: async () => null }, "TR_KEY")).error).toContain("couldn't reach mini");
  });
  test("a name that isn't one never reaches a script", async () => {
    expect(() => T.keyScript('X"; import os')).toThrow();
    expect((await T.findKey({ where: async () => ({ here: true }), vault: () => vault, ask: async () => null }, "bad name")).error).toBe(T.WORDS.notSet);
  });
});
