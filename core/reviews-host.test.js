import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as lifecycle from "./changes-review.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hostSource = readFileSync(new URL("../lib/reviews.js", import.meta.url), "utf8");
const tabsSource = readFileSync(new URL("../mods/tabs-tasks/main.js", import.meta.url), "utf8");
const sweepBody = tabsSource.match(/try \{ await reviewSweep\(\);[^\n]+\n\s*catch \(e\) \{[^\n]+/)[0];

/** Replay the installed v0.1.15 host's Error(message), using real temporary filesystem operations.
 * https://github.com/herdrdev/herdr-app/blob/v0.1.15/vendor/gpui-kit/crates/shell/src/engine/quickjs/host.rs#L450
 * https://github.com/herdrdev/herdr-app/blob/v0.1.15/vendor/gpui-kit/crates/shell/src/engine/quickjs/scheduler.rs#L1391
 * https://github.com/herdrdev/herdr-app/blob/v0.1.15/vendor/gpui-kit/crates/shell/src/capability.rs#L459
 */
function nativeError(error, verb, path) {
  const errors = { ENOENT: ["No such file or directory", 2], EACCES: ["Permission denied", 13], ENOTDIR: ["Not a directory", 20], EISDIR: ["Is a directory", 21] };
  const [message, errno] = errors[error.code] ?? [error.message, 5];
  return new Error(`cannot ${verb} \`${path}\`: ${message} (os error ${errno})`);
}

function fixture(native = true, data = "configured-data") {
  const root = mkdtempSync(join(tmpdir(), "review-host-")); roots.push(root);
  const path = join(root, data, "reviews");
  const state = new Map([["changes.review.error", "previous failure"]]);
  const failures = {};
  const wrap = (name, verb) => async (p, ...args) => {
    if (failures[name]) throw failures[name];
    try { return await fs[name](p, ...args); }
    catch (e) { throw native ? nativeError(e, verb, relative(root, p)) : e; }
  };
  const hostFs = { readdir: wrap("readdir", "list"), readFile: wrap("readFile", "read"), realpath: fs.realpath };
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd !== "mkdir") throw new Error(`Unexpected command: ${cmd}`);
    await fs.mkdir(args.at(-1), { recursive: true, mode: 0o700 });
    return { code: 0, stdout: "", stderr: "" };
  };
  const writeTextFile = async (p, text, expected) => {
    if (expected === null) await fs.writeFile(p, text, { flag: "wx" });
    else {
      expect(await fs.readFile(p, "utf8")).toBe(expected);
      await fs.writeFile(p, text);
    }
  };
  const never = () => { throw new Error("Live API must not be called"); };
  const bindings = { ...lifecycle, exec, hc: never, writeTextFile, openOverlay: never,
    shared: (key) => state.get(key), panes: () => [], terminals: () => [], spaces: () => [],
    fs: hostFs, dirsReady: async () => ({ reviews: path }) };
  const body = hostSource.replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  const host = new Function(...Object.keys(bindings), `${body}\nreturn { io, reviewRecords, reviewSweep, reviewTick };`)(...Object.values(bindings));
  const sweep = new Function("reviewSweep", "shared", "setShared", `return async () => { ${sweepBody} };`)(host.reviewSweep, bindings.shared, (k, v) => state.set(k, v));
  const record = { id: "review-first", created: 1, state: "passed", rounds: [], completedReviews: 1,
    target: { root: "/scratch/repo" }, source: { conversation: "scratch-source" },
    round: { number: 1, findings: [], delivery: { state: "received" } } };
  return { root, path, host, hostFs, state, failures, calls, sweep, record };
}

for (const native of [true, false]) {
  test(`fresh list and actual tab sweep clear the banner (${native ? "native Error without code" : "Node"})`, async () => {
    const f = fixture(native);
    await f.sweep();
    expect(f.state.get("changes.review.error")).toBeNull();
    await expect(f.host.reviewRecords()).resolves.toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test(`first reserve, save, reload and existing report stay on the configured path (${native ? "native" : "Node"})`, async () => {
    const f = fixture(native);
    await f.host.io.reserve(f.record);
    await f.host.io.save(f.record);
    const lock = await fs.readFile(join(f.path, "locks", (await fs.readdir(join(f.path, "locks")))[0]), "utf8");
    const loaded = await f.host.io.load(f.record.id);
    expect(loaded).toEqual(f.record);
    expect(await f.host.reviewRecords()).toEqual([f.record]);
    expect(await fs.readFile(join(f.path, "review-first.md"), "utf8")).toContain("Review");
    loaded.created = 2;
    await f.host.io.save(loaded);
    await f.sweep();
    expect(f.state.get("changes.review.error")).toBeNull();
    expect((await f.host.reviewRecords())[0].created).toBe(2);
    expect(await fs.readFile(join(f.path, "locks", (await fs.readdir(join(f.path, "locks")))[0]), "utf8")).toBe(lock);
    expect(f.calls.every(([cmd, args]) => cmd === "mkdir" && args.at(-1) === join(f.path, "locks"))).toBe(true);
  });
}

test("the screenshot's native grant-relative storage path is an empty first-use collection", async () => {
  const f = fixture(true, ".local/share/shepherdr");
  await f.sweep();
  expect(f.state.get("changes.review.error")).toBeNull();
  expect(await f.host.reviewRecords()).toEqual([]);
});

test("native absent report reads return null and never create storage", async () => {
  const f = fixture();
  await expect(f.host.io.load("review-absent")).resolves.toBeNull();
  await expect(fs.stat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.host.io.load("../invalid")).rejects.toThrow("Invalid Review identity");
});

test("fresh dialog refresh reaches preparation and exposes genuine storage errors", async () => {
  const f = fixture();
  const dialogSource = readFileSync(new URL("../mods/changes-review/main.js", import.meta.url), "utf8");
  const method = dialogSource.slice(dialogSource.indexOf("  refresh(cx) {"), dialogSource.indexOf("\n  launch(cx) {"));
  let prepared = 0;
  const refresh = new Function("reviewRecords", "reviews", "shared", "finished", `return ({ ${method} }).refresh;`)(
    f.host.reviewRecords, { prepare: async () => { prepared++; return { sources: [], models: [] }; } }, () => null, lifecycle.finished);
  const dialog = { p: { target: { cwd: "/scratch/repo" } }, form: {} };
  let task;
  const cx = { spawn: (fn) => { task = fn(cx); }, notify: () => {} };
  refresh.call(dialog, cx); await task;
  expect(prepared).toBe(1);
  expect(dialog.retained).toEqual([]);
  expect(dialog.form.error).toBeUndefined();
  expect(dialog.form.loading).toBe(false);
  f.failures.readdir = new Error("unreadable storage");
  refresh.call(dialog, cx); await task;
  expect(dialog.form.error).toBe("unreadable storage");
  expect(prepared).toBe(1);
});

test.skipIf(process.getuid?.() === 0)("real permission failures remain visible with the native error shape", async () => {
  const f = fixture();
  await fs.mkdir(f.path, { recursive: true });
  await fs.chmod(f.path, 0);
  try {
    await f.sweep();
    expect(f.state.get("changes.review.error")).toContain("Permission denied (os error 13)");
  } finally { await fs.chmod(f.path, 0o700); }
  const path = join(f.path, "review-locked.json");
  await fs.writeFile(path, JSON.stringify(f.record), { mode: 0 });
  try {
    await f.sweep();
    expect(f.state.get("changes.review.error")).toContain("Permission denied (os error 13)");
  } finally { await fs.chmod(path, 0o600); }
});

test("native wrong-type storage remains a visible sweep error", async () => {
  const f = fixture();
  await fs.mkdir(join(f.root, "configured-data"));
  await fs.writeFile(f.path, "not a directory");
  await f.sweep();
  expect(f.state.get("changes.review.error")).toContain("Not a directory (os error 20)");
});

test("permission, unreadable and unrelated errors propagate without being cleared", async () => {
  const f = fixture();
  for (const error of [new Error(`cannot list \`${f.path}\`: Permission denied (os error 13)`),
    new TypeError("outside every granted read root"), new Error("disk failed"),
    new Error(`cannot list \`another-path\`: No such file or directory (os error 2)`)]) {
    f.failures.readdir = error;
    await expect(f.host.reviewRecords()).rejects.toBe(error);
    await f.sweep();
    expect(f.state.get("changes.review.error")).toBe(error.message);
  }
});

test("unreadable and corrupt existing reports stay visible and unchanged", async () => {
  const f = fixture();
  await fs.mkdir(f.path, { recursive: true });
  const path = join(f.path, "review-existing.json");
  await fs.writeFile(path, "invalid json");
  await f.sweep();
  expect(f.state.get("changes.review.error")).toBeTruthy();
  expect(await fs.readFile(path, "utf8")).toBe("invalid json");
  const error = new Error(`cannot read \`${path}\`: Permission denied (os error 13)`);
  f.failures.readFile = error;
  await expect(f.host.io.load("review-existing")).rejects.toBe(error);
  await f.sweep();
  expect(f.state.get("changes.review.error")).toBe(error.message);
});

test("companion read errors remain errors after the authoritative record is saved", async () => {
  const f = fixture();
  await f.host.io.reserve(f.record);
  const error = new Error(`cannot read \`${join(f.path, "review-first.md")}\`: Permission denied (os error 13)`);
  f.failures.readFile = error;
  await expect(f.host.io.save(f.record)).rejects.toBe(error);
  expect(JSON.parse(await fs.readFile(join(f.path, "review-first.json"), "utf8"))).toEqual(f.record);
});
