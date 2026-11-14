import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { props, theme, closeOverlay, shared } from "herdr";
import { reviews, reviewRecords } from "./reviews.js";
import { disabled, LEVELS, sourceKey, reportText, effortReason } from "./core/changes-review.js";
import { targetKey } from "./core/review-target.js";
import { keepKeys, dropKeys } from "./keyholder.js";

const HOLDER = "dialog:changes-review";
const label = (s) => s === "xhigh" ? "Xhigh" : s[0].toUpperCase() + s.slice(1);

export default class ReviewDialog extends View {
  init(_props, cx) {
    this.p = props() ?? _props ?? {};
    this.form = { loading: true, effort: "high", depth: "high", guidance: "", sources: [], models: [] };
    this.prompt = TextareaState.new({ placeholder: "Optional supplementary guidance" });
    this.prompt.set_rows(3);
    this.search = InputState.new({ placeholder: "Search configured models" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.prompt.on("change", () => { this.form.guidance = this.prompt.value(); });
    keepKeys(HOLDER);
    this.refresh(cx);
    cx.timer.every(3000, (cx) => {
      keepKeys(HOLDER);
      if (this.p.report) { this.refresh(cx); return; }
      const now = shared("changes.review.target");
      if (now && targetKey(now) !== this.form.targetKey) { this.form.stale = true; cx.notify(); }
      if (!this.form.loading && !this.form.error && !this.form.busy && !this.checking) {
        this.checking = true;
        cx.spawn(async (cx) => {
          try {
            const f = await reviews.prepare(now ?? this.p.target);
            if (f.sourcesKey !== this.form.sourcesKey) this.form.stale = true;
          } catch { this.form.stale = true; }
          finally { this.checking = false; cx.notify(); }
        });
      }
    });
  }

  close() { this.prompt.release(); this.search.release(); dropKeys(HOLDER); }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    const was = this.form;
    this.form = { ...was, loading: true, error: null, stale: false };
    cx.spawn(async (cx) => {
      try {
        if (this.p.report) this.record = (await reviewRecords()).find((r) => r.id === this.p.report);
        else {
          const f = await reviews.prepare(shared("changes.review.target") ?? this.p.target);
          this.form = was.target ? { ...f, model: was.model, effort: was.effort, depth: was.depth, guidance: was.guidance } : f;
        }
      } catch (e) { this.form.error = String(e?.message ?? e); }
      finally { this.form.loading = false; this.refreshing = false; cx.notify(); }
    });
  }

  launch(cx) {
    if (disabled(this.form)) return;
    const form = this.form;
    form.guidance = this.prompt.value();
    form.busy = true; this.launchError = null;
    cx.spawn(async (cx) => {
      try {
        // busy is a View latch; the feature boundary separately prevents concurrent launches.
        await reviews.launch({ ...form, busy: false }, shared("changes.review.target") ?? this.p.target);
        closeOverlay(this.p.overlay);
      } catch (e) { this.launchError = String(e?.message ?? e); }
      finally { form.busy = false; cx.notify(); }
    });
    cx.notify();
  }

  button(id, text, fn, t, enabled = true) {
    return div().id(id).px(10).py(6).rounded(6).bg(t.raised).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => { if (enabled) fn(cx); }).child(text);
  }

  render(cx) {
    const t = theme(), f = this.form, input = this.p.target ?? {}, target = f.target ?? input;
    const reason = disabled(f), row = (name, value) => h_flex().flex_none().gap(10).items_start()
      .child(div().w(140).flex_none().text_size(11).text_color(t.muted).child(name)).child(div().flex_1().min_w(0).child(value));
    const shell = v_flex().size_full().overflow_y_scrollbar().p(18).gap(12).bg(t.background).text_color(t.foreground).text_size(13);
    if (this.p.report) {
      const r = this.record;
      return shell.child(div().font_semibold().child("Review report"))
        .child(div().flex_1().min_h(0).overflow_y_scrollbar().child(TextView.new(r ? reportText(r) : this.form.error || "Loading report…")))
        .child(h_flex().gap(8).when(Boolean(r && !["passed", "failed", "cancelled"].includes(r.state)), (e) => e.child(this.button("review-stop", "Cancel review", (cx) => {
          cx.spawn(async (cx) => { await reviews.cancel(r.id); this.refresh(cx); });
        }, t))).child(this.button("review-report-close", "Close", () => closeOverlay(this.p.overlay), t)));
    }
    const selected = f.models.find((m) => m.id === f.model);
    const effortLimits = [...new Set(LEVELS.map((l) => effortReason(f.model ?? "", l)).filter(Boolean))];
    return shell.child(div().font_semibold().text_size(18).child("Review"))
      .child(div().text_size(11).text_color(t.dim).child("Independent review in a shared checkout. Plan mode is CLI permission policy, not a filesystem sandbox."))
      .child(row("Checkout", div().child(target.root ?? target.cwd ?? "No folder")))
      .when(Boolean(target.task), (e) => e.child(row("Followed task", div().child(target.task))))
      .child(row("Comparison", div().child(`${({ uncommitted: "Uncommitted", base: "Base", ref: "Branch" })[target.mode] ?? "Resolving"} · ${target.ref ?? "HEAD / unborn"}`)))
      .child(row("Resolved ref / base", div().text_size(11).child(`${target.resolvedRef ?? "none"} / ${target.base ?? target.head ?? "unborn"}`)))
      .child(row("Agent CLI", div().child("Claude Code")))
      .child(row("Model", this.button("review-model", selected ? `${selected.name} · ${selected.id}` : "Choose a model", (cx) => { this.modelOpen = !this.modelOpen; cx.notify(); }, t)))
      .when(this.modelOpen, (e) => e.child(v_flex().h(168).gap(4)
        .child(Input.new(this.search).h(28))
        .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(f.models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes((this.search.value() ?? "").toLowerCase())).map((m) =>
          this.button(`review-model-${m.id}`, `${m.name} · ${m.id}`, (cx) => { f.model = m.id; this.modelOpen = false; cx.notify(); }, t))))))
      .when(Boolean(f.catalog), (e) => e.child(div().text_size(11).text_color(t.dim).child(f.catalog === "fallback" ? "Built-in fallback catalog loaded; select a model explicitly." : "Current configured Claude catalog")))
      .child(row("Model effort", h_flex().gap(5).children(LEVELS.map((l) => this.button(`review-effort-${l}`, `${f.effort === l ? "[" : ""}${label(l)}${f.effort === l ? "]" : ""}`, (cx) => { f.effort = l; cx.notify(); }, t,
        !effortReason(f.model ?? "", l) && (!selected?.efforts || selected.efforts.includes(l)))))))
      .when(effortLimits.length > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child(effortLimits.join(". "))))
      .child(row("Review depth", h_flex().gap(5).children(LEVELS.map((l) => this.button(`review-depth-${l}`, `${f.depth === l ? "[" : ""}${label(l)}${f.depth === l ? "]" : ""}`, (cx) => { f.depth = l; cx.notify(); }, t)))))
      .child(row("Source session", v_flex().max_h(88).overflow_y_scrollbar().gap(3)
        .when(!f.sources.length, (e) => e.child(div().text_color(t.dim).child("No matching live Source session")))
        .children(f.sources.map((s) => this.button(`review-source-${s.address}`, `${f.source === sourceKey(s) ? "Selected · " : ""}${s.name} · ${s.address} · ${s.conversation}`, (cx) => { f.source = sourceKey(s); cx.notify(); }, t)))))
      .child(row("Prompt", Textarea.new(this.prompt).h(62)))
      .child(div().text_size(11).text_color(t.dim).child("The complete comparison is reviewed. Findings remain pending; automatic repair and recheck are not available yet."))
      .when(Boolean(reason || this.launchError), (e) => e.child(div().id("review-reason").text_size(12).text_color(t.ansi1).child(this.launchError || reason)))
      .child(h_flex().gap(8).child(this.button("review-refresh", "Refresh", (cx) => this.refresh(cx), t, !f.busy))
        .child(div().flex_1()).child(this.button("review-cancel", "Cancel", () => closeOverlay(this.p.overlay), t, !f.busy))
        .child(this.button("review-run", f.busy ? "Starting…" : "Run", (cx) => this.launch(cx), t, !reason)));
  }
}
