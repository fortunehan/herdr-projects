// SHEP-90: the pictures an artifact's picture viewer pages through, and a picture's size from its first bytes
import { expect, test } from "bun:test";
import { pictures, imageSize } from "./recipe.js";

test("pictures: every picture in reading order, nested ones too, each once, never a clip", () => {
  const r = { blocks: [
    { type: "image", src: "a.png", caption: "First" },
    { type: "pair", before: { src: "b.jpg" }, after: { src: "c.mp4" } },
    { type: "columns", columns: [[{ type: "image", src: "d.webp" }], [{ type: "image", src: "a.png" }]] },
    { type: "tabs", tabs: [{ label: "x", blocks: [{ type: "details", summary: "s", blocks: [{ type: "image", src: "e.gif", caption: "Deep" }] }] }] },
    { type: "pair", before: { src: "f.png", caption: "Old" }, after: { src: "g.png" } },
    { type: "video", src: "h.mp4", poster: "p.png" },
  ] };
  expect(pictures(r)).toEqual([
    { src: "a.png", caption: "First" },
    { src: "b.jpg", caption: "Before" },
    { src: "d.webp", caption: "" },
    { src: "e.gif", caption: "Deep" },
    { src: "f.png", caption: "Old" },
    { src: "g.png", caption: "After" },
  ]);
  expect(pictures(null)).toEqual([]);
  expect(pictures({ blocks: "x" })).toEqual([]);
});

const bytes = (...parts) => Uint8Array.from(parts.flat());
const pad = (n) => new Array(n).fill(0);

test("imageSize reads PNG, GIF, JPEG and WebP headers", () => {
  const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], [0, 0, 0x05, 0x00], [0, 0, 0x02, 0xd0], pad(8));
  expect(imageSize(png)).toEqual({ w: 1280, h: 720 });
  const gif = bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], [0x90, 0x01], [0xc8, 0x00], pad(20));
  expect(imageSize(gif)).toEqual({ w: 400, h: 200 });
  // SOI, an APP0 segment, a DHT (skipped), then SOF2 (progressive): height 390, width 844
  const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x10], pad(14), [0xff, 0xc4, 0x00, 0x04, 0, 0], [0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x86, 0x03, 0x4c], pad(12));
  expect(imageSize(jpeg)).toEqual({ w: 844, h: 390 });
  const riff = (kind, body) => bytes([0x52, 0x49, 0x46, 0x46], pad(4), [0x57, 0x45, 0x42, 0x50], [...kind].map((c) => c.charCodeAt(0)), body);
  // VP8X: canvas width-1 and height-1 as 24-bit numbers at 24 and 27
  expect(imageSize(riff("VP8X", [...pad(8), 0x1f, 0x03, 0x00, 0xdf, 0x01, 0x00]))).toEqual({ w: 800, h: 480 });
  // VP8 (lossy): 14-bit width and height at 26 and 28
  expect(imageSize(riff("VP8 ", [...pad(10), 0x40, 0x01, 0xf0, 0x00]))).toEqual({ w: 320, h: 240 });
  // VP8L (lossless): 14 bits each, minus one, from byte 21
  const w = 99, h = 49, bits = (w - 1) | ((h - 1) << 14);
  expect(imageSize(riff("VP8L", [...pad(4), 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff]))).toEqual({ w, h });
});

test("imageSize reads the repo's own pictures as macOS's sips does", async () => {
  const read = async (p) => imageSize(new Uint8Array(await Bun.file(new URL(`../${p}`, import.meta.url)).arrayBuffer()));
  expect(await read("web/public/splash/375x812@3-dark.png")).toEqual({ w: 1125, h: 2436 });
  expect(await read("assets/shepherdr-launch.webp")).toEqual({ w: 720, h: 720 });
  expect(await read("mods/chat-image/zoom-in.svg")).toEqual({ w: 24, h: 24 });
});

test("imageSize: an SVG by its width and height, else its viewBox", () => {
  const svg = (s) => imageSize(new TextEncoder().encode(s));
  expect(svg('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="640px" height="360" viewBox="0 0 10 10"></svg>')).toEqual({ w: 640, h: 360 });
  expect(svg('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 1200.5 800"></svg>')).toEqual({ w: 1201, h: 800 });
  expect(svg('<svg xmlns="http://www.w3.org/2000/svg" width="10em" height="5em"></svg>')).toBe(null);
});

test("imageSize: null when it can't tell", () => {
  expect(imageSize(null)).toBe(null);
  expect(imageSize(bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x10], pad(14)))).toBe(null);
  expect(imageSize(bytes([0x89, 0x50, 0x4e, 0x47], pad(20)))).toBe(null);
});
