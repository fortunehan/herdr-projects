// The Translation page (SHEP-102, core/translate.js): the Translate button on agents' messages, proofs and artifacts,
// one setting for every space (Everywhere's translation: on, base_url, model, key). Only the endpoint set here is ever
// called, by this machine's service (service/translate.ts), with the key named here from Settings › Secrets; the key's
// value is never shown. The first time it is turned on, a toast says plainly where the words go. Test connection asks
// the service to send one short line. The web app's twin: its Settings › Translation page (service/settings.ts).

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { toggleSwitch, button, toast, TEXT } from "./ui.js";
import { localService, localToken } from "./local.js";
import { SETTINGS as S, configOf, endpointOf } from "./core/translate.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const FIELDS = [["base_url", S.base, S.baseAbout, S.basePlaceholder], ["model", S.model, S.modelAbout, S.modelPlaceholder], ["key", S.key, S.keyAbout, "TRANSLATE_API_KEY"]];

// Made in the window's init (an input needs a live host call): a box per field, saved on Enter and on leaving it.
export function translationInit(view) {
  const tr = { boxes: {}, shown: {}, focus: {}, err: {}, setting: false, test: null, testing: false };
  for (const [field] of FIELDS) {
    const box = (tr.boxes[field] = InputState.new({ placeholder: "" }));
    box.on("change", (_e, cx) => { if (!tr.setting) { tr.err[field] = ""; cx.notify(); } });
    box.on("focus", (_e, cx) => { tr.focus[field] = true; cx.notify(); });
    box.on("blur", (_e, cx) => { tr.focus[field] = false; save(view, tr, field, cx); });
    box.on("submit", (_e, cx) => save(view, tr, field, cx));
  }
  return tr;
}

const cfgOf = (view) => configOf(view.cfg);

function save(view, tr, field, cx) {
  const want = String(tr.boxes[field].value() ?? "").trim();
  if (field === "base_url" && want && !endpointOf(want)) { tr.err[field] = S.badUrl; return cx.notify(); }
  if (field === "key" && want && !NAME.test(want)) { tr.err[field] = "That isn't a secret's name (letters, digits and _)."; return cx.notify(); }
  tr.err[field] = "";
  if (want === cfgOf(view)[field]) return cx.notify();
  view.change((next) => {
    const t = ((next.everywhere ??= {}).translation ??= {});
    if (want) t[field] = want; else delete t[field];
  }, cx);
}

function turn(view, on, cx) {
  const first = on && !cfgOf(view).agreed;
  view.change((next) => {
    const t = ((next.everywhere ??= {}).translation ??= {});
    if (on) t.on = true; else delete t.on;
    if (first) t.agreed = Date.now();
  }, cx);
  // the first time: where the words go, plainly
  if (first) toast({ title: "Translation is on", body: S.first(cfgOf(view).base_url).replace(/ Turn it on\?$/, ""), level: "info" });
}

// Test connection: this machine's service sends one short line to the endpoint as set now.
function test(tr, cx) {
  if (tr.testing) return;
  tr.testing = true;
  tr.test = null;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const svc = await localService(cx), token = await localToken();
      if (!svc || !token) throw new Error("Shepherdr's service isn't running here.");
      const r = await fetch(`${svc.base}/api/action`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "setting", key: "translation.test" }) });
      const j = await r.json().catch(() => null);
      tr.test = j?.ok ? { ok: true, text: j.text ?? "Connected." } : { ok: false, text: j?.error ?? `The service answered ${r.status}.` };
    } catch (e) { tr.test = { ok: false, text: String(e?.message ?? e) }; }
    tr.testing = false;
    cx.notify();
  });
}

export function translationSection(view, t) {
  const tr = view.tr, c = cfgOf(view);
  // the boxes show the file's values, unless one is being typed in
  tr.setting = true;
  for (const [field] of FIELDS) if (tr.shown[field] !== c[field] && !tr.focus[field]) { tr.shown[field] = c[field]; tr.boxes[field].set_value(c[field]); }
  tr.setting = false;
  const box = (field, placeholder) => v_flex().items_end().gap(5)
    .child(div().relative().w(260)
      .child(Input.new(tr.boxes[field]).w_full().h(30).px(10).rounded(7).border_1().border_color(tr.err[field] ? t.blocked : tr.focus[field] ? t.accent : t.input)
        .bg(t.background).text_size(13).text_color(t.foreground))
      .when(!tr.boxes[field].value(), (el) => el.child(div().absolute().top(6).left(11).right(11).truncate().text_size(13).text_color(t.dim).child(placeholder))))
    .when(Boolean(tr.err[field]), (el) => el.child(div().w(260).text_size(12).line_height("17px").text_color(t.blocked).child(tr.err[field])));
  const result = tr.testing ? div().text_size(TEXT.label).text_color(t.dim).child("Testing…")
    : tr.test ? div().text_size(TEXT.label).text_color(tr.test.ok ? t.done : t.blocked).child(tr.test.text) : null;
  return v_flex().w_full()
    .child(div().pb(6).text_size(TEXT.label).line_height("17px").text_color(t.muted).child(S.about))
    .child(view.row(t, S.on, S.onAbout(c.base_url), toggleSwitch("translation-on", c.on, (next, _e, cx) => turn(view, next, cx))))
    .children(FIELDS.map(([field, title, about, placeholder]) => view.row(t, title, about, box(field, placeholder))))
    .child(view.row(t, S.test, S.testAbout, h_flex().gap(10).items_center()
      .when(Boolean(result), (el) => el.child(result))
      .child(button("translation-test", S.testButton, { disabled: tr.testing, onClick: (_e, cx) => test(tr, cx) }))));
}
