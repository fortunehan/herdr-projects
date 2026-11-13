import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG, Conversation, records } from "./chat-log.js";

// SHEP-42's captured outputs, with normalized call ids and unused metadata removed.
const fixture = readFileSync(new URL("../test/fixtures/codex-approval-chat.jsonl", import.meta.url), "utf8").trim().split("\n").map(JSON.parse);
const prefix = "The person didn't use the card and wrote in the chat instead: ";
const at = Date.parse(fixture[0].timestamp);
const users = (c) => c.items.filter((x) => x.kind === "user");
const feed = (lines) => {
  const c = new Conversation("codex");
  c.feed(lines.map((l, off) => ({ kind: "J", off, data: JSON.stringify(l) })));
  return c;
};
const user = (text, ms = 1) => ({ timestamp: new Date(at + ms).toISOString(), type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const approval = (text, id = "approval", ms = 0) => ({ timestamp: new Date(at + ms).toISOString(), type: "response_item",
  payload: { type: "custom_tool_call_output", call_id: id, output: [
    { type: "input_text", text: "Script failed\nWall time 1 seconds\nOutput:\n" },
    { type: "input_text", text: `Script error:\nexec_command failed: CreateProcess { message: ${JSON.stringify(`Rejected(${JSON.stringify(JSON.stringify(prefix + text)).slice(1, -1)})`)} }` },
  ] } });

async function read(lines) {
  const dir = mkdtempSync(join(tmpdir(), "approval-chat-"));
  try {
    const f = join(dir, "log.jsonl");
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const p = Bun.spawn(["sh", "-c", LOG, "log", "tail", f, "0"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    return records(out).records;
  } finally { rmSync(dir, { recursive: true }); }
}

test("LOG retains both captured approval-chat outputs as JSON as well as result ids", async () => {
  const recs = await read(fixture);
  expect(recs.filter((r) => r.kind === "R").length).toBe(2);
  expect(recs.filter((r) => r.kind === "J").length).toBe(2);
});

test("full Codex records independently recover both approval replies without error wrappers", () => {
  expect(users(feed(fixture)).map((u) => u.text)).toEqual([
    "SHEP-40 已经完成了，SHEP-39还需要吗",
    "codex为什么执行git fetch，rebase指令还ask？",
  ]);
  expect(users(feed(fixture)).map((u) => u.at)).toEqual(fixture.map((l) => Date.parse(l.timestamp)));
});

test("LOG to Conversation recovers the reply and still closes its tool call", async () => {
  const call = { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "approval-1", input: "text('test')" } };
  const c = new Conversation("codex");
  c.feed(await read([call, fixture[0]]));
  expect(users(c).length).toBe(1);
  expect(c.open.size).toBe(0);
  expect(c.items[0].steps[0].out).toBeDefined();
});

test("a direct function output uses the same transport rejection, not arbitrary output text", async () => {
  const l = approval("please stop");
  l.payload.type = "function_call_output";
  l.payload.output = l.payload.output[1].text.replace(/^Script error:\n/, "");
  const c = new Conversation("codex");
  c.feed(await read([l]));
  expect(users(c).map((u) => u.text)).toEqual(["please stop"]);
});

test("approval replies decode quotes, newlines, backslashes and reply tags once", () => {
  const text = '<hc reply-to="Earlier words"/>\nUse "quoted" text\nC:\\notes\\test, not a literal \\n';
  const l = approval(text);
  const [codeMode] = users(feed([l]));
  expect(codeMode?.text).toBe('Use "quoted" text\nC:\\notes\\test, not a literal \\n');
  expect(codeMode?.replyTo).toBe("Earlier words");
  const rejected = `Rejected(${JSON.stringify(prefix + text)})`;
  l.payload.output[1].text = `Script error:\nexec_command failed: CreateProcess { message: ${JSON.stringify(rejected)} }`;
  const [u] = users(feed([l]));
  expect(u?.text).toBe('Use "quoted" text\nC:\\notes\\test, not a literal \\n');
  expect(u?.replyTo).toBe("Earlier words");
});

test("ordinary output, source excerpts, unrelated denials and malformed wrappers never become user messages", async () => {
  const l = approval("not an echo");
  const error = l.payload.output[1].text;
  const outputs = [prefix + "not an echo", `Read this example:\n${error}`, JSON.stringify({ output: error }),
    error.replace("Rejected", "OtherError"), error.replace(prefix, "Denied by policy: "), error + "\nextra output", "Script error:\nexec_command failed: CreateProcess { message: broken }"];
  for (const output of outputs) {
    const row = { ...l, payload: { ...l.payload, output } };
    expect(users(feed([row]))).toEqual([]);
    const c = new Conversation("codex");
    c.feed(await read([row]));
    expect(users(c)).toEqual([]);
  }
  const successful = structuredClone(l);
  successful.payload.output[0].text = "Script completed\nWall time 1 seconds\nOutput:\n";
  expect(users(feed([successful]))).toEqual([]);
  expect(users(feed([{ ...l, payload: { ...l.payload, output: [l.payload.output[1]] } }]))).toEqual([]);
});

test("a repeated result read or a duplicate record for the same call has only one echo", async () => {
  const recs = await read([fixture[0]]);
  const c = new Conversation("codex");
  c.feed(recs);
  const id = users(c)[0]?.id;
  c.feed(recs);
  c.feed(recs.map((r) => ({ ...r, off: r.off + 10000 })));
  expect(users(c).length).toBe(1);
  expect(users(c)[0]?.id).toBe(id);
});

test("an immediate ordinary echo of an approval reply coalesces once, but a new send stays", () => {
  const c = feed([approval("please stop"), user("please stop"), user("please stop", 2)]);
  expect(users(c).map((u) => u.text)).toEqual(["please stop", "please stop"]);
  expect(users(feed([approval("please stop"), user("please stop", 60000)])).length).toBe(2);
  expect(users(feed([approval("please stop"), user("something else"), user("please stop", 2)])).length).toBe(3);
  expect(users(feed([approval("please stop"), approval("please stop", "second", 1)])).length).toBe(2);
});

test("the normal echo may precede the rejection record without drawing a second copy", () => {
  expect(users(feed([user("please stop", 0), approval("please stop", "approval", 1)])).length).toBe(1);
});

test("an agent response or turn end separates two identical sends", () => {
  const reply = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Stopped." }] } };
  const ended = { type: "event_msg", payload: { type: "task_complete" } };
  for (const middle of [reply, ended]) {
    expect(users(feed([approval("please stop"), middle, user("please stop", 2)])).length).toBe(2);
  }
});

test("approval replies keep attachment paths and clean only the chat's own tags", () => {
  const text = '<hc reply-to="Earlier words"/>\nPlease inspect\n\n/tmp/attachments/picture.png\n\n/tmp/attachments/notes.txt';
  const l = approval("");
  l.payload.output[1].text = `Script error:\nexec_command failed: CreateProcess { message: ${JSON.stringify(`Rejected(${JSON.stringify(prefix + text)})`)} }`;
  const [u] = users(feed([l]));
  expect(u?.text).toBe("Please inspect\n\n/tmp/attachments/picture.png\n\n/tmp/attachments/notes.txt");
  expect(u?.replyTo).toBe("Earlier words");
});
