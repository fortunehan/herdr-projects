import { expect, test } from "bun:test";
import { artifactOf, artifactStore } from "./compat.ts";
import { plainError } from "./artifacts.ts";

test("a space's artifact store is herdr-artifact's: the repo's main folder, named as the window's Artifacts header", () => {
  expect(artifactStore({ folder: "/h/u" }, "/h/u")).toEqual({ folder: "/h/u", key: "|/h/u", name: "~" });
  expect(artifactStore({ folder: "/h/u/wt/x", git: { repo: "/h/u/dev/app/.git" } }, "/h/u")).toEqual({ folder: "/h/u/dev/app", key: "|/h/u/dev/app", name: "app" });
  // another machine's home reads "~" there too; its key names the machine
  expect(artifactStore({ folder: "/root", machine: "vm" }, "/h/u")).toEqual({ folder: "/root", key: "vm|/root", name: "~" });
  expect(artifactStore({ folder: "/root/dev/site", machine: "vm" }, "/h/u").name).toBe("site");
});

test("each version says its kind and its window picture: a converted one was a panel, then a recipe", () => {
  const a = artifactOf({ id: "x-1a2b", title: "Plan", version: 2, at: 2, folder: "/h/u", files: ["recipe.json"],
    versions: [{ v: 1, at: 1, kind: "custom", picture: 5 }, { v: 2, at: 2, kind: "recipe" }] }, []);
  expect(a.kind).toBe("recipe");
  expect(a.versions.map((x) => [x.n, x.kind, x.picture])).toEqual([[2, "recipe", undefined], [1, "gpui", 5]]);
});

// SHEP-87: the person's answers kept with a version (answers.json), read where the artifact lives
import { Artifacts } from "./artifacts.ts";

test("answers: another machine's are read there, beside the version; none, unreadable or a bad id is {}", async () => {
  const a = new Artifacts();
  const calls: any[] = [];
  let out = JSON.stringify({ ship: { value: "Ship", at: 5, by: "web" } });
  a.hub = { call: async (_m: string, p: any) => { calls.push(p); return { code: 0, stdout: Buffer.from(out).toString("base64"), stderr: "" }; } } as any;
  expect(await a.answers("plan-1a2b", 2, "vm")).toEqual({ ship: { value: "Ship", at: 5, by: "web" } });
  expect(calls[0].on).toBe("vm");
  expect(calls[0].argv.slice(-3)).toEqual(["answers", "plan-1a2b", "2"]);
  expect(calls[0].argv.join(" ")).toContain('/files/$1/v$2/answers.json');
  out = "";
  expect(await a.answers("plan-1a2b", 2, "vm")).toEqual({});
  out = "[1,2]";
  expect(await a.answers("plan-1a2b", 2, "vm")).toEqual({});
  expect(await a.answers("../x", 2, "vm")).toEqual({});
  expect(await a.answers("plan-1a2b", 0, "vm")).toEqual({});
  expect(await a.answers("plan-1a2b", 2, "bad machine")).toEqual({});
  expect(calls.length).toBe(3);
  // this machine's: none kept for an artifact it doesn't have
  expect(await a.answers("no-such-artifact-shep87", 1)).toEqual({});
});

test("a note's error is plain words, never JSON in JSON (#1213)", () => {
  const hc = JSON.stringify({ error: { hint: "typing would answer its dialog", kind: "blocked", message: "t7 is blocked (question)" } });
  expect(plainError(JSON.stringify({ error: hc }))).toBe("t7 is blocked (question)");
  expect(plainError(JSON.stringify({ error: "The agent that made this artifact has ended." }))).toBe("The agent that made this artifact has ended.");
  expect(plainError("")).toBe("");
});
