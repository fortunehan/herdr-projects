import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Waiting to merge uses a static pause ring in the window", () => {
  const source = readFileSync(new URL("../lib/dot.js", import.meta.url), "utf8")
    .replace(/^import .*;$/gm, "")
    .replace(/^export \{.*;$/gm, "")
    .replace(/\bexport /g, "");
  const svg = (path) => ({ path, size() { return this; }, flex_none() { return this; },
    text_color(color) { this.color = color; return this; } });
  const taskDot = new Function("svg", "theme", "red", "green", `${source}\nreturn taskDot;`)(svg, () => ({}), () => "red", () => "green");
  const mark = taskDot("merging");
  expect(mark.path).toBe("mods/tasks/waiting-to-merge.svg");
  expect(mark.color).toBe("green");
  const image = readFileSync(new URL(`../${mark.path}`, import.meta.url), "utf8");
  expect(image).toContain('<circle cx="7" cy="7" r="6.25"');
  expect(image).toContain('d="M5.25 4.5v5M8.75 4.5v5"');
});
