// Translate (SHEP-102, core/translate.js): a message's or an artifact's translation, made here with this machine's key
// for the window's chats and the web app's, other machines' chats too (their text comes here). Only the endpoint the
// person set in Settings › Translation is ever called; the key is a Secrets name, its value read into memory only (the
// vault here, or the machine that keeps the secrets: voice.ts does the same for its key) and never logged or sent
// anywhere but that endpoint. One translation per message (its text) or artifact version and target language is kept
// in this service's folder (translations/), so the window, the web app and the phone share it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { marked } from "marked";
import * as TR from "../core/translate.js";

const T = TR as any;
/** A code point as a page shows it: out of range is the replacement character. */
const point = (n: number) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd");
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Words as a page shows them: HTML entities and markdown's backslash escapes decoded. */
export const decoded = (s: string) => s
  .replace(/&#(\d+);?/g, (_, n) => point(Number(n)))
  .replace(/&#x([0-9a-f]+);?/gi, (_, n) => point(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
  .replace(/\\([!-\/:-@[-`{-~])/g, "$1");
/** A message's blocks as the page draws them: marked's own parse (core/translate.js blocksFromTokens). */
const split = (md: string) => T.blocksFromTokens(marked.lexer(md));
const defsOf = (md: string) => T.linkDefs(marked.lexer(md));
type Config = { on: boolean; base_url: string; model: string; key: string; agreed: number };
type Key = { key: string } | { error: string };
/** parts: the window's parts (core/translate.js windowParts): the window has no marked to split the message itself */
export type MessageResult = { ok: true; target: string; blocks: (string | null)[]; failed: number[]; parts: unknown[] } | { ok: false; error: string };
/** mdParts: each markdown field's window parts, by its place ("4.md") */
export type ArtifactResult = { ok: true; target: string; units: Record<string, string>; failed: string[]; mdParts: Record<string, unknown[]> } | { ok: false; error: string };

/** The most a message may be: longer ones are refused rather than sent in pieces nobody asked for. */
const MOST = 60_000;
/** How long a found key is kept in memory (a key changed in Settings › Secrets is used after at most this long). */
const KEY_KEEP = 10 * 60_000;
/** The fewest letters and digits a key may have: every real API key has more, and a shorter one could hide in words. */
const KEY_MIN = 16;
const CHANGED = "Settings › Translation changed while it translated: try again";

export type TranslatorIO = {
  /** Settings › Translation as the settings file has it now (core/translate.js configOf). */
  config: () => Config;
  /** the value of a secret (Everywhere), found as voice.ts finds its key */
  key: (name: string) => Promise<Key>;
  /** a recipe artifact's recipe (service/artifacts.ts) */
  recipe: (id: string, v: number, on: string | null) => Promise<{ blocks: unknown[] } | null>;
  /** a chat's message by its id, read from its conversation here (never the words a caller sends): text, the words its
   *  chat shows (core/chat-view.js mediaIn); raw, the agent's words as written; writing, its agent may still be writing
   *  it (or that can't be told). null: no such agent reply. */
  messageOf?: (where: { chat?: string; addr?: string }, id: string) => Promise<{ text: string; raw: string; writing: boolean; media?: boolean } | null>;
  /** where translations are kept */
  dir: string;
  fetchFn?: typeof fetch;
  now?: () => number;
};

export class Translator {
  private keys = new Map<string, { at: number; key: Promise<Key> }>();
  private running = new Map<string, Promise<unknown>>();
  /** Settings › Translation › Test connection's last answer, shown under its row. */
  lastTest: { ok: boolean; text: string; at: number } | null = null;

  constructor(private io: TranslatorIO) {}

  private now() { return this.io.now?.() ?? Date.now(); }

  private keyOf(name: string) {
    const k = this.keys.get(name);
    if (k && this.now() - k.at < KEY_KEEP) return k.key;
    const mine = { at: this.now(), key: this.io.key(name).catch((e) => ({ error: String(e?.message ?? e) }) as Key) };
    this.keys.set(name, mine);
    mine.key.then((x) => { if ("error" in x && this.keys.get(name) === mine) this.keys.delete(name); });
    return mine.key;
  }

  /** One request to the endpoint: the model's answer text. Settings › Translation as it is now first: turned off or
   *  pointed elsewhere since this translation started, nothing more is sent (not to the old endpoint, nor the new). */
  private async ask(cfg: Config, texts: string[], target: string, testing = false, used?: Set<string>): Promise<string> {
    const url = T.endpointOf(cfg.base_url);
    if (!url) throw new Error(T.WORDS.notSet);
    const k = await this.keyOf(cfg.key);
    if ("error" in k) throw new Error(k.error);
    // a key short enough to turn up in ordinary words can't be watched for in answers: it isn't used
    if (k.key.replace(/[^\p{L}\p{N}]+/gu, "").length < KEY_MIN) throw new Error(T.WORDS.shortKey);
    used?.add(k.key);
    // right before it goes (after the key's lookup, which can take a while)
    const now = this.io.config();
    if ((!testing && !now.on) || now.base_url !== cfg.base_url || now.model !== cfg.model || now.key !== cfg.key) throw new Error(CHANGED);
    let r: Response;
    try {
      r = await (this.io.fetchFn ?? fetch)(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
        headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" },
        body: JSON.stringify(T.requestBody(cfg.model, texts, target)),
      });
    } catch (e) {
      // the key out before anything is cut short: a cut can't leave a piece of it
      throw new Error(`couldn't reach the endpoint (${String((e as Error)?.message ?? e).replaceAll(k.key, "…").slice(0, 120)})`);
    }
    const body = (await r.text()).replaceAll(k.key, "…");
    if (r.status === 401 || r.status === 403) this.keys.delete(cfg.key);
    if (!r.ok) throw new Error(T.apiError(r.status, body));
    let d: any = null;
    try { d = JSON.parse(body); } catch {}
    const text = T.answerText(d);
    if (typeof text !== "string") throw new Error("the endpoint's answer had no message in it");
    // the key this request used, taken out of the answer as it decodes (it can come escaped, twice over)
    const out = text.split(k.key).join("…");
    try {
      const arr = JSON.parse(out.trim().replace(/^```[\w-]*\s*\n?/, "").replace(/\n?```\s*$/, ""));
      const clean = (v: unknown): unknown => (typeof v === "string" ? v.split(k.key).join("…") : Array.isArray(v) ? v.map(clean)
        : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, clean(b)])) : v);
      return JSON.stringify(clean(arr));
    } catch { return out; }
  }

  private file(kind: string, id: string, target: string) {
    return join(this.io.dir, `${createHash("sha256").update(`${kind}\0${id}\0${target}`).digest("hex").slice(0, 40)}.json`);
  }
  private read(f: string): any { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }
  private write(f: string, v: unknown) {
    mkdirSync(this.io.dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${f}.tmp`, JSON.stringify(v), { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }

  /** Translations with every key this translation's requests used taken out (as decoded: an answer can carry one
   *  escaped, or wrapped in words the parser looked past): never returned nor kept. */
  private scrub(got: (string | null)[], used: Set<string>) {
    // the words as a page renders them (marked: links' addresses gone, emphasis and escapes resolved, entities
    // decoded), letters and digits only: a translation whose rendered words hold a key that way is dropped whole (that
    // block shows as not translated)
    const bare = (s: string) => decoded(s).replace(/[^\p{L}\p{N}]+/gu, "");
    const rendered = (s: string) => bare(String(marked.parseInline(s, { async: false })).replace(/<[^>]*>/g, ""));
    const keys = [...used].map(bare).filter(Boolean);
    return got.map((t) => {
      if (!t) return t;
      let x = t;
      for (const k of used) if (k) x = x.split(k).join("…");
      // an HTML entity this check can't read could spell anything: such a translation goes too
      if (/&(?!(?:amp|lt|gt|quot|apos|nbsp);)[a-z][a-z0-9]*;/i.test(x)) return null;
      const r = rendered(x), b = bare(x);
      return keys.some((k) => r.includes(k) || b.includes(k)) ? null : x;
    });
  }

  /** One at a time per thing translated: a second press (another screen) waits for the first. */
  private once<R>(id: string, fn: () => Promise<R>): Promise<R> {
    const was = this.running.get(id);
    if (was) return was as Promise<R>;
    const p = fn().finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  /** A message's translation, block by block (core/translate.js blocksFromTokens: null where a block has none). Kept by
   *  its text and the target; asked again, only the blocks that failed are sent. */
  async message(text: string, raw = text): Promise<MessageResult> {
    const cfg = this.io.config();
    const why = T.notReady(cfg);
    if (why) return { ok: false, error: why };
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "There's nothing to translate." };
    if (text.length > MOST) return { ok: false, error: "This message is too long to translate." };
    // a reply whose pictures or clips its chat takes out to show under its words isn't translated (yet): taking them
    // out can change what is code, and its blocks would differ from the agent's own words
    if (raw !== text) return { ok: false, error: T.WORDS.media };
    const blocks = split(text);
    const target = T.blocksDirection(blocks);
    // the cache's name says its layout and the very words sent (an older layout's, or other inputs', is never read;
    // two at once share one only when both match)
    const sent = JSON.stringify(blocks.map((b: any) => (b.skip ? null : b.text)));
    const f = this.file("message:marked3", `${text}\0${sent}`, target);
    return this.once(f, async () => {
      const { at, texts } = T.messageTexts(blocks);
      const kept = this.read(f);
      // a kept translation only where its block has words (a slot of code, a rule or HTML never comes back)
      const out: (string | null)[] = Array.isArray(kept?.blocks) && kept.blocks.length === blocks.length
        ? kept.blocks.map((x: unknown, i: number) => (blocks[i].skip || typeof x !== "string" ? null : x)) : blocks.map(() => null);
      const need = at.map((i: number, k: number) => ({ i, text: texts[k] })).filter((x: { i: number }) => !out[x.i]);
      if (need.length) {
        let got: (string | null)[];
        const used = new Set<string>();
        try { got = this.scrub(await T.translateTexts(need.map((x: { text: string }) => x.text), target, (t: string[], to: string) => this.ask(cfg, t, to, false, used)), used); }
        catch (e) { return { ok: false, error: T.WORDS.failed((e as Error).message) } as MessageResult; }
        need.forEach((x: { i: number }, k: number) => { if (got[k]) out[x.i] = got[k]; });
        this.write(f, { target, at: this.now(), blocks: out });
      }
      const failed = at.filter((i: number) => !out[i]);
      return { ok: true, target, blocks: out, failed, parts: T.windowParts(blocks, out, failed, defsOf(text)) } as MessageResult;
    });
  }

  /** An artifact version's translation, by its texts' places (core/translate.js recipeUnits). */
  async artifact(id: string, v: number, on: string | null): Promise<ArtifactResult> {
    const cfg = this.io.config();
    const why = T.notReady(cfg);
    if (why) return { ok: false, error: why };
    const recipe = await this.io.recipe(id, v, on).catch(() => null);
    if (!recipe) return { ok: false, error: "Only a recipe artifact can be translated." };
    const units: { key: string; text: string }[] = T.recipeUnits(recipe, split);
    if (!units.length) return { ok: false, error: "There's nothing to translate." };
    const target = T.recipeDirection(recipe, split);
    // the version's own words: a version changed in place (same number) is translated again
    const sum = createHash("sha256").update(JSON.stringify(units)).digest("hex").slice(0, 16);
    const f = this.file("artifact:marked3", `${on ?? ""}\0${id}\0${v}\0${sum}`, target);
    return this.once(f, async () => {
      const kept = this.read(f);
      const out: Record<string, string> = kept?.units && typeof kept.units === "object" ? kept.units : {};
      const need = units.filter((u) => !out[u.key]);
      if (need.length) {
        let got: (string | null)[];
        const used = new Set<string>();
        try { got = this.scrub(await T.translateTexts(need.map((u) => u.text), target, (t: string[], to: string) => this.ask(cfg, t, to, false, used)), used); }
        catch (e) { return { ok: false, error: T.WORDS.failed((e as Error).message) } as ArtifactResult; }
        need.forEach((u, k) => { if (got[k]) out[u.key] = got[k]!; });
        this.write(f, { target, at: this.now(), units: out });
      }
      const failed = units.filter((u) => !out[u.key]).map((u) => u.key);
      return { ok: true, target, units: out, failed, mdParts: T.recipeParts(recipe, split, defsOf, out, failed) } as ArtifactResult;
    });
  }

  /** Settings › Translation › Test connection: one short line to the endpoint, as set now (on or not). */
  async test(): Promise<{ ok: boolean; text?: string; error?: string }> {
    const cfg = { ...this.io.config(), on: true };
    const why = T.notReady(cfg);
    const done = (ok: boolean, text: string) => { this.lastTest = { ok, text, at: this.now() }; return ok ? { ok, text } : { ok, error: text }; };
    if (why) return done(false, why);
    this.keys.delete(cfg.key);
    const t0 = this.now();
    try {
      const got = T.parseTranslations(await this.ask(cfg, ["Hello"], "zh", true), 1);
      if (!got) return done(false, "The endpoint answered, but not with the translation asked for: try another model.");
      return done(true, T.SETTINGS.tested(cfg.model, this.now() - t0));
    } catch (e) { return done(false, T.WORDS.failed((e as Error).message)); }
  }

  /** The web app's and the window's translate action: { text } or { artifact, v, on }. */
  handle(body: any): Promise<MessageResult | ArtifactResult> {
    if (typeof body?.artifact === "string") return this.artifact(body.artifact, Number(body.v) || 1, typeof body.on === "string" && body.on ? body.on : null);
    // a message by its chat and its id: its words are read here from its conversation, never taken from the caller,
    // and one its agent may still be writing is never sent (the buttons wait too; this is the last word on it)
    const where = { chat: typeof body?.chat === "string" ? body.chat : undefined, addr: typeof body?.addr === "string" ? body.addr : undefined };
    const id = typeof body?.id === "string" ? body.id : "";
    if (!(where.chat || where.addr) || !id || !this.io.messageOf) return Promise.resolve({ ok: false, error: "Translate a message from its chat." });
    return this.io.messageOf(where, id).then((m) => {
      if (!m) return { ok: false, error: "That message isn't in its chat any more." } as MessageResult;
      if (m.writing) return { ok: false, error: T.WORDS.writing } as MessageResult;
      if (m.media) return { ok: false, error: T.WORDS.media } as MessageResult;
      return this.message(m.text, m.raw);
    });
  }
}

/** Where a service keeps its translations. */
export const translationsDir = (data: string) => join(data, "translations");
