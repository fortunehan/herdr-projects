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
