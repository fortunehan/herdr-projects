import { describe, expect, test } from "bun:test";
import { ListWidth, carry, anchorRow, SETTLE_MS, STEP } from "./chat-resize.js";

describe("the rows are laid out again once a drag settles, not on every pixel", () => {
  test("the first width is laid out at once", () => {
    const w = new ListWidth();
    w.note(800, 0);
    expect(w.relayout(0)).toBe(true);
    expect(w.laid).toBe(800);
    expect(w.wait(0)).toBe(null);
  });

  test("a drag of small steps waits, then lays out once at the last width", () => {
    const w = new ListWidth();
    w.note(800, 0);
    w.relayout(0);
    let laidOut = 0;
    for (let f = 1; f <= 20; f++) {
      w.note(800 - f * 3, f * 16);
      if (w.relayout(f * 16)) laidOut++;
    }
    expect(laidOut).toBe(0);
    expect(w.laid).toBe(800);
    const last = 20 * 16;
    expect(w.wait(last + 50)).toBe(SETTLE_MS - 50);
    expect(w.relayout(last + SETTLE_MS - 1)).toBe(false);
    expect(w.relayout(last + SETTLE_MS)).toBe(true);
    expect(w.laid).toBe(740);
    expect(w.relayout(last + SETTLE_MS + 100)).toBe(false);
  });

  test("a long drag lays out again each time it moves a whole step", () => {
    const w = new ListWidth();
    w.note(1000, 0);
    w.relayout(0);
    w.note(1000 - STEP + 2, 10);
    expect(w.relayout(10)).toBe(false);
    w.note(1000 - STEP, 20);
    expect(w.relayout(20)).toBe(true);
  });

  test("a wobble of a pixel is no change", () => {
    const w = new ListWidth();
    w.note(800, 0);
    w.relayout(0);
    w.note(800.6, 500);
    expect(w.changedAt).toBe(0);
    expect(w.relayout(1000)).toBe(false);
  });
});

describe("rows keep their last heights until measured again", () => {
  test("measured heights win over earlier ones, only for rows still there", () => {
    const prev = new Map([["a", 40], ["b", 60], ["gone", 99]]);
    const heights = new Map([["b", 80]]);
    expect([...carry(prev, heights, ["a", "b", "c"])]).toEqual([["a", 40], ["b", 80]]);
  });
});

describe("the row read at the top stays there", () => {
  const sizes = [100, 200, 50, 300];
  test("the first row on screen when the view starts near its top", () => {
    expect(anchorRow(sizes, 1, 120)).toBe(1);
  });
  test("the next row when the view starts near the first one's end", () => {
    expect(anchorRow(sizes, 1, 280)).toBe(2);
  });
  test("ends of the list", () => {
    expect(anchorRow([], 0, 0)).toBe(-1);
    expect(anchorRow(sizes, 3, 400)).toBe(3);
    expect(anchorRow(sizes, 9, 0)).toBe(3);
  });
});
