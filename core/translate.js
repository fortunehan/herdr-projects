// Translate (SHEP-102): an agent's message, a proof or an artifact shown with its translation under each paragraph,
// list item, heading, quote, table cell and text block, like the Immersive Translate browser extension. The original
// stays; code, commands, paths, task ids and links get no translation line. The direction is decided here, with no
// model call: mostly Chinese (CJK over ~30% of the letters, code and links aside) goes to English, anything else to
// Chinese. The translation itself is the person's own OpenAI-compatible endpoint (Settings › Translation), called by
// this machine's service (service/translate.ts): every block in ONE request that asks for a JSON array of the same
// length and order, checked, and asked again block by block when it doesn't match.
// Shared: the window's chat and artifact viewer, the web app and the service read this same file (lib/COPIES).

import { PY } from "./paths.js";

export const WORDS = {
  translate: "Translate",
  hide: "Hide translation",
  translating: "Translating…",
  failed: (why) => `Couldn't translate${why ? `: ${why}` : ""}`,
  blockFailed: "Couldn't translate this part",
  retry: "Retry",
  off: "Translation is off: turn it on in Settings › Translation.",
  notSet: "Translation isn't set up: add the endpoint, model and key in Settings › Translation.",
  noService: "Shepherdr's service isn't running on this machine.",
};

// ---- blocks ------------------------------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const indentOf = (s) => s.replace(/\t/g, "    ").match(/^ */)[0].length;
const blank = (s) => !s.trim();

/** A table row's cells: split on | outside inline code and not escaped. */
export function cellsOf(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out = [];
  let cur = "", code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Whether a line starts a block other than a paragraph's next line (it ends the paragraph above it). */
const starts = (l) => FENCE.test(l) || HEADING.test(l) || QUOTE.test(l) || RULE.test(l) || /^[ \t]*(?:[-*+]|1[.)])[ \t]+\S/.test(l);

/**
 * A message's markdown as its blocks, in reading order: { kind, text, src, skip, ... }. kind: "heading", "para",
 * "quote", "item" (a list item; depth: how deep it is nested), "cell" (a table cell: table, row and col say where),
 * "code" (a fenced block: lang, code) or "rule". text: what is translated (the block's own words, its markers off);
 * src: its markdown as written (for the window, which draws each block on its own). skip: nothing to translate (code,
 * a rule, or words that are only code, links, paths or ids). The web app finds the same blocks in the rendered page in
 * this order (h1-h6, p, li, th/td).
 */
export function mdBlocks(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let tables = 0;
  const put = (b) => out.push({ ...b, skip: b.kind === "code" || b.kind === "rule" || !hasWords(b.text ?? "") });
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (blank(l)) { i++; continue; }
    const fence = FENCE.exec(l);
    if (fence) {
      const mark = fence[1], start = i;
      const lang = l.trim().slice(mark.length).trim().split(/\s+/)[0] ?? "";
      i++;
      const body = [];
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0]}{${mark.length},}[ \\t]*$`).test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      put({ kind: "code", text: "", src: lines.slice(start, i).join("\n"), lang, code: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(l);
    if (h) { put({ kind: "heading", text: (h[2] ?? "").trim(), src: l, level: h[1].length }); i++; continue; }
    if (RULE.test(l)) { put({ kind: "rule", text: "", src: l }); i++; continue; }
    if (l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const start = i, t = tables++;
      const rows = [cellsOf(l)];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) rows.push(cellsOf(lines[i++]));
      const src = lines.slice(start, i).join("\n");
      rows.forEach((r, ri) => r.forEach((c, ci) => put({ kind: "cell", text: c, src, table: t, row: ri, col: ci, cols: rows[0].length })));
      continue;
    }
    if (QUOTE.test(l)) {
      const start = i, inner = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || !starts(lines[i]))) inner.push(lines[i++].replace(QUOTE, ""));
      const src = lines.slice(start, i).join("\n");
      // each paragraph of a quote is its own block (a ">" line on its own splits them)
      const paras = inner.join("\n").split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
      for (const p of paras) put({ kind: "quote", text: p.replace(/\n/g, " "), src: paras.length === 1 ? src : p.split("\n").map((x) => `> ${x}`).join("\n") });
      continue;
    }
    const item = ITEM.exec(l);
    if (item && (item[4].trim() || item[3])) {
      const start = i, ind = indentOf(item[1]);
      const own = [item[4]];
      i++;
      // its lines: lazy or indented continuations, and a paragraph after a blank line indented under it (a loose
      // list's); a nested list item starts a block of its own
      for (;;) {
        if (i >= lines.length) break;
        const n = lines[i];
        if (blank(n)) {
          const next = lines.slice(i + 1).find((x) => !blank(x));
          if (next !== undefined && indentOf(next) > ind + 1 && !ITEM.test(next)) { i++; continue; }
          break;
        }
        if (ITEM.test(n) || HEADING.test(n) || FENCE.test(n) || QUOTE.test(n) || (RULE.test(n) && indentOf(n) <= ind)) break;
        own.push(n.trim());
        i++;
      }
      const words = own.join(" ").trim().replace(/^\[[ xX]\][ \t]+/, "");
      const depth = Math.floor(ind / 2);
      put({ kind: "item", text: words, src: lines.slice(start, i).map((x) => x.slice(Math.min(ind, indentOf(x)))).join("\n").trimEnd(), ordered: /\d/.test(item[2]), depth });
      continue;
    }
    const start = i, para = [];
    while (i < lines.length && !blank(lines[i]) && (i === start || !starts(lines[i]))) {
      if (i > start && SETEXT.test(lines[i])) break;
      para.push(lines[i++]);
    }
    if (i < lines.length && para.length && SETEXT.test(lines[i]) && !blank(lines[i])) {
      const level = lines[i].trim().startsWith("=") ? 1 : 2;
      i++;
      put({ kind: "heading", text: para.join(" ").trim(), src: lines.slice(start, i).join("\n"), level });
      continue;
    }
    put({ kind: "para", text: para.map((x) => x.trim()).join(" "), src: lines.slice(start, i).join("\n") });
  }
  return out;
}

/** The element a block is in the rendered page ("h", "p", "li", "td"), or null (code and rules: never translated). */
export const domKind = (b) => ({ heading: "h", para: "p", quote: "p", item: "li", cell: "td" })[b.kind] ?? null;

// ---- what counts as words --------------------------------------------------------------------------------------

const URL = /\b(?:https?|ftp|file):\/\/[^\s)>\]]+/g;
const LINK = /!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE_SPAN = /(`+)[\s\S]*?\1/g;
const FENCED = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[ \t]*(?=\n|$)|$)/gm;
const PATH = /(?:^|[\s(])(?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w.@-]*/g;
const TASK_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const MENTION = /[#@][\w.-]+/g;

/** The words of a text with its code, links, URLs, paths, task ids and mentions taken out. */
export function plainWords(text) {
  return String(text ?? "").replace(FENCED, " ").replace(CODE_SPAN, " ").replace(LINK, " ").replace(URL, " ")
    .replace(PATH, " ").replace(TASK_ID, " ").replace(MENTION, " ").replace(/<[^>\n]+>/g, " ");
}

/** Whether a text has words to translate: two letters or more (or one Chinese or Japanese character) once code, links,
 *  paths and ids are out. */
export function hasWords(text) {
  const plain = plainWords(text);
  return (plain.match(/\p{L}/gu) ?? []).length >= 2 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(plain);
}

const CJK =/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/** The language to translate into: "en" when CJK characters are over ~30% of the text's letters (code and links
 *  aside), else "zh". Decided locally, with no model call. */
export function direction(text) {
  const plain = plainWords(text);
  const cjk = (plain.match(CJK) ?? []).length;
  const letters = (plain.match(/\p{L}/gu) ?? []).length;
  return letters && cjk / letters > 0.3 ? "en" : "zh";
}

export const TARGETS = { zh: "Simplified Chinese", en: "English" };

// ---- the request and its answer -----------------------------------------------------------------------------------

/** The instructions the model gets. */
export const systemPrompt = (target) => [
  `You are a translation engine. Translate each string of the JSON array the user sends into ${TARGETS[target] ?? target}.`,
  "Reply with only a JSON array of strings: exactly as many as you were sent, in the same order, each the translation of the string at its place. No other words, no code fence.",
  "Keep Markdown inline formatting (bold, italics, links). Leave unchanged: text in backticks, commands, file paths, URLs, link targets, task ids like SHEP-96, and #- or @-mentions.",
  "A string that is already in the target language, or has nothing to translate, comes back as it is.",
].join("\n");

/** An OpenAI-compatible chat completions body asking for texts' translations into target ("zh" | "en"). */
export function requestBody(model, texts, target) {
  return { model, temperature: 0, messages: [{ role: "system", content: systemPrompt(target) }, { role: "user", content: JSON.stringify(texts) }] };
}

/** The chat completions URL for a base URL (".../v1" or the whole ".../chat/completions"), or null when it isn't an
 *  http(s) URL. */
export function endpointOf(base) {
  const b = String(base ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(b)) return null;
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}

/** The model's reply as n translations, or null when it isn't a JSON array of n strings (a code fence around it, or
 *  an object holding the array, is fine). */
export function parseTranslations(content, n) {
  let s = String(content ?? "").trim().replace(/^```[\w-]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  let v = null;
  try { v = JSON.parse(s); } catch {
    const a = s.indexOf("["), b = s.lastIndexOf("]");
    if (a >= 0 && b > a) { try { v = JSON.parse(s.slice(a, b + 1)); } catch {} }
  }
  if (v && !Array.isArray(v) && typeof v === "object") v = Object.values(v).find(Array.isArray) ?? null;
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "string")) return null;
  return v;
}

/** The text of an OpenAI-compatible chat completion's answer. */
export const answerText = (body) => body?.choices?.[0]?.message?.content ?? null;

/** An endpoint's refusal in a few plain words: its status and its own message, never the request. */
export function apiError(status, body) {
  let msg = "";
  try { const d = JSON.parse(body); msg = d?.error?.message ?? d?.message ?? (typeof d?.error === "string" ? d.error : ""); } catch { msg = String(body ?? "").slice(0, 160); }
  msg = String(msg).replace(/\s+/g, " ").trim().slice(0, 160);
  if (status === 401 || status === 403) return `the endpoint refused the key (${status})${msg ? `: ${msg}` : ""}`;
  if (status === 404) return `the endpoint or model wasn't found (404)${msg ? `: ${msg}` : ""}`;
  if (status === 429) return `the endpoint is busy or out of quota (429)${msg ? `: ${msg}` : ""}`;
  return `the endpoint answered ${status}${msg ? `: ${msg}` : ""}`;
}

/** Texts in batches of at most `most` texts and about `chars` characters. */
export function batches(texts, most = 40, chars = 6000) {
  const out = [];
  let cur = [], size = 0;
  texts.forEach((t, i) => {
    if (cur.length && (cur.length >= most || size + t.length > chars)) { out.push(cur); cur = []; size = 0; }
    cur.push(i);
    size += t.length;
  });
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Translates texts into target. ask(texts) sends one request and gives the model's answer text (it throws on an
 * endpoint's error). Each batch goes as one request; an answer that isn't an array of as many strings is asked again
 * text by text. -> an array as long as texts: each translation, or null where it failed. Throws when nothing could be
 * translated (the error of the last try).
 */
export async function translateTexts(texts, target, ask, { most = 40, chars = 6000, parallel = 4 } = {}) {
  const out = texts.map(() => null);
  let last = null, any = false;
  const one = async (idx) => {
    const got = parseTranslations(await ask(idx.map((i) => texts[i]), target), idx.length);
    if (!got) return false;
    got.forEach((t, k) => { out[idx[k]] = t; });
    any = true;
    return true;
  };
  for (const idx of batches(texts, most, chars)) {
    let ok = false;
    try { ok = await one(idx); } catch (e) { last = e; if (!retryable(e)) throw e; }
    if (ok || idx.length === 1) continue;
    // the count or the shape didn't match: each text on its own
    const left = [...idx];
    await Promise.all(Array.from({ length: Math.min(parallel, left.length) }, async () => {
      while (left.length) {
        const i = left.shift();
        try { if (!(await one([i]))) last ??= new Error("the model's answer wasn't the translation asked for"); } catch (e) { last = e; }
      }
    }));
  }
  if (!any && texts.length) throw last ?? new Error("the model's answer wasn't the translation asked for");
  return out;
}

/** An error worth asking again block by block (a bad answer), not one every request would get (a refused key). */
const retryable = (e) => !/refused the key|wasn't found|isn't set up|is off|couldn't reach/i.test(String(e?.message ?? e));

// ---- a message's translation, block by block ------------------------------------------------------------------------

/** What a message sends: the texts of its blocks that have words, with where each goes (its block's index). */
export function messageTexts(md) {
  const blocks = mdBlocks(md);
  const at = [], texts = [];
  blocks.forEach((b, i) => { if (!b.skip) { at.push(i); texts.push(b.text); } });
  return { blocks, at, texts };
}

/**
 * The window's parts of a translated message, in order: { type: "md", text } (a block's own markdown), { type: "tr",
 * text } (its translation, under it), { type: "fail" } (a block that couldn't be translated), { type: "code", lang,
 * code }. A table is drawn whole, then its translation as a table of the translated cells. tr: the translations by
 * block index (null where there is none); failed: the indexes that failed.
 */
export function windowParts(md, tr = [], failed = []) {
  const blocks = mdBlocks(md);
  const bad = new Set(failed);
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "code") { out.push({ type: "code", lang: b.lang, code: b.code }); continue; }
    if (b.kind === "cell") {
      const t = b.table, cells = [];
      while (i < blocks.length && blocks[i].kind === "cell" && blocks[i].table === t) cells.push({ ...blocks[i], at: i++ });
      i--;
      out.push({ type: "md", text: b.src });
      const rows = [];
      for (const c of cells) (rows[c.row] ??= [])[c.col] = tr[c.at] ?? (c.skip ? c.text : "");
      if (cells.some((c) => tr[c.at])) {
        const line = (r) => `| ${Array.from({ length: b.cols }, (_, k) => String(r?.[k] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
        out.push({ type: "tr", text: [line(rows[0]), `|${" --- |".repeat(b.cols)}`, ...rows.slice(1).map(line)].join("\n") });
      }
      if (cells.some((c) => bad.has(c.at))) out.push({ type: "fail" });
      continue;
    }
    out.push({ type: "md", text: b.src });
    if (tr[i]) out.push({ type: "tr", text: b.kind === "heading" ? `**${tr[i]}**` : tr[i] });
    else if (bad.has(i)) out.push({ type: "fail" });
  }
  return out;
}

// ---- an artifact's texts --------------------------------------------------------------------------------------------

/** Every block of a recipe with its place ("3", "5.c1.0", "7.t0.2", "9.b1"), as recipeUnits names its texts. */
export function blockPaths(recipe) {
  const paths = new Map();
  const walk = (blocks, pre) => (Array.isArray(blocks) ? blocks : []).forEach((b, i) => {
    if (!b || typeof b !== "object") return;
    const p = pre ? `${pre}.${i}` : String(i);
    paths.set(b, p);
    if (b.type === "columns") (b.columns ?? []).forEach((c, k) => walk(c, `${p}.c${k}`));
    if (b.type === "tabs") (b.tabs ?? []).forEach((t, k) => walk(t?.blocks, `${p}.t${k}`));
    if (b.type === "details") walk(b.blocks, `${p}.b`);
  });
  walk(recipe?.blocks, "");
  return paths;
}

/**
 * A recipe's texts to translate: [{ key, text }], key "<block's place>.<field>" (heading "3.text", a markdown block's
 * paragraphs "4.md.0", a list's items "5.items.2", a table's "6.col.1" and "6.cell.0.2", captions, a callout's title,
 * a stat's label and note, a check's summary, a question and its options' descriptions). Code, commands, buttons and
 * form fields aren't translated, nor a text that is only code, links, paths or ids.
 */
export function recipeUnits(recipe) {
  const out = [];
  const put = (key, text) => { if (typeof text === "string" && hasWords(text)) out.push({ key, text }); };
  const md = (key, text) => mdBlocks(text).forEach((b, i) => { if (!b.skip) out.push({ key: `${key}.${i}`, text: b.text }); });
  for (const [b, p] of blockPaths(recipe)) {
    switch (b.type) {
      case "heading": put(`${p}.text`, b.text); break;
      case "text": md(`${p}.md`, b.md); break;
      case "callout": put(`${p}.title`, b.title); md(`${p}.md`, b.md); break;
      case "list": (b.items ?? []).forEach((x, i) => put(`${p}.items.${i}`, x)); break;
      case "table":
        (b.columns ?? []).forEach((c, i) => put(`${p}.col.${i}`, typeof c === "string" ? c : c?.label));
        (b.rows ?? []).forEach((r, i) => (Array.isArray(r) ? r : []).forEach((c, j) => put(`${p}.cell.${i}.${j}`, typeof c === "string" ? c : null)));
        break;
      case "stats": (b.items ?? []).forEach((x, i) => { put(`${p}.label.${i}`, x?.label); put(`${p}.note.${i}`, x?.note); }); break;
      case "image": case "video": case "audio": case "pdf": put(`${p}.caption`, b.caption); break;
      case "pair": put(`${p}.before`, b.before?.caption); put(`${p}.after`, b.after?.caption); break;
      case "check": put(`${p}.summary`, b.summary); put(`${p}.caption`, b.caption); break;
      case "details": put(`${p}.summary`, b.summary); break;
      case "choice": put(`${p}.question`, b.question); (b.options ?? []).forEach((o, i) => put(`${p}.desc.${i}`, o?.description)); break;
    }
  }
  return out;
}

/** The direction for a whole recipe: from all its texts together. */
export const recipeDirection = (recipe) => direction(recipeUnits(recipe).map((u) => u.text).join("\n"));

// ---- settings ---------------------------------------------------------------------------------------------------

// Settings › Translation (Everywhere only): kept as everywhere.translation { on, base_url, model, key } in Shepherdr's
// settings file; key is the name of a secret in Settings › Secrets (Everywhere), never its value.
export const SETTINGS = {
  title: "Translation",
  about: "A Translate button on agents' messages, proofs and artifacts shows a translation under each paragraph: English to Chinese, Chinese to English.",
  on: "Translate button",
  onAbout: (url) => `When you press Translate, the words of that message or artifact are sent to ${url || "the endpoint below"}. Nothing else is sent, and no other service is called.`,
  first: (url) => `Translation sends the words of each message or artifact you translate to ${url || "the endpoint you set"}. Only that endpoint is called. Turn it on?`,
  base: "Endpoint (base URL)",
  baseAbout: "An OpenAI-compatible API, e.g. https://api.openai.com/v1 (…/chat/completions is added).",
  basePlaceholder: "https://api.openai.com/v1",
  model: "Model",
  modelAbout: "The model that translates, as the endpoint names it.",
  modelPlaceholder: "gpt-4o-mini",
  key: "API key",
  keyAbout: "A secret's name from Settings › Secrets (Everywhere): its value is used here only, never shown or logged.",
  keyNone: "No secrets kept yet: add one in Settings › Secrets first.",
  test: "Test connection",
  testButton: "Test",
  testAbout: "Sends one short line to the endpoint and shows what came back.",
  tested: (model, ms) => `Connected: ${model} answered in ${(ms / 1000).toFixed(1)} s.`,
  badUrl: "That isn't an http(s) URL.",
};

export const DEFAULTS = { on: false, base_url: "", model: "", key: "" };

/** Settings' translation block, whole: { on, base_url, model, key } (Everywhere's; missing fields their defaults). */
export function configOf(file) {
  const t = file?.everywhere?.translation;
  const s = (v) => (typeof v === "string" ? v.trim() : "");
  return { on: t?.on === true, base_url: s(t?.base_url), model: s(t?.model), key: s(t?.key), agreed: typeof t?.agreed === "number" ? t.agreed : 0 };
}

/** What stops a translation now, in words, or null when it can go. */
export function notReady(cfg) {
  if (!cfg?.on) return WORDS.off;
  if (!endpointOf(cfg.base_url) || !cfg.model || !cfg.key) return WORDS.notSet;
  return null;
}

// ---- the key ------------------------------------------------------------------------------------------------------

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/** The vault's Everywhere value of a name (the vault file's text), else "". */
export function vaultValue(text, name) {
  try {
    const v = JSON.parse(text);
    const e = (Array.isArray(v?.secrets) ? v.secrets : []).find((x) => x?.name === name && x?.scope === "everywhere");
    return typeof e?.value === "string" ? e.value : "";
  } catch { return ""; }
}

/** Run with python3 on the machine that keeps the secrets: prints {"key"} (Everywhere's value of name, or ""). */
export const keyScript = (name) => {
  if (!NAME.test(name)) throw new Error("Not a secret's name.");
  return `
import json
${PY}
key = ""
try:
    with open(SHEP(".herdr/vault.json")) as f:
        v = json.load(f)
    key = next((e["value"] for e in v.get("secrets", []) if e.get("name") == ${JSON.stringify(name)} and e.get("scope") == "everywhere" and isinstance(e.get("value"), str)), "")
except Exception:
    pass
print(json.dumps({"key": key}))
`;
};

/**
 * The key's value, as a voice call finds its key (core/voice.js voiceKey): the vault here when this machine keeps the
 * secrets (or none is named yet), else read from the machine that does over herdr-core's link, into memory only.
 * -> { key } or { error }. io: where() (`herdr-secret where --json`), vault() (the vault's text here), ask(machine,
 * script) (python3 -c there: its stdout), machines() (the linked machines that are on, when none is named).
 */
export async function findKey(io, name) {
  if (!NAME.test(String(name ?? ""))) return { error: WORDS.notSet };
  const none = `there's no secret ${name} in Settings › Secrets (Everywhere)`;
  const w = await io.where().catch(() => null);
  if (!w || w.here || !w.set) {
    const here = vaultValue(io.vault() ?? "", name);
    if (here) return { key: here };
    if (w && !w.here && !w.set) {
      for (const m of (await io.machines?.().catch(() => null)) ?? []) {
        const r = await ask(io, m, name);
        if (r) return { key: r };
      }
    }
    return { error: none };
  }
  if (!w.name) return { error: "the machine that keeps your secrets isn't linked from here" };
  const out = await io.ask(w.name, keyScript(name)).catch(() => null);
  if (out === null || out === undefined) return { error: `couldn't reach ${w.name}, which keeps your secrets` };
  let r = null;
  try { r = JSON.parse(String(out).trim().split("\n").pop()); } catch {}
  return typeof r?.key === "string" && r.key ? { key: r.key } : { error: none };
}

async function ask(io, machine, name) {
  const out = await io.ask(machine, keyScript(name)).catch(() => null);
  try { const r = JSON.parse(String(out ?? "").trim().split("\n").pop()); return typeof r?.key === "string" && r.key ? r.key : ""; } catch { return ""; }
}
