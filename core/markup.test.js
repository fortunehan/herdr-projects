import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describe as spot, MARKUP, NOTES_MAX, markupHint, markupSent, markupCount, toFrac, fromFrac, draftKey, draftText, readDraft, outgoing } from "./markup.js";

const window = readFileSync(new URL("../mods/artifacts/markup.js", import.meta.url), "utf8");
const size = { width: 720, height: 540 };
const note = (s, text) => ({ ...toFrac(s, size), text });

test("the spot in words, as the window sends it", () => {
  expect(spot({ x: 120, y: 80, w: 180, h: 80 }, size)).toBe("the 180×80 px area at x 120–300, y 80–160 of the 720×540 panel (near the top left)");
  expect(spot({ x: 360, y: 270, w: 0, h: 0 }, size)).toBe("the point at x 360, y 270 of the 720×540 panel (near the middle)");
});

test("the window's markup.js takes its words, spots and drafts from its copy of this file", () => {
  expect(window).toContain('from "./core/markup.js"');
  expect(window).not.toContain("function describe(");
  expect(readFileSync(new URL("../mods/artifacts/core/markup.js", import.meta.url), "utf8")).toBe(readFileSync(new URL("./markup.js", import.meta.url), "utf8"));
  expect(markupHint("Claude Code")).toBe("Click a spot or drag over an area, or write to Claude Code about all of it.");
  expect(markupSent("the agent")).toBe("Sent to the agent. A new version shows here when it's in.");
  expect(markupCount(1)).toBe("1 note");
  expect(markupCount(3)).toBe("3 notes");
});

test("a spot kept as fractions comes back in px at any size", () => {
  const f = toFrac({ x: 180, y: 135, w: 360, h: 0 }, size);
  expect(f).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0 });
  expect(fromFrac(f, { width: 1440, height: 1080 })).toEqual({ x: 360, y: 270, w: 720, h: 0 });
  expect(toFrac({ x: -5, y: 9999, w: 1, h: 1 }, size)).toMatchObject({ x: 0, y: 1 });
});

test("Send all: one note is today's single note, no notes today's note about all of it", () => {
  expect(outgoing([], "", size)).toBeNull();
  expect(outgoing([], "  Make it darker ", size)).toEqual({ kind: "say", text: "Make it darker" });
  expect(outgoing([note({ x: 120, y: 80, w: 180, h: 80 }, " Bigger ")], "", size)).toEqual({
    kind: "note", text: "Bigger", spot: "the 180×80 px area at x 120–300, y 80–160 of the 720×540 panel (near the top left)",
  });
  // one note without words has nothing to say yet
  expect(outgoing([note({ x: 1, y: 1, w: 0, h: 0 }, " ")], "", size)).toBeNull();
});

test("Send all: several notes go numbered with their spots, plus the words about all of it", () => {
  const notes = [note({ x: 120, y: 80, w: 180, h: 80 }, "Bigger"), note({ x: 360, y: 270, w: 0, h: 0 }, ""), note({ x: 600, y: 500, w: 0, h: 0 }, "Red")];
  expect(outgoing(notes, " Looks good otherwise ", size)).toEqual({
    kind: "notes",
    text: "Looks good otherwise",
    notes: [
      { text: "Bigger", spot: "the 180×80 px area at x 120–300, y 80–160 of the 720×540 panel (near the top left)" },
      { text: MARKUP.noWords, spot: "the point at x 360, y 270 of the 720×540 panel (near the middle)" },
      { text: "Red", spot: "the point at x 600, y 500 of the 720×540 panel (near the bottom right)" },
    ],
  });
  // one note and general words: still numbered, so the agent knows which spot "1" is
  expect(outgoing([notes[0]], "And the title", size)?.kind).toBe("notes");
  // nothing written anywhere: nothing to send
  expect(outgoing([notes[1], notes[1]], "", size)).toBeNull();
  expect(outgoing(Array.from({ length: NOTES_MAX + 5 }, () => notes[0]), "", size)?.notes).toHaveLength(NOTES_MAX);
});

test("drafts: kept per artifact version, read back, gone when empty", () => {
  expect(draftKey("abc", 3)).toBe("shepherdr.markup:abc:v3");
  expect(draftKey("abc", 3)).not.toBe(draftKey("abc", 4));
  expect(draftText([], "")).toBeNull();
  expect(draftText([], "   ")).toBeNull();
  const notes = [note({ x: 120, y: 80, w: 180, h: 80 }, "Bigger"), note({ x: 360, y: 270, w: 0, h: 0 }, "")];
  const kept = draftText(notes, "and more");
  expect(readDraft(kept)).toEqual({ notes, general: "and more" });
  expect(readDraft(draftText([], "only words"))).toEqual({ notes: [], general: "only words" });
});

test("drafts: anything unreadable is an empty draft", () => {
  for (const t of [null, "", "{", "[]", "42", JSON.stringify({ notes: "x" })]) expect(readDraft(t)).toEqual({ notes: [], general: "" });
  const odd = readDraft(JSON.stringify({ notes: [{ x: 2, y: -1, w: 0.1, h: 0.1, text: 5 }, { x: "a" }, null], general: 7 }));
  expect(odd).toEqual({ notes: [{ x: 1, y: 0, w: 0.1, h: 0.1, text: "" }], general: "" });
});

// ---- SHEP-113: what a note on a recipe is on ----
import { recipePath, blockAt, recipeTarget, excerpt, parentKey, keyOrder, keysUnder, noteOn, cleanBlocks, BLOCKS_MAX, sawBox, seenBoxes, layoutMoved, setLayoutRecipe } from "./markup.js";

const recipe = {
  blocks: [
    { type: "heading", text: "Release plan" },
    { type: "text", md: "We ship the **new** card on [Monday](https://x.y).\n\nThen more." },
    { type: "columns", columns: [[{ type: "callout", title: "Heads up" }], [{ type: "list", items: ["One", "Two `x`"] }]] },
    { type: "table", columns: [{ label: "Name" }, "Count", "State"], rows: [["Alpha", 12, "ok"], ["Beta", 9, "late"]] },
    { type: "image", src: "shots/login.png", caption: "Sign-in screen" },
    { type: "tabs", tabs: [{ label: "A", blocks: [{ type: "code", text: "\nnpm test\nmore" }] }] },
    { type: "details", summary: "More", blocks: [{ type: "stats", items: [{ label: "Lines", value: "92%" }] }] },
    { type: "pair", before: { src: "a.png", caption: "Old" }, after: { src: "b.mp4" } },
  ],
};

test("a tag's place is a path into recipe.json", () => {
  expect(recipePath("0")).toBe("blocks[0]");
  expect(recipePath("2.c1.0")).toBe("blocks[2].columns[1][0]");
  expect(recipePath("2.c1.0/items.1")).toBe("blocks[2].columns[1][0].items[1]");
  expect(recipePath("5.t0.0")).toBe("blocks[5].tabs[0].blocks[0]");
  expect(recipePath("6.b.0")).toBe("blocks[6].blocks[0]");
  expect(recipePath("3/rows.1")).toBe("blocks[3].rows[1]");
  expect(recipePath("3/columns")).toBe("blocks[3].columns");
  expect(blockAt(recipe, "2.c1.0")).toBe(recipe.blocks[2].columns[1][0]);
  expect(blockAt(recipe, "6.b.0").type).toBe("stats");
  expect(blockAt(recipe, "9")).toBeNull();
  expect(blockAt(recipe, "0.c0.0")).toBeNull();
  expect(blockAt(null, "0")).toBeNull();
});

test("each tag named from the recipe: kind, path and a short excerpt", () => {
  expect(recipeTarget(recipe, "0")).toEqual({ path: "blocks[0]", kind: "heading", text: "Release plan" });
  expect(recipeTarget(recipe, "1")).toEqual({ path: "blocks[1]", kind: "text", text: "We ship the new card on Monday. Then more." });
  expect(recipeTarget(recipe, "3/rows.1")).toEqual({ path: "blocks[3].rows[1]", kind: "table row 2", text: "Beta | 9 | late" });
  expect(recipeTarget(recipe, "3/columns")).toEqual({ path: "blocks[3].columns", kind: "table header", text: "Name | Count | State" });
  expect(recipeTarget(recipe, "3")).toMatchObject({ kind: "table", text: "Name | Count | State" });
  expect(recipeTarget(recipe, "4")).toEqual({ path: "blocks[4]", kind: "image", text: "Sign-in screen", file: "login.png" });
  expect(recipeTarget(recipe, "2.c1.0/items.1")).toEqual({ path: "blocks[2].columns[1][0].items[1]", kind: "list item 2", text: "Two x" });
  expect(recipeTarget(recipe, "2/columns.0")).toEqual({ path: "blocks[2].columns[0]", kind: "column 1", text: "Heads up" });
  expect(recipeTarget(recipe, "5.t0.0")).toEqual({ path: "blocks[5].tabs[0].blocks[0]", kind: "code", text: "npm test" });
  expect(recipeTarget(recipe, "6.b.0/items.0")).toMatchObject({ kind: "stat 1", text: "Lines: 92%" });
  expect(recipeTarget(recipe, "7/before")).toEqual({ path: "blocks[7].before", kind: "before picture", text: "Old", file: "a.png" });
  expect(recipeTarget(recipe, "7/after")).toEqual({ path: "blocks[7].after", kind: "after clip", text: "After", file: "b.mp4" });
  // a part the recipe doesn't have: the block, at the part's path
  expect(recipeTarget(recipe, "3/rows.9")).toMatchObject({ path: "blocks[3].rows[9]", kind: "table" });
  expect(recipeTarget(recipe, "12")).toBeNull();
  expect(excerpt("x".repeat(100))).toHaveLength(80);
  expect(excerpt("x".repeat(100)).endsWith("…")).toBe(true);
});

test("tags sit in their blocks, in document order", () => {
  expect(parentKey("3/rows.1")).toBe("3");
  expect(parentKey("2.c1.0")).toBe("2");
  expect(parentKey("2.c1.0/items.0")).toBe("2.c1.0");
  expect(parentKey("6.b.0")).toBe("6");
  expect(parentKey("3")).toBeNull();
  expect(["3/rows.1", "10", "2.c1.0", "3", "3/columns", "2"].sort(keyOrder)).toEqual(["2", "2.c1.0", "3", "3/columns", "3/rows.1", "10"]);
});

// a page: the heading, the table (its header and rows), the image, as the renderer lays them out
const page = [
  { key: "0", x: 0, y: 0, w: 600, h: 30 },
  { key: "3", x: 0, y: 40, w: 600, h: 90 },
  { key: "3/columns", x: 0, y: 40, w: 600, h: 30 },
  { key: "3/rows.0", x: 0, y: 70, w: 600, h: 30 },
  { key: "3/rows.1", x: 0, y: 100, w: 600, h: 30 },
  { key: "4", x: 0, y: 140, w: 300, h: 200 },
];

test("a click is on the innermost tag under it", () => {
  expect(keysUnder(page, { x: 100, y: 15, w: 0, h: 0 })).toEqual(["0"]);
  expect(keysUnder(page, { x: 100, y: 110, w: 0, h: 0 })).toEqual(["3/rows.1"]);
  expect(keysUnder(page, { x: 450, y: 200, w: 0, h: 0 })).toEqual([]);
  expect(keysUnder([], { x: 1, y: 1, w: 0, h: 0 })).toEqual([]);
});

test("a drag is on what it covers whole, else the parts it touches", () => {
  // over the whole table: the table, not its rows
  expect(keysUnder(page, { x: 0, y: 38, w: 600, h: 94 })).toEqual(["3"]);
  // over its second row and into the picture
  expect(keysUnder(page, { x: 10, y: 105, w: 100, h: 60 })).toEqual(["3/rows.1", "4"]);
  // over everything
  expect(keysUnder(page, { x: 0, y: 0, w: 600, h: 400 })).toEqual(["0", "3", "4"]);
  // a nested block whose column has no box of its own
  const nested = [{ key: "2", x: 0, y: 0, w: 600, h: 100 }, { key: "2.c1.0", x: 300, y: 0, w: 300, h: 100 }, { key: "2.c1.0/items.1", x: 300, y: 50, w: 300, h: 20 }];
  expect(keysUnder(nested, { x: 310, y: 52, w: 20, h: 10 })).toEqual(["2.c1.0/items.1"]);
});

test("a note's blocks: at most BLOCKS_MAX named, the rest counted; nothing off the recipe", () => {
  expect(noteOn(recipe, page, { x: 100, y: 110, w: 0, h: 0 })).toEqual({ blocks: [{ path: "blocks[3].rows[1]", kind: "table row 2", text: "Beta | 9 | late" }], more: 0 });
  const many = Array.from({ length: 8 }, (_, i) => ({ key: String(i), x: 0, y: i * 10, w: 100, h: 10 }));
  const on = noteOn(recipe, many, { x: 0, y: 0, w: 100, h: 80 });
  expect(on.blocks).toHaveLength(BLOCKS_MAX);
  expect(on.more).toBe(3);
  expect(noteOn(null, page, { x: 1, y: 1, w: 0, h: 0 })).toBeNull();
  expect(noteOn(recipe, page, { x: 450, y: 200, w: 0, h: 0 })).toBeNull();
  expect(cleanBlocks([{ path: "blocks[0]", kind: "heading", text: "x".repeat(500) }, { path: 1 }, null])).toEqual([{ path: "blocks[0]", kind: "heading", text: "x".repeat(120) }]);
});

test("Send all and drafts carry what each note is on", () => {
  const on = { blocks: [{ path: "blocks[0]", kind: "heading", text: "Release plan" }], more: 0 };
  const n = { ...note({ x: 360, y: 20, w: 0, h: 0 }, "Shorter"), on };
  expect(outgoing([n], "", size)).toEqual({ kind: "note", text: "Shorter", spot: "the point at x 360, y 20 of the 720×540 panel (near the top center)", blocks: on.blocks });
  const two = outgoing([n, { ...note({ x: 1, y: 1, w: 0, h: 0 }, "x"), on: { ...on, more: 2 } }], "", size);
  expect(two.notes.map((x) => [x.blocks, x.more])).toEqual([[on.blocks, undefined], [on.blocks, 2]]);
  expect(readDraft(draftText([n], ""))).toEqual({ notes: [n], general: "" });
  // a draft from before keeps working; junk blocks are dropped
  expect(readDraft(JSON.stringify({ notes: [{ x: 0, y: 0, w: 0, h: 0, text: "a", on: { blocks: "x" } }] })).notes[0]).toEqual({ x: 0, y: 0, w: 0, h: 0, text: "a" });
});

test("the window's boxes: kept as the pointer crosses them, gone after a scroll", () => {
  setLayoutRecipe("panel", recipe);
  sawBox("panel", "3", { x: 100, y: 140, width: 600, height: 90 }, { x: 150, y: 210 });
  sawBox("panel", "3/rows.1", { x: 100, y: 200, width: 600, height: 30 }, { x: 150, y: 210 });
  // the layer's top left is at (100, 100) in the window
  const click = seenBoxes("panel", { x: 100, y: 100 }, true);
  expect(click.recipe).toBe(recipe);
  expect(noteOn(click.recipe, click.nodes, { x: 50, y: 110, w: 0, h: 0 })?.blocks.map((b) => b.kind)).toEqual(["table row 2"]);
  // a later move over the heading only: a click there sees only the heading; a drag still sees every box
  sawBox("panel", "0", { x: 100, y: 100, width: 600, height: 30 }, { x: 150, y: 110 });
  expect(seenBoxes("panel", { x: 100, y: 100 }, true).nodes.map((n) => n.key)).toEqual(["0"]);
  expect(seenBoxes("panel", { x: 100, y: 100 }, false).nodes.map((n) => n.key).sort()).toEqual(["0", "3", "3/rows.1"]);
  expect(seenBoxes("viewer", { x: 0, y: 0 }, false)).toEqual({ recipe: null, nodes: [] });
  layoutMoved("panel");
  expect(seenBoxes("panel", { x: 100, y: 100 }, false).nodes).toEqual([]);
  sawBox("panel", "x", undefined, { x: 1, y: 1 });
  expect(seenBoxes("panel", { x: 0, y: 0 }, false).nodes).toEqual([]);
});

// ---- SHEP-114: notes on selected words and on pictures ----
import { quoteOf, cleanQuote, cleanPicture, describeInPicture, pictureSpot, pictureUnder, pictureAt, QUOTE_MAX, CONTEXT_MAX } from "./markup.js";

test("selected words become a quote with a little of the block's text on each side", () => {
  expect(quoteOf("ship on  Friday", "The plan is that we ", " after the review.")).toEqual({ text: "ship on Friday", before: "The plan is that we ", after: " after the review." });
  expect(quoteOf("   ", "a", "b")).toBeNull();
  // a long block: the context is cut at a word, with an ellipsis
  const long = "word ".repeat(60);
  const q = quoteOf("this", long, ` ${long}`);
  expect(q.before.startsWith("…")).toBe(true);
  expect(q.before.length).toBeLessThanOrEqual(CONTEXT_MAX + 2);
  expect(q.before.endsWith("word ")).toBe(true);
  expect(q.after.endsWith("word…")).toBe(true);
  expect(quoteOf("x".repeat(QUOTE_MAX + 50)).text).toHaveLength(QUOTE_MAX);
  expect(cleanQuote({ text: "" })).toBeNull();
});

test("a spot in a picture is described in the picture's own px, or in percent when its size isn't known", () => {
  const pic = { file: "login.png", width: 1280, height: 800 };
  expect(describeInPicture({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, pic)).toBe("the 640×400 px area at x 640–1280, y 0–400 (the top right quarter)");
  expect(describeInPicture({ x: 0.7, y: 0.15, w: 0, h: 0 }, pic)).toBe("the point at x 896, y 120 (near the top right)");
  expect(describeInPicture({ x: 0, y: 0.6, w: 1, h: 0.3 }, pic)).toBe("the 1280×240 px area at x 0–1280, y 480–720 (the bottom half)");
  expect(describeInPicture({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 }, { file: "a.png" })).toBe("the area from 30% to 70% across, 30% to 70% down (the middle)");
  expect(pictureSpot(pic, describeInPicture({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, pic))).toBe("the 640×400 px area at x 640–1280, y 0–400 (the top right quarter) of picture “login.png” (1280×800)");
  expect(pictureSpot({ file: "a.png" })).toBe("picture “a.png”");
});

test("a click or a drag on a picture in Mark up finds it, the spot clipped to it", () => {
  const pics = [{ x: 100, y: 200, w: 400, h: 250, file: "login.png", path: "blocks[3]", caption: "Sign-in", width: 1280, height: 800 }];
  expect(pictureUnder(pics, { x: 400, y: 225, w: 0, h: 0 })).toEqual({ picture: { file: "login.png", path: "blocks[3]", caption: "Sign-in", width: 1280, height: 800 }, spot: { x: 0.75, y: 0.1, w: 0, h: 0 } });
  // a drag mostly inside: clipped to the picture
  expect(pictureUnder(pics, { x: 300, y: 190, w: 220, h: 135 })?.spot).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
  // a drag mostly outside, or a click beside it: none
  expect(pictureUnder(pics, { x: 0, y: 0, w: 600, h: 600 })).toBeNull();
  expect(pictureUnder(pics, { x: 50, y: 50, w: 0, h: 0 })).toBeNull();
  expect(cleanPicture({ file: "", width: 3 })).toBeNull();
  expect(cleanPicture({ file: "a.png", width: 10, height: -1, alt: " x " })).toEqual({ file: "a.png", alt: "x" });
});

test("a picture's details come from the recipe: an image block or a pair's side", () => {
  const r = { blocks: [{ type: "text", md: "x" }, { type: "image", src: "shots/login.png", caption: "Sign-in", w: 1280, h: 800 }, { type: "pair", before: { src: "a.png" }, after: { src: "b.mp4" } }] };
  expect(pictureAt(r, "1")).toEqual({ file: "login.png", path: "blocks[1]", caption: "Sign-in", width: 1280, height: 800 });
  expect(pictureAt(r, "2/before")).toEqual({ file: "a.png", path: "blocks[2].before" });
  expect(pictureAt(r, "2/after")).toBeNull();
  expect(pictureAt(r, "0")).toBeNull();
});

test("Send all: a quote goes with its block and no px spot; a picture by its name, its spot in it", () => {
  const on = { blocks: [{ path: "blocks[1]", kind: "text", text: "The plan is that we ship on Friday" }], more: 0 };
  const quoted = { ...note({ x: 100, y: 100, w: 120, h: 20 }, "Say Monday"), on, quote: { text: "ship on Friday", before: "The plan is that we ", after: " after the review.", rects: [{ x: 0.1, y: 0.2, w: 0.2, h: 0.04 }] } };
  const pic = { ...note({ x: 360, y: 300, w: 180, h: 100 }, "Too dark"), picture: { file: "login.png", path: "blocks[3]", caption: "Sign-in", width: 1280, height: 800, spot: { x: 0.5, y: 0, w: 0.5, h: 0.5 } } };
  const whole = { ...note({ x: 0, y: 200, w: 400, h: 250 }, "Crop it"), picture: { file: "login.png", path: "blocks[3]" } };
  expect(outgoing([quoted], "", size)).toEqual({ kind: "note", text: "Say Monday", spot: "", blocks: on.blocks, quote: { text: "ship on Friday", before: "The plan is that we ", after: " after the review." } });
  const all = outgoing([quoted, pic, whole], "Thanks", size);
  expect(all.notes[1]).toEqual({
    text: "Too dark",
    spot: "the 640×400 px area at x 640–1280, y 0–400 (the top right quarter) of picture “login.png” (1280×800)",
    picture: { file: "login.png", path: "blocks[3]", caption: "Sign-in", width: 1280, height: 800, spot: "the 640×400 px area at x 640–1280, y 0–400 (the top right quarter)" },
  });
  expect(all.notes[2]).toEqual({ text: "Crop it", spot: "picture “login.png”", picture: { file: "login.png", path: "blocks[3]" } });
  // drafts keep both kinds, the quote's highlight boxes too
  expect(readDraft(draftText([quoted, pic, whole], "")).notes).toEqual([quoted, pic, whole]);
});
