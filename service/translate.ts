// Translate (SHEP-102, core/translate.js): a message's or an artifact's translation, made here with this machine's key
// for the window's chats and the web app's, other machines' chats too (their text comes here). Only the endpoint the
// person set in Settings › Translation is ever called; the key is a Secrets name, its value read into memory only (the
// vault here, or the machine that keeps the secrets: voice.ts does the same for its key) and never logged or sent
// anywhere but that endpoint. One translation per message (its text) or artifact version and target language is kept
// in this service's folder (translations/), so the window, the web app and the phone share it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as TR from "../core/translate.js";

const T = TR as any;
type Config = { on: boolean; base_url: string; model: string; key: string; agreed: number };
type Key = { key: string } | { error: string };
export type MessageResult = { ok: true; target: string; blocks: (string | null)[]; failed: number[] } | { ok: false; error: string };
export type ArtifactResult = { ok: true; target: string; units: Record<string, string>; failed: string[] } | { ok: false; error: string };

/** The most a message may be: longer ones are refused rather than sent in pieces nobody asked for. */
const MOST = 60_000;
/** How long a found key is kept in memory (a key changed in Settings › Secrets is used after at most this long). */
const KEY_KEEP = 10 * 60_000;

export type TranslatorIO = {
  /** Settings › Translation as the settings file has it now (core/translate.js configOf). */
  config: () => Config;
  /** the value of a secret (Everywhere), found as voice.ts finds its key */
  key: (name: string) => Promise<Key>;
  /** a recipe artifact's recipe (service/artifacts.ts) */
  recipe: (id: string, v: number, on: string | null) => Promise<{ blocks: unknown[] } | null>;
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

  /** One request to the endpoint: the model's answer text. */
  private async ask(cfg: Config, texts: string[], target: string): Promise<string> {
    const url = T.endpointOf(cfg.base_url);
    if (!url) throw new Error(T.WORDS.notSet);
    const k = await this.keyOf(cfg.key);
    if ("error" in k) throw new Error(k.error);
    let r: Response;
    try {
      r = await (this.io.fetchFn ?? fetch)(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
        headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" },
        body: JSON.stringify(T.requestBody(cfg.model, texts, target)),
      });
    } catch (e) {
      throw new Error(`couldn't reach the endpoint (${String((e as Error)?.message ?? e).replace(k.key, "…").slice(0, 120)})`);
    }
    const body = await r.text();
    if (r.status === 401 || r.status === 403) this.keys.delete(cfg.key);
    if (!r.ok) throw new Error(T.apiError(r.status, body).replaceAll(k.key, "…"));
    let d: any = null;
    try { d = JSON.parse(body); } catch {}
    const text = T.answerText(d);
    if (typeof text !== "string") throw new Error("the endpoint's answer had no message in it");
    return text;
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

  /** One at a time per thing translated: a second press (another screen) waits for the first. */
  private once<R>(id: string, fn: () => Promise<R>): Promise<R> {
    const was = this.running.get(id);
    if (was) return was as Promise<R>;
    const p = fn().finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  /** A message's translation, block by block (core/translate.js mdBlocks: null where a block has none). Kept by its
   *  text and the target; asked again, only the blocks that failed are sent. */
  async message(text: string): Promise<MessageResult> {
    const cfg = this.io.config();
    const why = T.notReady(cfg);
    if (why) return { ok: false, error: why };
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "There's nothing to translate." };
    if (text.length > MOST) return { ok: false, error: "This message is too long to translate." };
    const target = T.direction(text);
    const f = this.file("message", text, target);
    return this.once(f, async () => {
      const { blocks, at, texts } = T.messageTexts(text);
      const kept = this.read(f);
      const out: (string | null)[] = Array.isArray(kept?.blocks) && kept.blocks.length === blocks.length ? kept.blocks : blocks.map(() => null);
      const need = at.map((i: number, k: number) => ({ i, text: texts[k] })).filter((x: { i: number }) => !out[x.i]);
      if (need.length) {
        let got: (string | null)[];
        try { got = await T.translateTexts(need.map((x: { text: string }) => x.text), target, (t: string[], to: string) => this.ask(cfg, t, to)); }
        catch (e) { return { ok: false, error: T.WORDS.failed((e as Error).message) } as MessageResult; }
        need.forEach((x: { i: number }, k: number) => { if (got[k]) out[x.i] = got[k]; });
        this.write(f, { target, at: this.now(), blocks: out });
      }
      const failed = at.filter((i: number) => !out[i]);
      return { ok: true, target, blocks: out, failed } as MessageResult;
    });
  }

  /** An artifact version's translation, by its texts' places (core/translate.js recipeUnits). */
  async artifact(id: string, v: number, on: string | null): Promise<ArtifactResult> {
    const cfg = this.io.config();
    const why = T.notReady(cfg);
    if (why) return { ok: false, error: why };
    const recipe = await this.io.recipe(id, v, on).catch(() => null);
    if (!recipe) return { ok: false, error: "Only a recipe artifact can be translated." };
    const units: { key: string; text: string }[] = T.recipeUnits(recipe);
    if (!units.length) return { ok: false, error: "There's nothing to translate." };
    const target = T.recipeDirection(recipe);
    // the version's own words: a version changed in place (same number) is translated again
    const sum = createHash("sha256").update(JSON.stringify(units)).digest("hex").slice(0, 16);
    const f = this.file("artifact", `${on ?? ""}\0${id}\0${v}\0${sum}`, target);
    return this.once(f, async () => {
      const kept = this.read(f);
      const out: Record<string, string> = kept?.units && typeof kept.units === "object" ? kept.units : {};
      const need = units.filter((u) => !out[u.key]);
      if (need.length) {
        let got: (string | null)[];
        try { got = await T.translateTexts(need.map((u) => u.text), target, (t: string[], to: string) => this.ask(cfg, t, to)); }
        catch (e) { return { ok: false, error: T.WORDS.failed((e as Error).message) } as ArtifactResult; }
        need.forEach((u, k) => { if (got[k]) out[u.key] = got[k]!; });
        this.write(f, { target, at: this.now(), units: out });
      }
      return { ok: true, target, units: out, failed: units.filter((u) => !out[u.key]).map((u) => u.key) } as ArtifactResult;
    });
  }

  /** Settings › Translation › Test connection: one short line to the endpoint, as set now (on or not). */
  async test(): Promise<{ ok: boolean; error?: string }> {
    const cfg = { ...this.io.config(), on: true };
    const why = T.notReady(cfg);
    const done = (ok: boolean, text: string) => { this.lastTest = { ok, text, at: this.now() }; return ok ? { ok } : { ok, error: text }; };
    if (why) return done(false, why);
    this.keys.delete(cfg.key);
    const t0 = this.now();
    try {
      const got = T.parseTranslations(await this.ask(cfg, ["Hello"], "zh"), 1);
      if (!got) return done(false, "The endpoint answered, but not with the translation asked for: try another model.");
      return done(true, T.SETTINGS.tested(cfg.model, this.now() - t0));
    } catch (e) { return done(false, T.WORDS.failed((e as Error).message)); }
  }

  /** The web app's and the window's translate action: { text } or { artifact, v, on }. */
  handle(body: any): Promise<MessageResult | ArtifactResult> {
    if (typeof body?.artifact === "string") return this.artifact(body.artifact, Number(body.v) || 1, typeof body.on === "string" && body.on ? body.on : null);
    return this.message(String(body?.text ?? ""));
  }
}

/** Where a service keeps its translations. */
export const translationsDir = (data: string) => join(data, "translations");
