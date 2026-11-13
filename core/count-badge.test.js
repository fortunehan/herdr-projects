import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Record the native builder tree without registering process-wide module mocks.
function element(style = {}) {
  const node = { style: { ...style }, children: [] };
  const self = new Proxy(node, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "child") return (child) => { node.children.push(child); return self; };
      if (key === "when") return (condition, apply) => condition ? apply(self) : self;
      return (...args) => { node.style[key] = args.length ? args[0] : true; return self; };
    },
  });
  return self;
}

const source = readFileSync(new URL("../lib/ui.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
const badgeFor = (dark) => new Function("div", "h_flex", "settings", `${source}\nreturn countBadge;`)(
  element, () => element({ flex: true, flex_row: true, items_center: true }), () => ({ dark }),
);
const countBadge = badgeFor(true);
const counts = [0, 1, 2, 9, 10, 99];
const cap = (n) => n > 9 ? "9+" : String(n);

function expectCentered(part) {
  const text = part.children[0];
  expect(text.style).toMatchObject({ h: 16, line_height: "16px", flex_none: true, whitespace_nowrap: true });
  expect(part.style).toMatchObject({ h: 16, flex_none: true, flex: true, items_center: true, justify_center: true });
  expect(text.children).toHaveLength(1);
}

describe("native count badge alignment (SHEP-41)", () => {
  test("both halves use identical fixed-height centering, including unequal counts and 9+", () => {
    for (const need of counts.slice(1)) for (const ready of counts.slice(1)) {
      const badge = countBadge(need, ready, "#252525");
      expect(badge.style).toMatchObject({ h: 16, flex_none: true, text_size: 11, font_semibold: true });
      expect(badge.children).toHaveLength(3);
      const [left, separator, right] = badge.children;
      expectCentered(left);
      expectCentered(right);
      expect(left.children[0].children).toEqual([cap(need)]);
      expect(right.children[0].children).toEqual([cap(ready)]);
      expect(left.style).toMatchObject({ bg: "#ff6369", w: need > 9 ? 19 : 15, rounded_l: 8 });
      expect(right.style).toMatchObject({ bg: "#3dd68c", w: ready > 9 ? 19 : 15, rounded_r: 8 });
      expect(separator.style).toMatchObject({ w: 1, h: 16, flex_none: true, bg: "#252525" });
      expect(separator.children).toEqual([]);
      if (need === ready) expect(left.children[0].style).toEqual(right.children[0].style);
    }
  });

  test("zero and single-color states retain their counts, compact sizes and optical centering", () => {
    for (const n of counts) for (const [need, ready] of [[n, 0], [0, n]]) {
      const badge = countBadge(need, ready, "#252525");
      expect(badge.children).toHaveLength(1);
      const part = badge.children[0];
      expectCentered(part);
      expect(part.style).toMatchObject({ min_w: 16, px: n > 9 ? 4 : 0, rounded: 8, bg: need ? "#ff6369" : "#3dd68c" });
      expect(part.children[0].children).toEqual([cap(n)]);
      expect(part.children[0].style.ml).toBe(n === 1 ? 1 : undefined);
    }
  });

  test("light and dark fills and foregrounds are unchanged", () => {
    for (const dark of [true, false]) {
      const badge = badgeFor(dark)(1, 1, "#252525");
      expect(badge.style.text_color).toBe(dark ? "#000000" : "#ffffff");
      expect(badge.children[0].style.bg).toBe(dark ? "#ff6369" : "#e5484d");
      expect(badge.children[2].style.bg).toBe(dark ? "#3dd68c" : "#30a46c");
    }
  });
});
