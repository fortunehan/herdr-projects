// Who last took the keyboard in the window (shared "keyboard.holder" = { who, at, over? }): a chat's box (its areaKey():
// its pane, or "thread" for a task's chat in the Tasks panel), the Tasks panel's list or search ("tasks"), the Artifacts
// sidebar's ("artifacts"), or a field inside an artifact: Mark up's note ("artifact.markup") or a recipe's form ("artifact.form"). Those panels
// and the artifact viewer are not panes, so Herdr still counts the Assistant chat's pane as focused while the person
// types there; that chat gives its box the keyboard back only while it is the holder (#633). over: the keyboard is in
// an overlay above the panes (the artifact viewer, a modal): even the chat's pane getting focus again doesn't take it
// back, as Herdr's focus can move under an overlay. markup.js and recipe-view.js are copied into each artifact on
// their own and can't import this file: they write the same record (keep them in step).
import { shared, setShared } from "herdr";

export const KEY_HOLDER = "keyboard.holder";

// A press or focus in `who`: it holds the keyboard now (written only when that changes).
export function holdKeys(who, over = false) {
  const h = shared(KEY_HOLDER);
  if (!who || (h?.who === who && Boolean(h.over) === over)) return;
  setShared(KEY_HOLDER, over ? { who, at: Date.now(), over: true } : { who, at: Date.now() });
}

// `who` going away (an overlay closed, Mark up done): nobody holds the keyboard, so the chat may take it back.
export function releaseKeys(who) {
  if (who && shared(KEY_HOLDER)?.who === who) setShared(KEY_HOLDER, null);
}

// Whether someone else than `mine` took the keyboard last.
export const keysElsewhere = (holder, mine) => Boolean(holder?.who && holder.who !== mine);

// Whether someone else than `mine` holds it in an overlay.
export const keysOver = (holder, mine) => keysElsewhere(holder, mine) && Boolean(holder.over);
