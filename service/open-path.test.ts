// SHEP-99: a path clicked in an agent's reply on the web app opens on that agent's machine (core/chat-links.js's
// opener, with its guard: the home folder and /tmp only), and says why in plain words when it can't.
import { expect, test } from "bun:test";
import { act } from "./actions.ts";

function stub(code = 0) {
  const calls: { argv: string[]; on?: string }[] = [];
  const hub = { call: async (_m: string, p: any) => { calls.push(p); return { code, stdout: "", stderr: "" }; } };
  const compat = { addrOf: (k: string) => ({ "p:mini:shop": "mini/t1a", "p:shop": "t2b" } as Record<string, string>)[k] ?? null };
  return { calls, hub: hub as never, compat: compat as never };
}

test("a page opens in the browser on the agent's machine, with the guard on", async () => {
  const { calls, hub, compat } = stub();
  expect(await act(hub, { type: "open-path", chat: "p:mini:shop", path: "~/site/index.html" }, compat)).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].on).toBe("mini");
  expect(calls[0].argv.slice(0, 2)).toEqual(["sh", "-c"]);
  expect(calls[0].argv.slice(3)).toEqual(["open-path", "browser", "~/site/index.html", "guard"]);
});

test("a source file is shown in Finder on this machine's agent", async () => {
  const { calls, hub, compat } = stub();
  await act(hub, { type: "open-path", chat: "p:shop", path: "/Users/me/a.ts" }, compat);
  expect(calls[0].on).toBeUndefined();
  expect(calls[0].argv.slice(3)).toEqual(["open-path", "reveal", "/Users/me/a.ts", "guard"]);
});

test("missing and refused paths come back as words for a toast", async () => {
  expect(await act(stub(3).hub, { type: "open-path", chat: "p:shop", path: "/tmp/gone.html" }, stub().compat))
    .toEqual({ ok: false, title: "Couldn't open it in the browser", error: "/tmp/gone.html isn't there." });
  expect(await act(stub(5).hub, { type: "open-path", chat: "p:shop", path: "/etc/hosts" }, stub().compat))
    .toMatchObject({ ok: false, error: "Only paths in your home folder or /tmp open from here." });
});

test("only a path, for a chat that's here", async () => {
  const { calls, hub, compat } = stub();
  for (const path of ["relative/a", "-rf", "/tmp/a\nb", 42, "x".repeat(5000)])
    await expect(act(hub, { type: "open-path", chat: "p:shop", path }, compat)).rejects.toThrow("That isn't a path.");
  await expect(act(hub, { type: "open-path", chat: "p:gone", path: "/tmp/a" }, compat)).rejects.toThrow("That chat isn't here any more.");
  expect(calls).toEqual([]);
});
