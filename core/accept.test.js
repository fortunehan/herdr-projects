import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPT, acceptLabel, busyLabel, cardTitle, hasChanges, hasChecks, words, readable, whereNow, commitsLine, filesLine, moreLine, proofTitle, canAccept } from "./accept.js";
import { nothingToMerge } from "./tasks.js";

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
  expect(acceptLabel(undefined)).toBe("Accept"); // still being read, no row to go by
  const mod = read("mods/accept-card/main.js"), web = read("web/src/screens/Accept.tsx");
  expect(mod).toContain("acceptLabel(e, props()?.markDone)");
  expect(web).toContain("A.acceptLabel(e, hint)");
});

// SHEP-95: a task with nothing to merge (research or a design done in the folder itself) is marked done, never merged
test("nothing to merge: Mark done, never a word about merging", () => {
  const here = { id: 1, state: "ready", mode: "here" };
  const research = { id: 2, state: "ready", mode: "worktree", branch: "task/2", nothing_to_merge: true };
  const code = { id: 3, state: "ready", mode: "worktree", branch: "task/3", pr: { number: 9 } };
  expect([nothingToMerge(here), nothingToMerge(research), nothingToMerge(code), nothingToMerge({ mode: "here", pr: { number: 1 } })])
    .toEqual([true, true, false, false]);
  // its evidence decides once read
  expect(acceptLabel({ merges: false })).toBe("Mark done");
  expect(acceptLabel({ merges: true }, here)).toBe("Accept and merge");
  expect(cardTitle("SHEP-86", { merges: false })).toBe("Mark SHEP-86 done?");
  expect(cardTitle("SHEP-86", { merges: true })).toBe("Accept SHEP-86?");
  expect(busyLabel({ merges: false })).toBe("Marking done…");
  expect(busyLabel({ merges: true })).toBe("Accepting…");
  // while it is read: its row (the web's snapshot hint, a boolean, or the window's task record)
  expect([acceptLabel({}, true), acceptLabel({}, false), acceptLabel(undefined, here), acceptLabel(undefined, code)])
    .toEqual(["Mark done", "Accept", "Mark done", "Accept"]);
  expect(cardTitle("SHEP-86", undefined, here)).toBe("Mark SHEP-86 done?");
  for (const w of [ACCEPT.markDone, ACCEPT.marking, ACCEPT.markTitle("X-1")]) expect(w.toLowerCase()).not.toContain("merg");
  // what such a card still shows under its lead
  expect([hasChanges({ git: true, commits: { count: 0 }, diff: { files: 0 } }), hasChanges({ git: true, commits: { count: 2 } }), hasChanges({ git: false })])
    .toEqual([false, true, false]);
  expect([hasChecks({ checks: { state: "none" } }), hasChecks({ checks: { state: "passed" } }), hasChecks({})]).toEqual([false, true, false]);
});

test("both cards lead a nothing-to-merge task with what it made, and its rows tell the card before it is read", () => {
  const mod = read("mods/accept-card/main.js"), web = read("web/src/screens/Accept.tsx");
  expect(mod).toContain("markDone(e, p.markDone)");
  expect(mod).toContain(".when(done, made)");
  expect(web).toContain("{done ? made : null}");
  expect(web).toContain("A.cardTitle(ref, e, hint)");
  expect(read("mods/tasks/main.js")).toContain("markDone: nothingToMerge(p.task)");
  expect(read("mods/chat/panel.js")).toContain("markDone: nothingToMerge(r)");
  expect(read("service/model.ts")).toContain("markDone: nothingToMerge(task)");
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

test("Details lists the agent's own details, then the answered choices under their label", () => {
  const choices = [{ question: "Ship it?", value: "Ship", at: 1, v: 1 }, { question: "Owner", value: "Name: Ann", at: 2, v: 2 }];
  expect(choiceLine(choices[0])).toBe("Ship it? Ship");
  expect(choiceLine(choices[1])).toBe("Owner: Name: Ann");
  expect(detailsText({ choices }, "")).toBe("**Your choices**\n\n- Ship it? Ship\n- Owner: Name: Ann");
  expect(detailsText({ choices }, "- Tests pass")).toBe("- Tests pass\n\n**Your choices**\n\n- Ship it? Ship\n- Owner: Name: Ann");
  expect(detailsText({}, "- Tests pass")).toBe("- Tests pass");
  expect(detailsText({ choices: [] }, "")).toBe("");
});

// SHEP-89: the card leads with ready's plain-words explanation and What to check; technical details fold below
import { simple, paragraphs } from "./accept.js";

test("the simple explanation and what to check, read from the evidence; none on an older ready", () => {
  expect(simple({ explain: "  卡片先讲人话。\n就像先看封面。 ", to_check: [" 打开卡片 ", "", null, "看看  手机"] }))
    .toEqual({ explain: "卡片先讲人话。\n就像先看封面。", toCheck: ["打开卡片", "看看 手机"] });
  expect(simple({ summary: "Old", details: "- x" })).toEqual({ explain: "", toCheck: [] });
  expect(simple(undefined)).toEqual({ explain: "", toCheck: [] });
  expect(simple({ to_check: "not a list" })).toEqual({ explain: "", toCheck: [] });
  expect(paragraphs("One.\n\nTwo.\n")).toEqual(["One.", "Two."]);
  expect(paragraphs("")).toEqual([]);
});

test("plain labels: What to check, then Technical details folded", () => {
  expect(WORDS.toCheck).toBe("What to check");
  expect(WORDS.details).toBe("Technical details");
  const mod = read("mods/accept-card/main.js"), web = read("web/src/screens/Accept.tsx");
  expect(mod).toContain("simple(e)");
  expect(web).toContain("A.simple(e)");
  // the lead comes before the proof and the technical sections in both cards
  const order = (src, marks) => marks.map((m) => src.indexOf(m));
  const inMod = order(mod, ["this.lead(t, w, e)", "ACCEPT.proof, this.proof", "ACCEPT.changes, this.changes", "this.detailsSection(t"]);
  expect(inMod.every((x) => x > 0)).toBe(true);
  expect([...inMod].sort((a, b) => a - b)).toEqual(inMod);
  for (const w of ["What to check", "Technical details"]) {
    for (const q of ['"', "'", ">"]) {
      expect(mod).not.toContain(q + w);
      expect(web).not.toContain(q + w);
    }
  }
});
