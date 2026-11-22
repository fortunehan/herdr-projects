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
  writing: "This reply is still being written: translate it once it's complete.",
  media: "A reply with pictures or clips can't be translated yet.",
  shortKey: "The key named in Settings › Translation is too short to be an API key (16 letters and digits at least).",
};

// ---- blocks ------------------------------------------------------------------------------------------------------
// The blocks come from marked's own parse of the message (its lexer's tokens: plain objects, passed in by the service and
// the web app, which both have marked), so they are exactly the blocks the page draws: a list item's code, a table's
// cells and a quote's heading are what marked says they are. The window has no marked: the service sends it the parts.

const TASK = /^\[[ xX]\][ \t]+/;
const quoted = (src) => String(src ?? "").replace(/\n+$/, "").split("\n").map((x) => `> ${x}`).join("\n");

/**
 * A message's blocks, in reading order, from marked's tokens (marked.lexer(md)): { kind, text, src, skip, ... }. kind:
 * "heading", "para", "quote" (a paragraph in a quote), "item" (a list item's own words; depth: how deep it is nested;
 * its marker as it shows: "3." in an ordered list), "cell" (table, row, col, cols), "code" (lang, code), "rule", "html"
 * or "def" (a link's reference). text: what is translated (inline markdown); src: the block's own markdown (the
 * window draws each block on its own). skip: nothing to translate (code, a rule, HTML, or only code, links, paths or
 * ids). The web app finds the same blocks in its page, rendered from the same tokens: h1-h6, p (not in a list item or
 * a cell), li, th/td, in this order.
 */
export function blocksFromTokens(tokens) {
  const out = [];
  let tables = 0;
  const put = (x) => out.push({ ...x, skip: !["heading", "para", "quote", "item", "cell"].includes(x.kind) || !hasWords(x.text ?? "") });
  const walk = (list, quote, depth) => {
    for (const t of list ?? []) {
      const q = (src) => (quote ? quoted(src) : String(src ?? "").replace(/\n+$/, ""));
      switch (t.type) {
        case "heading": put({ kind: "heading", text: String(t.text ?? "").trim(), src: q(t.raw), level: t.depth }); break;
        case "paragraph": put({ kind: quote ? "quote" : "para", text: String(t.text ?? "").replace(/\s*\n\s*/g, " ").trim(), src: q(t.raw) }); break;
        case "text": put({ kind: quote ? "quote" : "para", text: String(t.text ?? "").replace(/\s*\n\s*/g, " ").trim(), src: q(t.raw) }); break;
        case "blockquote": walk(t.tokens, true, depth); break;
        case "code": put({ kind: "code", text: "", src: q(t.raw), lang: String(t.lang ?? "").split(/\s+/)[0], code: String(t.text ?? "") }); break;
        case "hr": put({ kind: "rule", text: "", src: q(t.raw) }); break;
        case "html": put({ kind: "html", text: "", src: q(t.raw) }); break;
        case "def": put({ kind: "def", text: "", src: String(t.raw ?? "").replace(/\n+$/, "") }); break;
        case "table": {
          const tb = tables++, cols = (t.header ?? []).length;
          const rows = [t.header ?? [], ...(t.rows ?? [])];
          rows.forEach((r, ri) => Array.from({ length: cols }, (_, ci) => r[ci]).forEach((c, ci) =>
            put({ kind: "cell", text: String(c?.text ?? "").trim(), src: q(t.raw), table: tb, row: ri, col: ci, cols })));
          break;
        }
        case "list":
          (t.items ?? []).forEach((it, k) => {
            const marker = t.ordered ? `${(Number(t.start) || 1) + k}.` : "-";
            // its own words (a loose item's paragraphs together); its nested lists and code are blocks of their own
            const own = (it.tokens ?? []).filter((x) => x.type === "text" || x.type === "paragraph").map((x) => String(x.text ?? "").trim()).join(" ")
              .replace(/\s*\n\s*/g, " ").replace(TASK, "").trim();
            put({ kind: "item", text: own, src: q(`${marker} ${own}`), depth, ordered: !!t.ordered, marker });
            walk((it.tokens ?? []).filter((x) => x.type !== "text" && x.type !== "paragraph"), quote, depth + 1);
          });
          break;
      }
    }
  };
  walk(tokens, false, 0);
  return out;
}

/** The message's link references as markdown lines (marked keeps them in tokens.links), for the window's parts. */
export function linkDefs(tokens) {
  return Object.entries(tokens?.links ?? {}).map(([k, v]) => `[${k}]: ${v?.href ?? ""}${v?.title ? ` "${v.title}"` : ""}`).join("\n");
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
 *  aside), else "zh". Decided locally, with no model call. text: the words to translate (the blocks' texts: code is
 *  already out), see blocksDirection. */
export function direction(text) {
  const plain = plainWords(text);
  const cjk = (plain.match(CJK) ?? []).length;
  const letters = (plain.match(/\p{L}/gu) ?? []).length;
  return letters && cjk / letters > 0.3 ? "en" : "zh";
}

/** The direction for a message's blocks: from the words it sends (no code block of any kind counts). */
export const blocksDirection = (blocks) => direction(blocks.filter((b) => !b.skip).map((b) => b.text).join("\n\n"));

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

/** An endpoint's failure in a few plain words by its status: never its own words, which could quote the key. */
export function apiError(status) {
  if (status === 401 || status === 403) return `the endpoint refused the key (${status})`;
  if (status === 404) return "the endpoint or model wasn't found (404): check the base URL and the model";
  if (status === 429) return "the endpoint is busy or out of quota (429)";
  if (status === 400) return "the endpoint refused the request (400): check the model";
  return `the endpoint answered ${status}`;
}

/** A model's translation made inert against its original: no pictures or raw HTML (nothing that loads on its own),
 *  and a link only to an address the original names (else its words alone). */
export function inert(t, original = "") {
  return String(t ?? "")
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>\n]*>/g, "")
    .replace(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, words, url) => (String(original).includes(url) ? m : words));
}

/**
 * Translates texts into target. ask(texts) sends one request and gives the model's answer text (it throws on an
 * endpoint's error). Every text goes in ONE request; an answer that isn't an array of as many strings is asked again
 * text by text (a one-text message once more). -> an array as long as texts: each translation (inert), or null where it
 * failed. Throws when nothing could be translated (the error of the last try); a refused key or a missing model at once.
 */
export async function translateTexts(texts, target, ask, { parallel = 4 } = {}) {
  const out = texts.map(() => null);
  if (!texts.length) return out;
  let last = null, any = false;
  const one = async (idx) => {
    const got = parseTranslations(await ask(idx.map((i) => texts[i]), target), idx.length);
    if (!got) return false;
    got.forEach((t, k) => { out[idx[k]] = inert(t, texts[idx[k]]); });
    any = true;
    return true;
  };
  const all = texts.map((_, i) => i);
  // an endpoint's error (refused, busy, unreachable, settings changed) ends it at once: only an answer of the wrong
  // count or shape is asked again, each text on its own
  if (!(await one(all))) {
    const left = [...all];
    let stop = null;
    await Promise.all(Array.from({ length: Math.min(parallel, left.length) }, async () => {
      while (left.length && !stop) {
        const i = left.shift();
        try { if (!(await one([i]))) last ??= new Error("the model's answer wasn't the translation asked for"); } catch (e) { stop = e; }
      }
    }));
    if (stop) { if (!any) throw stop; last = stop; }
  }
  if (!any) throw last ?? new Error("the model's answer wasn't the translation asked for");
  return out;
}


// ---- a message's translation, block by block ------------------------------------------------------------------------

/** What a message sends: the texts of its blocks that have words, with where each goes (its block's index). */
export function messageTexts(blocks) {
  const at = [], texts = [];
  blocks.forEach((b, i) => { if (!b.skip) { at.push(i); texts.push(b.text); } });
  return { blocks, at, texts };
}

/**
 * The window's parts of a translated message (the service makes them: the window has no marked), in order: { type:
 * "md", text, depth } (a block's own markdown; a list item's depth and its number as it shows), { type: "tr", text,
 * depth } (its translation, under it), { type: "fail", depth } (a block that couldn't be translated), { type: "code",
 * lang, code } (drawn as the chat draws code: no translation), { type: "table", rows: [[{ text, tr, fail }]] } (each
 * cell's translation inside the cell; the first row the header). blocks: blocksFromTokens; tr: the translations by
 * block index (null where there is none); failed: the indexes that failed; defs: linkDefs (each part is drawn on its
 * own, so its reference links need them).
 */
export function windowParts(blocks, tr = [], failed = [], defs = "") {
  const bad = new Set(failed);
  const out = [];
  const own = (src) => (defs ? `${src}\n\n${defs}` : src);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "def") continue;
    if (b.kind === "code") { out.push({ type: "code", lang: b.lang, code: b.code }); continue; }
    if (b.kind === "cell") {
      const t = b.table, rows = [];
      for (; i < blocks.length && blocks[i].kind === "cell" && blocks[i].table === t; i++) {
        const c = blocks[i];
        (rows[c.row] ??= [])[c.col] = { text: own(c.text), tr: tr[i] ?? null, fail: bad.has(i) };
      }
      i--;
      out.push({ type: "table", rows: rows.map((r) => Array.from({ length: b.cols }, (_, k) => r?.[k] ?? { text: "", tr: null, fail: false })) });
      continue;
    }
    const depth = b.kind === "item" ? b.depth ?? 0 : 0;
    out.push({ type: "md", text: own(b.src), depth });
    if (tr[i]) out.push({ type: "tr", text: b.kind === "heading" ? `**${tr[i]}**` : tr[i], depth });
    else if (bad.has(i)) out.push({ type: "fail", depth });
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
 * a stat's label and note, a check's summary, a question, a tab's label, a chart's legend and labels). Code, commands,
 * buttons, a question's options and form fields aren't translated, nor a text that is only code, links, paths or ids.
 */
export function recipeUnits(recipe, split) {
  const out = [];
  const put = (key, text) => { if (typeof text === "string" && hasWords(text)) out.push({ key, text }); };
  const md = (key, text) => split(String(text ?? "")).forEach((b, i) => { if (!b.skip) out.push({ key: `${key}.${i}`, text: b.text }); });
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
      case "tabs": (b.tabs ?? []).forEach((x, i) => put(`${p}.tab.${i}`, x?.label)); break;
      // a chart's legend (its series' names) and its labels (a pie's slices, a bar or line chart's axis)
      case "chart":
        (b.series ?? []).forEach((x, i) => put(`${p}.series.${i}`, x?.name));
        (b.labels ?? []).forEach((x, i) => put(`${p}.label.${i}`, typeof x === "string" ? x : null));
        break;
      case "choice": put(`${p}.question`, b.question); break;
    }
  }
  return out;
}

/** The direction for a whole recipe: from all its texts together. */
export const recipeDirection = (recipe, split) => direction(recipeUnits(recipe, split).map((u) => u.text).join("\n\n"));

/** A recipe's markdown fields' window parts, by their place ("4.md"): the window draws each with its translations. */
export function recipeParts(recipe, split, defsOf, units = {}, failed = []) {
  const out = {};
  const bad = new Set(failed);
  for (const [b, p] of blockPaths(recipe)) {
    if (!(b.type === "text" || b.type === "callout") || typeof b.md !== "string") continue;
    const blocks = split(b.md), key = `${p}.md`;
    out[key] = windowParts(blocks, blocks.map((_, i) => units[`${key}.${i}`] ?? null), blocks.map((_, i) => i).filter((i) => bad.has(`${key}.${i}`)), defsOf(b.md));
  }
  return out;
}

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
  keyAbout: "A secret's name from Settings › Secrets (Everywhere): its value is used here only, never shown or logged (16 letters and digits at least).",
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
import json, os
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
