import { describe, expect, test } from "bun:test";
import { composeTarget } from "./chat-focus.js";

describe("Cmd+Shift+L: which chat's box gets the keyboard (SHEP-15)", () => {
  test("the chat last used, while it is on screen", () => {
    expect(composeTarget({ holder: "p2", focused: "t1", shown: ["p1", "p2"], assistant: "p1" })).toBe("p2");
    expect(composeTarget({ holder: "thread", focused: "p1", shown: ["p1"], thread: true, assistant: "p1" })).toBe("thread");
  });

  test("not on screen any more: the focused chat, then the Assistant's, then any chat in the tab", () => {
    expect(composeTarget({ holder: "thread", focused: "p2", shown: ["p1", "p2"], thread: false, assistant: "p1" })).toBe("p2");
    expect(composeTarget({ holder: "tasks", focused: "t1", shown: ["p2", "p1"], assistant: "p1" })).toBe("p1");
    expect(composeTarget({ holder: "p9", focused: "t1", shown: ["p2"], assistant: "a1" })).toBe("p2");
  });

  test("no chat in the tab: a task's chat open in the Tasks panel, else the space's Assistant wherever it is", () => {
    expect(composeTarget({ holder: "artifacts", focused: "t1", shown: [], thread: true, assistant: "a1" })).toBe("thread");
    expect(composeTarget({ holder: null, focused: "t1", shown: [], assistant: "a1" })).toBe("a1");
  });

  test("a space without an Assistant gets one; no space, nothing", () => {
    expect(composeTarget({ focused: "t1", shown: [] })).toBe("new");
    expect(composeTarget({ shown: [], space: false })).toBe(null);
  });
});
