// Translate on an artifact (SHEP-102, core/translate.js): the viewer's bar and the sidebar's have a Translate button
// that asks this machine's service (service/translate.ts) for the whole version's translation; the artifact's own
// recipe view (mods/artifacts/recipe-view.js, copied into each artifact) draws each text's translation under it from
// shared "artifacts.translate", and its Retry asks again through the same key (state "retry"), which the bars pick up.
// Shared: the source is lib/artifact-translate.js; bin/sync-shared copies it into each mod in lib/COPIES.
// Edit lib/artifact-translate.js, never a mod's copy, then run bin/sync-shared.

import { shared, setShared, readTextFile } from "herdr";
import { localService, localToken } from "./local.js";
import { dirs, dirsReady } from "./dirs.js";
import { WORDS, configOf } from "./core/translate.js";

export const KEY = "artifacts.translate";
/** An artifact version's entry: { shown, state: "loading" | "done" | "error" | "retry", units, failed, error }. */
export const keyOf = (a) => `${a?.machine ?? ""}|${a?.id}|${a?.version}`;
export const stateOf = (a) => (shared(KEY) ?? {})[keyOf(a)] ?? null;

function put(k, v) {
  const all = { ...(shared(KEY) ?? {}) };
  delete all[k];
  all[k] = v;
  // the last 12 translated versions are kept here (the service keeps every one)
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - 12))) delete all[old];
  setShared(KEY, all);
}

let on = false, readAt = 0;
/** Settings › Translation is on (read from the settings file at most every 15 s). */
export function translateOn(cx) {
  if (Date.now() - readAt > 15000) {
    readAt = Date.now();
    cx?.spawn?.(async (cx) => {
      await dirsReady();
      let now = false;
      try { now = configOf(JSON.parse((await readTextFile(dirs().settings)) ?? "{}")).on; } catch {}
      if (now !== on) { on = now; cx.notify(); }
    });
  }
  return on;
}

/** The bar's Translate: shows the version's translation (asked for once), or hides it. */
export function toggleArtifact(cx, a) {
  const s = stateOf(a);
  if (s?.shown && s.state !== "loading") return put(keyOf(a), { ...s, shown: false });
  if (s?.state === "done" && !s.failed?.length) return put(keyOf(a), { ...s, shown: true });
  if (s?.state !== "loading") askArtifact(cx, a);
}

/** Asks this machine's service for it; only what failed before is sent again. */
export function askArtifact(cx, a) {
  const k = keyOf(a), was = stateOf(a);
  put(k, { ...was, shown: true, state: "loading", error: null });
  cx.spawn(async (cx) => {
    let r = null;
    try {
      const svc = await localService(cx), token = await localToken();
      if (!svc || !token) throw new Error(WORDS.noService);
      const res = await fetch(`${svc.base}/api/action`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "translate", artifact: a.id, v: a.version, on: a.machine ?? null }) });
      r = await res.json().catch(() => null);
      if (!res.ok || !r) throw new Error(`the service answered ${res.status}`);
    } catch (e) { r = { ok: false, error: WORDS.failed(String(e?.message ?? e)) }; }
    const shown = stateOf(a)?.shown ?? true;
    put(k, r.ok ? { shown, state: "done", units: r.units ?? {}, failed: r.failed ?? [] } : { ...was, shown, state: "error", error: r.error });
    cx.notify();
  });
}

/** From a bar's init: a Retry pressed in an artifact (its entry set to "retry") is asked again. */
export function watchRetries(cx) {
  cx.timer.every(700, (cx) => {
    for (const [k, s] of Object.entries(shared(KEY) ?? {})) {
      if (s?.state !== "retry") continue;
      const [machine, id, version] = k.split("|");
      askArtifact(cx, { id, version: Number(version), machine: machine || null });
    }
  });
}
