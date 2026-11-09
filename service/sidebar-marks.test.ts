// SHEP-17: a space's row in the web's sidebar shows its Assistant thinking and its tasks at work, as the window's: the
// service works both out with the shared core (core/spaces.js) and the snapshot carries them on each place.
import { expect, test } from "bun:test";
import { Compat } from "./compat.ts";

const space = (id: string, extra: Record<string, unknown> = {}) => ({ id, machine: null, name: id, folder: `/srv/${id}`, tabs: [], at: 0, assistant: null, turn: 0, assistantStatus: null, ...extra });

test("a place says its Assistant thinks and how many of its tasks work, and nothing when neither", () => {
  const compat = new Compat() as any;
  const snap = compat.snapshot({ host: "mac", user: "u", machines: [{ name: "mac", here: true, state: "connected" }], sections: [], rows: [],
    spaces: [space("a", { assistantStatus: "working", thinking: true, working: 2 }), space("b")] });
  const [a, b] = snap.places;
  expect([a.thinking, a.working]).toEqual([true, 2]);
  expect("thinking" in b || "working" in b).toBe(false);
});
