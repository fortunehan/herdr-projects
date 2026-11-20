// Mark up's Send all from the web (SHEP-88): the service hands numbered notes to herdr-artifact as one message, and
// a single note still goes the way it always did.
import { expect, test } from "bun:test";
import { act } from "./actions.ts";
import { NOTES_MAX } from "../core/markup.js";

function stub() {
  const calls: unknown[][] = [];
  const artifacts = {
    say: async (...a: unknown[]) => { calls.push(["say", ...a]); return { to: "t1" }; },
    notes: async (...a: unknown[]) => { calls.push(["notes", ...a]); return { to: "t1", notes: 2 }; },
  };
  return { calls, compat: { artifacts } as never };
}

test("Send all hands every note, its spot and the general words to herdr-artifact as one message", async () => {
  const { calls, compat } = stub();
  const r = await act({} as never, {
    type: "artifact-note", place: "p", artifact: "abc", v: 3, text: " Otherwise fine ",
    notes: [{ note: " Bigger ", target: "the point at x 1, y 2" }, { note: "Red", target: "the 10×10 px area at x 0–10, y 0–10" }],
  }, compat);
  expect(r).toEqual({ to: "t1", notes: 2 });
  expect(calls).toEqual([["notes", "abc", 3, [{ text: "Bigger", spot: "the point at x 1, y 2" }, { text: "Red", spot: "the 10×10 px area at x 0–10, y 0–10" }], "Otherwise fine"]]);
});

test("a single note and a note about all of it go as before", async () => {
  const { calls, compat } = stub();
  await act({} as never, { type: "artifact-note", place: "p", artifact: "abc", v: 2, note: "Bigger", target: "the point at x 1, y 2" }, compat);
  await act({} as never, { type: "artifact-say", place: "p", artifact: "abc", v: 2, text: "Darker" }, compat);
  expect(calls).toEqual([["say", "abc", 2, "Bigger", "the point at x 1, y 2", undefined], ["say", "abc", 2, "Darker", undefined, undefined]]);
});

test("Send all refuses nothing to say, and too many notes", async () => {
  const { calls, compat } = stub();
  await expect(act({} as never, { type: "artifact-note", place: "p", artifact: "abc", v: 1, notes: [{ note: " ", target: "x" }] }, compat)).rejects.toThrow("Nothing to send.");
  await expect(act({} as never, { type: "artifact-note", place: "p", artifact: "abc", v: 1, notes: [] }, compat)).rejects.toThrow();
  const many = Array.from({ length: NOTES_MAX + 1 }, () => ({ note: "x", target: "y" }));
  await expect(act({} as never, { type: "artifact-note", place: "p", artifact: "abc", v: 1, notes: many }, compat)).rejects.toThrow();
  expect(calls).toEqual([]);
});
