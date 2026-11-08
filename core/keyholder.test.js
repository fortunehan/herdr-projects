import { expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

// lib/keyholder.js run against a stand-in shared state. Not mock.module("herdr"): Bun's module mocks last the whole
// run, and every later test file importing "herdr" would get this stub.
const state = new Map();
const src = readFileSync(new URL("../lib/keyholder.js", import.meta.url), "utf8")
  .replace(/^import .* from "herdr";$/m, "")
  .replace(/^export /gm, "");
const { KEY_HOLDER, holdKeys, releaseKeys, keysElsewhere, keysOver } = new Function("shared", "setShared",
  `${src}\nreturn { KEY_HOLDER, holdKeys, releaseKeys, keysElsewhere, keysOver };`)(
  (k) => state.get(k) ?? null, (k, v) => state.set(k, v));

beforeEach(() => state.clear());

test("Mark up's note in the viewer holds the keyboard over the panes: the chat leaves it, even when its pane gets focus", () => {
  holdKeys("artifact.markup", true);
  const h = state.get(KEY_HOLDER);
  expect(h).toMatchObject({ who: "artifact.markup", over: true });
  expect(keysElsewhere(h, "p1")).toBe(true);
  expect(keysOver(h, "p1")).toBe(true);
});

test("a panel's holder stops the chat's refocus, but not its pane getting focus", () => {
  holdKeys("tasks");
  const h = state.get(KEY_HOLDER);
  expect(h.over).toBeUndefined();
  expect(keysElsewhere(h, "p1")).toBe(true);
  expect(keysOver(h, "p1")).toBe(false);
});

test("the chat's own box holding it, or nobody, lets the chat take it", () => {
  holdKeys("p1");
  expect(keysElsewhere(state.get(KEY_HOLDER), "p1")).toBe(false);
  expect(keysOver(state.get(KEY_HOLDER), "p1")).toBe(false);
  expect(keysElsewhere(null, "p1")).toBe(false);
  expect(keysOver(null, "p1")).toBe(false);
});

test("closing the viewer gives the keyboard back only when its field still holds it", () => {
  holdKeys("artifact.markup", true);
  releaseKeys("artifact.markup");
  expect(state.get(KEY_HOLDER)).toBeNull();
  holdKeys("p1");
  releaseKeys("artifact.markup");
  expect(state.get(KEY_HOLDER)).toMatchObject({ who: "p1" });
});

test("holding again writes only on a change (shared state re-renders every mod)", () => {
  let writes = 0;
  const set = state.set.bind(state);
  state.set = (k, v) => { writes++; return set(k, v); };
  holdKeys("artifact.markup", true);
  holdKeys("artifact.markup", true);
  expect(writes).toBe(1);
  holdKeys("artifact.markup", false);
  expect(writes).toBe(2);
  delete state.set;
});

test("the artifact files copied on their own write the same record as keyholder.js", () => {
  for (const [file, who] of [["markup.js", "artifact.markup"], ["recipe-view.js", "artifact.form"]]) {
    const src = readFileSync(new URL(`../mods/artifacts/${file}`, import.meta.url), "utf8");
    expect(src).toContain(`const HOLDER = "${KEY_HOLDER}", ME = "${who}";`);
    expect(src).toContain("setShared(HOLDER, over ? { who: ME, at: Date.now(), over: true } : { who: ME, at: Date.now() });");
  }
  const bar = readFileSync(new URL("../mods/chat-image/artifact-bar.js", import.meta.url), "utf8");
  expect(bar).toContain('releaseKeys("artifact.markup");');
  expect(bar).toContain('releaseKeys("artifact.form");');
});
