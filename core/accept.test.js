import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPT, acceptLabel, words, readable, whereNow, commitsLine, filesLine, moreLine, proofTitle, canAccept } from "./accept.js";

const root = join(import.meta.dir, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("Accept uses the computed status, not the worker's saved ready state", () => {
  for (const status of ["working", "needs", "merging", "done"]) expect(canAccept({ state: "ready", status })).toBe(false);
  expect(canAccept({ state: "ready", status: "ready" })).toBe(true);
  expect(canAccept({ state: "done", status: "ready" })).toBe(false);
  expect(canAccept(null)).toBe(false);
  expect(canAccept({ state: "ready" })).toBe(false);
  expect(canAccept({ state: "ready", status: "needs", needs: "attention", attention: "Auto-complete was turned off in Azure DevOps" })).toBe(true);
  for (const file of ["mods/accept-card/main.js", "web/src/screens/Accept.tsx"]) expect(read(file)).toContain("canAccept(");
});

test("a long old summary keeps its first sentence; the whole goes under Details", () => {
  const long = `Fixed the login. ${"More words here. ".repeat(12)}`;
  const w = words({ summary: long });
  expect(w.summary).toBe("Fixed the login. More words here. More words here. More words here. More words here. More words here. More words here. More words here. More words here.");
  expect(w.details).toBe(long.trim());
  expect(words({ summary: "Short.", details: "x" })).toEqual({ summary: "Short.", details: "x" });
});

test("plain details become bullets, clear paths as code; markdown stays", () => {
  expect(readable("Changed web/src/App.tsx. The tests pass now; all good")).toBe("- Changed `web/src/App.tsx`\n- The tests pass now; all good");
  expect(readable("- one\n- two")).toBe("- one\n- two");
});

test("the card's words", () => {
  expect(ACCEPT.title("HERD-4")).toBe("Accept HERD-4?");
  expect(whereNow({ state: "done", accepted_at: 1 })).toBe("Already accepted.");
  expect(whereNow({ state: "done" })).toBe("Already done.");
  expect(whereNow({ state: "work", status_text: "Working" })).toBe("Not ready right now: it's in Working.");
  expect([commitsLine(1), filesLine(3), moreLine(2)]).toEqual(["1 commit", "3 files changed", "And 2 more"]);
  expect(proofTitle("HERD-4: Login works")).toBe("Login works");
});

// SHEP-225 (#1046): the button says what pressing it does
test("Accept says whether it merges", () => {
  expect(acceptLabel({ merges: true })).toBe("Accept and merge");
  expect(acceptLabel({ merges: false })).toBe("Accept");
  expect(acceptLabel(undefined)).toBe("Accept"); // still being read
  const mod = read("mods/accept-card/main.js"), web = read("web/src/screens/Accept.tsx");
  expect(mod).toContain("acceptLabel(e)");
  expect(web).toContain("A.acceptLabel(e)");
});

test("the window's card and the web's read their words from here, not their own", () => {
  const mod = read("mods/accept-card/main.js"), web = read("web/src/screens/Accept.tsx");
  expect(mod).toContain('from "./core/accept.js"');
  expect(web).toContain("@core/accept.js");
  for (const w of ["Reading the task", "No summary.", "No proof artifact.", "Already accepted.", "Not ready right now"]) {
    expect(mod).not.toContain(w);
    expect(web).not.toContain(w);
  }
});

// SHEP-87: Send back's words, and the choices answered in the proof listed under Details
import { ACCEPT as WORDS, choiceLine, detailsText } from "./accept.js";

test("Send back has its own words beside Accept", () => {
  expect(WORDS.sendBack).toBe("Send back…");
  expect(WORDS.sendBackGo).toBe("Send back");
  expect(WORDS.sendBackAsk).toBe("What should change?");
});

test("Details lists the answered choices first, then the agent's own details", () => {
  const choices = [{ question: "Ship it?", value: "Ship", at: 1, v: 1 }, { question: "Owner", value: "Name: Ann", at: 2, v: 2 }];
  expect(choiceLine(choices[0])).toBe("Ship it? Ship");
  expect(choiceLine(choices[1])).toBe("Owner: Name: Ann");
  expect(detailsText({ choices }, "")).toBe("**Your choices**\n- Ship it? Ship\n- Owner: Name: Ann");
  expect(detailsText({ choices }, "- Tests pass")).toBe("**Your choices**\n- Ship it? Ship\n- Owner: Name: Ann\n\n- Tests pass");
  expect(detailsText({}, "- Tests pass")).toBe("- Tests pass");
  expect(detailsText({ choices: [] }, "")).toBe("");
});
