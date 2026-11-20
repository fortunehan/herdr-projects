// Shepherdr Settings keeps the keyboard while it is open (SHEP-92): Herdr still counts the Assistant chat's pane focused
// under the dialog, and the chat gave its box the keyboard back on its next redraw, so a click in Settings > Tasks >
// Branch names put the caret in the chat. Settings now holds it (keyholder.js dialogKeys()), its instructions editor
// hands it back to Settings, and closing gives it to the chat again. No window runs here: gpui and herdr are stand-ins.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const shared = new Map<string, any>();
const timers: ((cx: any) => void)[] = [];
let overlay: string | null = "o1";
let extra: Record<string, unknown> = {};
const opened: any[] = [];
function el(): any {
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "when") return (c: unknown, f: (e: any) => any) => (c ? f(self) : self);
      return () => self;
    },
  });
  return self;
}
const theme = new Proxy({}, { get: () => "#000000" });
// A text field's state: value() is empty, every other method does nothing.
const Field = { new: () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : k === "value" ? () => "" : () => {}) }) };
mock.module("herdr", () => fakeHerdr({
  shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => { shared.set(k, v); },
  props: () => ({ ...extra, ...(overlay ? { overlay } : {}) }), theme: () => theme, home: () => "/nonexistent-home",
  exec: async () => ({ code: 1, stdout: "", stderr: "" }), hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  closeOverlay: () => {}, openOverlay: (o: any) => { opened.push(o); return "o2"; }, machines: () => [], spaces: () => [],
  agents: () => [], panes: () => [], terminals: () => [], focused: () => null, settings: () => ({}),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => new Promise(() => {}),
  knownAgents: async () => [], window: () => ({ platform: "linux" }), appHome: () => "/nonexistent-app",
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: el, svg: el, image: el }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: el, h_flex: el, Input: el, Textarea: el, Scrollbar: el, Editor: el,
  InputState: Field, TextareaState: Field, EditorState: Field }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Settings } = await import("../mods/shepherdr-settings/main.js");
const { default: Coordinator } = await import("../mods/coordinator/main.js");
const K = await import("../mods/chat/keyholder.js");
const cx: any = new Proxy({ timer: { every: (_ms: number, f: any) => timers.push(f), after: () => ({ cancel() {} }) },
  notify: () => {}, spawn: () => {}, focus_handle: () => ({ focus() {} }) }, { get: (t, k) => (t as any)[k] ?? (() => {}) });
const holder = () => shared.get(K.KEY_HOLDER);

describe("Shepherdr Settings keeps the keyboard (SHEP-92)", () => {
  beforeEach(() => { shared.clear(); timers.length = 0; opened.length = 0; overlay = "o1"; extra = {}; });

  test("open, it holds the keyboard; closed, it lets it go", async () => {
    shared.set(K.KEY_HOLDER, { who: "p3", at: Date.now() }); // the Assistant chat's box had it
    const s: any = new Settings();
    s.init({}, cx);
    expect(holder().who).toBe("dialog:settings");
    expect(K.dialogHolds(holder())).toBe(true);
    await s.close();
    expect(holder().who).toBe(null);
    for (const f of timers) f(cx); // its renewal stops with it
    expect(holder().who).toBe(null);
  });

  test("open for a long time, it keeps holding it", () => {
    const s: any = new Settings();
    s.init({}, cx);
    const old = Date.now() - K.DIALOG_FRESH + 500;
    shared.set(K.KEY_HOLDER, { who: "dialog:settings", at: old });
    for (const f of timers) f(cx);
    expect(holder().at).toBeGreaterThan(old);
  });

  test("its instructions editor holds it, and hands it back to Settings when it closes", () => {
    const s: any = new Settings();
    s.init({}, cx);
    s.edit({ file: "/nonexistent/assistant.md", id: "coordinator", title: "Assistant" });
    expect(opened[0].props.keysBack).toBe("dialog:settings");
    const e: any = new Coordinator();
    overlay = "o2";
    extra = opened[0].props;
    e.init({}, cx);
    expect(holder().who).toBe("dialog:instructions");
    e.dropKeys();
    expect(holder().who).toBe("dialog:settings");
    expect(K.dialogHolds(holder())).toBe(true);
  });

  test("a copy that isn't an overlay holds nothing", () => {
    overlay = null;
    const drop = K.dialogKeys("dialog:x", cx);
    expect(holder()).toBeUndefined();
    drop();
    expect(holder()).toBeUndefined();
  });

  test("the Assistant chat behind it doesn't take the keyboard while it's open, and does once it closes", async () => {
    const { default: Chat } = await import("../mods/chat/main.js");
    let focused = 0;
    const chat: any = Object.create(Chat.prototype);
    // Its box lost the keyboard to Settings' field a while after the last press in the chat.
    Object.assign(chat, { box: { focus: () => { focused++; } }, wasFocused: true, hadBox: true, focused: false, press: null, call: null });
    chat.areaKey = () => "p3";
    const now: any = { timer: { after: (_ms: number, f: any) => f(now) }, notify: () => {} };
    const s: any = new Settings();
    s.init({}, cx);
    chat.refocus(true, true, now); // a redraw: a message arrived
    chat.refocusAt = 0;
    chat.refocus(true, true, now);
    expect(focused).toBe(0);
    await s.close();
    chat.refocus(true, true, now);
    expect(focused).toBe(1);
  });
});
