// The shown space's machine and branch, global task totals, and the palette key.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, keys, shared } from "herdr";
import { spaces, inRender } from "./live.js";
import { statusCounts } from "./inbox.js";
import { red, green, TEXT, RADIUS } from "./ui.js";

// A machine as the sidebar shows it (mods/spaces-chat sections.js machineLook): the name it was
// given there, else its own.
const machineName = (m) => (shared("spaces-chat")?.machines?.[m ?? ""]?.name) || (m ?? "This computer");

export default class WorkspaceStatus extends View {
  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("Commands") instead of lying.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  Commands` : "Commands";
  }

  // One copy of Herdr's live lists for the whole render (live.js): past ~50 ms Herdr stops it.
  render(cx) {
    return inRender(() => this.draw(cx));
  }

  draw() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const counts = statusCounts();
    const roomy = (this.width ?? 1000) >= 700;
    const label = (icon, text) => h_flex().min_w(0).gap(6).items_center()
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).flex_none()).child(div().truncate().child(text));
    const total = (id, text, n, color) => h_flex().id(id).flex_none().gap(4).items_center()
      .text_color(id === "status-ready" ? color : t.muted)
      .child(div().text_color(n > 0 || id === "status-ready" ? color : t.dim).child(String(n))).child(text);
    return h_flex().size_full().min_w(0).px(10).gap(12).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(TEXT.label).text_color(t.muted)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .when(roomy, el => el.child(h_flex().flex_1().min_w(0).overflow_hidden().gap(12).items_center()
        .child(label(space?.machine ? "server" : "monitor", machineName(space?.machine ?? null)))
        .when(Boolean(space?.branch), el => el.child(div().max_w(180).truncate().child(label("branch", space.branch))))))
      .child(h_flex().id("task-status-counts").flex_none().gap(12).items_center()
        .accessibility_label("Tasks across all spaces and machines")
        .when(roomy, el => el.child(div().text_color(t.dim).child("All spaces")))
        .child(total("status-needs", "Needs you", counts.need, red()))
        .child(total("status-ready", "Ready", counts.ready, green()))
        .child(total("status-working", "Working", counts.working, t.working)))
      .when(!roomy, el => el.child(div().flex_1()))
      .when(roomy, el => el.child(div().id("palette").px(6).h(20).flex().items_center().rounded(RADIUS.control).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("app.palette")).child(this.hint())));
  }
}
