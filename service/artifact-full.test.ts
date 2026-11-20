// SHEP-90: the window's artifact viewer (mods/chat-image/artifact-bar.js over lib/artview.js) has a Full screen
// button: the viewer opens again over the whole window, the artifact edge to edge; the same button, or Esc, puts it back
// where it was (over its chat pane, or the modal over a dialog). No window runs here: herdr and gpui are stand-ins.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, dispatch, fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const theme = new Proxy({}, { get: () => "#000000" });
let given: any = {};
const opened: any[] = [];
const closed: string[] = [];
let store: Record<string, unknown> = {};
mock.module("herdr", () => fakeHerdr({
  theme: () => theme,
  props: () => given,
  openOverlay: (spec: unknown) => { opened.push(spec); return "o2"; },
  closeOverlay: (id: string) => { closed.push(id); return null; },
  shared: (k: string) => store[k],
  setShared: (k: string, v: unknown) => { store[k] = v; return null; },
  settings: () => ({ zoom: 1 }),
  panes: () => [],
  layout: () => null,
  exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
}));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase());

const bar = await import("../mods/chat-image/artifact-bar.js");
const cx: any = new Proxy({ spawn: () => undefined }, { get: (t, k) => (t as any)[k] ?? (() => {}) });
const AREA = { x: 300, y: 40, width: 700, height: 800 };
const art = (more: object = {}) => ({ mod: "art-x", base: "art-x", id: "x", title: "Proof", version: 2, latest: 2, machine: null, ...more });
const draw = (a: any) => {
  given = { artifact: a, overlay: "o1" };
  built.length = 0;
  const view: any = { art: { versions: [], busy: false } };
  return bar.artifactBar(view, a, null);
};
const padding = (spec: any) => spec.layout.children[1].padding;

describe("Full screen in the window's artifact viewer (SHEP-90)", () => {
  beforeEach(() => { opened.length = 0; closed.length = 0; store = {}; });

  test("the bar has the button, small and full screen, in a modal too", () => {
    for (const a of [art({ area: AREA }), art({ area: AREA, full: true }), art({ modal: true })]) {
      draw(a);
      expect(byId("full")).toBeTruthy();
    }
  });

  test("over a chat pane: it opens again on the whole window, edge to edge, and back over the same pane", () => {
    draw(art({ area: AREA }));
    dispatch(byId("full")!, "on_click", cx);
    expect(closed).toEqual(["o1"]);
    expect(opened[0]).toMatchObject({ kind: "popup", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 } });
    expect(padding(opened[0])).toEqual([0, 0]);
    const full = opened[0].layout.children[0].content.props.artifact;
    expect(full).toMatchObject({ full: true, area: AREA });
    draw(full);
    dispatch(byId("full")!, "on_click", cx);
    expect(opened[1]).toMatchObject({ kind: "popup", width: AREA.width, height: AREA.height, at: { x: AREA.x, y: AREA.y } });
    expect(padding(opened[1])).toEqual([8, 24]);
  });

  test("a modal over a dialog: full screen is a dialog the window's size, and back the modal's own size", () => {
    draw(art({ modal: true }));
    dispatch(byId("full")!, "on_click", cx);
    expect(opened[0]).toMatchObject({ kind: "dialog", width: 1, height: 1 });
    const full = opened[0].layout.children[0].content.props.artifact;
    draw(full);
    dispatch(byId("full")!, "on_click", cx);
    expect(opened[1].kind).toBe("dialog");
    expect(opened[1].width).toBeGreaterThan(1);
  });

  test("Esc while full screen puts it back (and goes no further); Esc otherwise is left to the app", () => {
    let stopped = 0;
    const kx: any = { ...cx, stop_propagation: () => { stopped++; } };
    draw(art({ area: AREA }));
    bar.artifactBarKey({ key: "escape" }, kx);
    expect(opened.length).toBe(0);
    expect(stopped).toBe(0);
    draw(art({ area: AREA, full: true }));
    bar.artifactBarKey({ key: "a" }, kx);
    expect(opened.length).toBe(0);
    bar.artifactBarKey({ key: "escape" }, kx);
    expect(stopped).toBe(1);
    expect(opened[0]).toMatchObject({ kind: "popup", at: { x: AREA.x, y: AREA.y } });
    expect(opened[0].layout.children[0].content.props.artifact.full).toBe(false);
  });

  test("its Mark up ends as it switches", () => {
    store["artifacts.markup"] = { mod: "art-x", where: "viewer" };
    draw(art({ area: AREA }));
    dispatch(byId("full")!, "on_click", cx);
    expect(store["artifacts.markup"]).toBe(null);
  });
});
