// SHEP-34: what the web app gets of Azure DevOps' Waiting to merge: its own status, Review on a Needs you row its Accept
// fixes, and a failed pull's card beside its Done task (which stays Done), counted as every Needs you.
import { expect, test } from "bun:test";
import { Compat } from "./compat.ts";

const row = (id: number, section: string, extra: Record<string, unknown> = {}) => ({
  key: `:/r#${id}`, ref: `MD-${id}`, title: `Task ${id}`, section, needs: null, sub: null, machine: null, folder: "/r", slug: "r", id, list: "r",
  space: "sp1", worker: null, archived: false, pinned: false, agents: [], logs: [], ...extra,
});

test("waiting to merge, accept again and a failed pull's card", () => {
  const snap = new Compat().snapshot({
    host: "mac", user: "me", machines: [{ name: "mac", here: true, state: "connected" }], sections: [],
    spaces: [{ id: "sp1", name: "r", machine: null, folder: "/r", tabs: [], assistant: null }],
    rows: [
      row(2, "merging", { sub: "Waiting on reviewers in Azure DevOps" }),
      row(5, "needs", { needs: "attention", sub: "Auto-complete was turned off in Azure DevOps", acceptAgain: true }),
      row(1, "done", { done_at: Date.now(), pull: { text: "The main checkout couldn't pull develop: Not possible to fast-forward, aborting.", command: "git -C /r pull --ff-only origin develop" } }),
    ],
  });
  const by = new Map(snap.tasks.map((t) => [t.id, t]));
  expect(by.get("MD-2")).toMatchObject({ status: "merging", sub: "Waiting on reviewers in Azure DevOps" });
  expect(by.get("MD-5")).toMatchObject({ status: "need", acceptAgain: true });
  expect(by.get("MD-2")?.acceptAgain).toBeUndefined();
  expect(by.get("MD-1")?.status).toBe("done");
  expect(by.get("MD-1#pull")).toMatchObject({ status: "need", pullOf: "MD-1", pullCommand: "git -C /r pull --ff-only origin develop",
    sub: "The main checkout couldn't pull develop: Not possible to fast-forward, aborting." });
  expect(snap.needs.map((n) => n.task)).toEqual(["MD-5", "MD-1#pull"]);
});
