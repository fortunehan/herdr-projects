import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compat } from "./compat.ts";
import * as CL from "../core/chat-log.js";
import { ChatReader } from "../core/chat-reader.js";
import { partsOf, settle, type Outgoing } from "../web/src/outbox.ts";

const { LOG } = CL as any;
const fixture = readFileSync(new URL("../test/fixtures/codex-approval-chat.jsonl", import.meta.url), "utf8").trim().split("\n").map((s) => JSON.parse(s));
const texts = ["SHEP-40 已经完成了，SHEP-39还需要吗", "codex为什么执行git fetch，rebase指令还ask？"];
const at = Date.parse(fixture[0].timestamp);
const sent = (i: number, more: Partial<Outgoing> = {}): Outgoing => ({ cid: `screen-${i}`, chat: "scratch", text: texts[i], files: [],
  at: Date.parse(fixture[i].timestamp), serverAt: Date.parse(fixture[i].timestamp), state: "sent", prior: [], ...more });

async function replay(lines: unknown[], check: (reader: any, f: string, io: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "approval-echo-"));
  const f = join(dir, "rollout.jsonl");
  const io = { sh: async (script: string, args: string[]) => {
    expect(script).toBe(LOG);
    const p = Bun.spawn(["sh", "-c", script, ...args], { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(p.stdout).text();
    return { code: await p.exited, stdout };
  } };
  try {
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const reader = new ChatReader(io, "scratch").fixed(f, "codex");
    await reader.pull();
    await check(reader, f, io);
  } finally { rmSync(dir, { recursive: true }); }
}

function screen(reader: any, sends: Outgoing[] = []) {
  const c = new Compat() as any;
  c.firstTask = () => null;
  c.chats.set("scratch", "t-scratch");
  c.sends.set("t-scratch", sends.map((s) => ({ cid: s.cid, text: s.text, files: s.files.map((f) => f.path), at: s.serverAt })));
  return c.chat("scratch", reader, {});
}

test("captured approval replies carry the screen cid and settle only matching pending messages", async () => {
  await replay(fixture, async (reader) => {
    const out = [sent(0), sent(1), sent(0, { cid: "unrelated", text: "not delivered" })];
    const chat = screen(reader, out);
    expect(chat.messages.filter((m: any) => m.who === "you").map((m: any) => m.cid)).toEqual(["screen-0", "screen-1"]);
    const pending = settle(out, chat, at + 80000);
    expect(pending.map((o) => o.cid)).toEqual(["unrelated"]);
    expect(partsOf(out[0], chat)).toEqual([]);
    expect(out.length).toBe(3);
  });
});

test("after a service restart the same log acknowledges a restored outbox without server send history", async () => {
  await replay(fixture, async (reader, f, io) => {
    const out = JSON.parse(JSON.stringify([sent(0), sent(1)]));
    const before = screen(reader);
    expect(settle(out, before, at + 80000)).toEqual([]);
    const restarted = new ChatReader(io, "scratch").fixed(f, "codex");
    await restarted.pull();
    const after = screen(restarted);
    expect(after.messages).toEqual(before.messages);
    expect(settle(out, after, at + 80000)).toEqual([]);
    expect(out.length).toBe(2);
  });
});

test("paging back, rebuilding and rereading do not duplicate the ordinary echo or its approval reply", async () => {
  const filler = Array.from({ length: 240 }, (_, i) => ({ type: "response_item", payload: { type: "message", role: "assistant",
    content: [{ type: "output_text", text: `Line ${i}: ${"filler ".repeat(600)}` }] } }));
  const echo = { timestamp: fixture[1].timestamp, type: "response_item", payload: { type: "message", role: "user",
    content: [{ type: "input_text", text: texts[1] }] } };
  await replay([fixture[0], ...filler, fixture[1], echo], async (reader) => {
    expect(reader.start).toBeGreaterThan(0);
    expect(screen(reader).messages.filter((m: any) => m.who === "you").map((m: any) => m.text)).toEqual([texts[1]]);
    expect(await reader.earlier()).toBe(true);
    expect(reader.start).toBe(0);
    const chat = screen(reader);
    expect(chat.messages.filter((m: any) => m.who === "you").map((m: any) => m.text)).toEqual(texts);
    expect(settle([sent(0), sent(1)], chat)).toEqual([]);
    expect(await reader.pull()).toBe(false);
    reader.rebuild();
    expect(screen(reader).messages).toEqual(chat.messages);
  });
});

test("attachment paths survive the rejection, cid matching and restart fallback", async () => {
  const files = [{ name: "picture.png", path: "/scratch/upload/picture.png" }, { name: "notes.txt", path: "/scratch/upload/notes.txt" }];
  for (const text of ["Please inspect", ""]) {
    const body = [text, "/scratch/remote/picture.png", "/scratch/remote/notes.txt"].filter(Boolean).join("\n\n");
    const row = { ...fixture[0], payload: { type: "custom_tool_call_output", call_id: "attachments", output: [
      { type: "input_text", text: "Script failed\nWall time 1 seconds\nOutput:\n" },
      { type: "input_text", text: `Script error:\nexec_command failed: CreateProcess { message: ${JSON.stringify(`Rejected(${JSON.stringify("The person didn't use the card and wrote in the chat instead: " + body)})`)} }` },
    ] } };
    await replay([row], async (reader) => {
      const out = [sent(0, { text, files })];
      const chat = screen(reader, out);
      expect(chat.messages[0]?.text).toBe(body);
      expect(chat.messages[0]?.cid).toBe("screen-0");
      expect(settle(out, chat)).toEqual([]);
      const fallback = screen(reader);
      expect(fallback.messages[0]?.text).toBe(body);
      expect(settle(out, fallback)).toEqual([]);
      expect(out[0].files).toEqual(files);
    });
  }
});
