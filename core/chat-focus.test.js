import { describe, expect, test } from "bun:test";
import { TextPress, QUIET_MS, DRAG_PX, LEAVE_MS } from "./chat-focus.js";

const at = (x, y = 100) => ({ x, y });

describe("a plain press in the chat gives the box the keyboard back as before", () => {
  test("not within the quiet time, then yes", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    p.up(at(10));
    expect(p.selecting).toBe(false);
    expect(p.mayRefocus(QUIET_MS)).toBe(false);
    expect(p.mayRefocus(QUIET_MS + 1)).toBe(true);
    expect(p.mayTake()).toBe(true);
  });

  test("a jitter of a few pixels is still a click", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    p.up(at(10 + DRAG_PX - 1, 101));
    expect(p.mayRefocus(QUIET_MS + 1)).toBe(true);
  });

  test("nothing pressed yet: the box may take it", () => {
    const p = new TextPress();
    expect(p.mayTake()).toBe(true);
    expect(p.mayRefocus(QUIET_MS + 1)).toBe(true);
  });
});

describe("selecting a message's text keeps the keyboard off the box", () => {
  test("a drag held longer than the quiet time, while a working agent renders every second", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    for (let t = 1000; t <= 5000; t += 1000) expect(p.mayRefocus(t)).toBe(false);
    expect(p.mayTake()).toBe(false);
  });

  test("after the drag, for the Cmd+C however late it comes", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    expect(p.up(at(200, 140))).toBe(true);
    expect(p.selecting).toBe(true);
    expect(p.mayRefocus(2500)).toBe(false);
    expect(p.mayRefocus(60_000)).toBe(false);
  });

  test("a double or triple click selects a word or a line", () => {
    for (const clicks of [2, 3]) {
      const p = new TextPress();
      p.down(at(10), clicks, 0);
      p.up(at(10));
      expect(p.mayRefocus(10_000)).toBe(false);
    }
  });

  test("a release outside the chat never reaches it: still held, still selecting", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    expect(p.mayRefocus(30_000)).toBe(false);
  });

  test("the next plain press lets the selection go", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    p.up(at(200));
    p.down(at(50), 1, 5000);
    p.up(at(50));
    expect(p.mayRefocus(5000 + QUIET_MS + 1)).toBe(true);
  });

  test("a release with no press before it changes nothing", () => {
    const p = new TextPress();
    expect(p.up(at(10))).toBe(false);
    expect(p.selecting).toBe(false);
  });
});

describe("the pane just getting focus (its 0 ms and 600 ms takes)", () => {
  test("a press from another pane held through both takes: neither moves the keyboard", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    expect(p.mayTake()).toBe(false);
  });

  test("a plain click into the pane: the take after the release puts the keyboard in the box", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    expect(p.mayTake()).toBe(false);
    p.up(at(10));
    expect(p.mayTake()).toBe(true);
  });

  test("a quick drag into the pane: the 600 ms take leaves the selection alone", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    p.up(at(120));
    expect(p.mayTake()).toBe(false);
  });

  test("going to another pane and back gives the box the keyboard again", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    p.up(at(120));
    p.leftPane(LEAVE_MS + 1);
    expect(p.mayTake()).toBe(true);
  });

  test("Herdr's late focus settling right after the press doesn't drop the selection", () => {
    const p = new TextPress();
    p.down(at(10), 1, 0);
    p.leftPane(50);
    p.up(at(120));
    p.leftPane(300);
    expect(p.mayTake()).toBe(false);
    const q = new TextPress();
    q.down(at(10), 1, 0);
    q.leftPane(LEAVE_MS + 500);
    expect(q.selecting).toBe(true);
  });
});
