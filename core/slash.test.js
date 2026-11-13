import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCAN, scanned, commandList, typing, match, opensMenu } from "./slash.js";
import { messageBody, sendTyped } from "./send.js";
import * as mentions from "./mentions.js";

let home, cwd, records;
const put = (path, value) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};
const settings = (where, plugins) => put(join(where, ".claude/settings.json"), { enabledPlugins: plugins });
const skill = (root, path, extra = "", name = path.split("/").at(-1)) =>
  put(join(root, path, "SKILL.md"), `---\nname: ${name}\ndescription: 'Ask about docs: carefully'\n${extra}---\nNever execute this fixture.\n`);
function plugin(id, { scope = "user", projectPath, manifest = { name: id.split("@")[0] } } = {}) {
  const root = join(home, "plugin cache", id, String(records[id]?.length ?? 0));
  if (manifest !== null) put(join(root, ".claude-plugin/plugin.json"), manifest);
  (records[id] ??= []).push({ scope, projectPath, installPath: root, version: "1" });
  return root;
}
function scan(extraEnv = {}) {
  put(join(home, ".claude/plugins/installed_plugins.json"), { version: 2, plugins: records });
  const p = Bun.spawnSync(["sh", "-c", SCAN, "scan", cwd], {
    env: { PATH: process.env.PATH, HOME: home, ...extraEnv }, stdout: "pipe", stderr: "pipe",
  });
  expect(p.stderr.toString()).toBe("");
  expect(p.exitCode).toBe(0);
  return scanned(p.stdout.toString());
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "shep-slash-"));
  cwd = join(home, "project with spaces");
  mkdirSync(cwd);
  records = {};
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("enabled installed plugin: nested manual-only skill, full namespace and description", () => {
  const root = plugin("mattpocock-skills@official", { manifest: { name: "mattpocock-skills", skills: ["./skills/engineering/grill-with-docs"] } });
  skill(root, "skills/engineering/grill-with-docs", "disable-model-invocation: true\n");
  settings(home, { "mattpocock-skills@official": true });
  expect(scan()).toEqual([{ name: "mattpocock-skills:grill-with-docs", about: "Ask about docs: carefully" }]);
});

test("disabled, uninstalled and another project's plugins never leak from the cache", () => {
  const disabled = plugin("disabled@market");
  const elsewhere = plugin("elsewhere@market", { scope: "project", projectPath: join(home, "elsewhere") });
  for (const root of [disabled, elsewhere, join(home, ".claude/plugins/cache/stale/old/1")]) skill(root, "skills/no");
  settings(home, { "disabled@market": false, "elsewhere@market": true, "uninstalled@market": true });
  expect(scan()).toEqual([]);
});

test("project enables override user disables; local disables override project enables", () => {
  const a = plugin("a@market"), b = plugin("b@market");
  skill(a, "skills/yes"); skill(b, "skills/no");
  settings(home, { "a@market": false, "b@market": true });
  settings(cwd, { "a@market": true, "b@market": true });
  put(join(cwd, ".claude/settings.local.json"), { enabledPlugins: { "b@market": false } });
  expect(scan().map((c) => c.name)).toEqual(["a:yes"]);
});

test("only the matching highest installation scope supplies a plugin version", () => {
  const id = "scoped@market";
  const user = plugin(id), project = plugin(id, { scope: "project", projectPath: cwd });
  const local = plugin(id, { scope: "local", projectPath: cwd });
  const other = plugin(id, { scope: "local", projectPath: join(home, "other") });
  for (const [root, name] of [[user, "user"], [project, "project"], [local, "local"], [other, "other"]]) skill(root, `skills/${name}`);
  settings(home, { [id]: true });
  expect(scan().map((c) => c.name)).toEqual(["scoped:local"]);
});

test("custom skill directory, direct skill directory and plugin-root locations", () => {
  const root = plugin("paths@market", { manifest: { name: "actual-name", skills: ["./custom", "./direct", "."] } });
  skill(root, "custom/category/folder", "", "public-name");
  skill(root, "direct");
  skill(root, "skills/default");
  skill(root, ".", "", "root-skill");
  settings(home, { "paths@market": true });
  expect(scan().map((c) => c.name).sort()).toEqual(["actual-name:default", "actual-name:direct", "actual-name:public-name", "actual-name:root-skill"]);
});

test("hidden skills stay hidden; manual-only skills stay visible, even with comments", () => {
  const root = plugin("visibility@market");
  skill(root, "skills/hidden", "user-invocable: false # background only\n");
  skill(root, "skills/manual", "disable-model-invocation: true\n");
  skill(root, "skills/both", "disable-model-invocation: true\nuser-invocable: false\n");
  settings(home, { "visibility@market": true });
  expect(scan().map((c) => c.name)).toEqual(["visibility:manual"]);
});

test("malformed metadata and missing paths do not hide legacy commands", () => {
  plugin("bad-json@market", { manifest: "{no" });
  plugin("bad-type@market", { manifest: [] });
  plugin("missing@market", { manifest: null });
  records["broken@market"] = [null, { scope: "user", installPath: 7 }, { scope: "user", installPath: "\0" }, { scope: "user", installPath: "relative" }, { scope: "local", installPath: home, projectPath: "\0" }];
  records["wrong@market"] = {};
  settings(home, Object.fromEntries(Object.keys(records).map((k) => [k, true])));
  put(join(home, ".claude/commands/release/check.md"), "---\ndescription: >-\n  Check a release\n  without running it\n---\n");
  skill(cwd, ".claude/skills/old", "");
  expect(scan()).toEqual([{ name: "release:check", about: "Check a release without running it" }, { name: "old", about: "Ask about docs: carefully" }]);
});

test("missing manifest uses installed id, malformed settings fail softly", () => {
  const root = plugin("fallback@market", { manifest: null });
  skill(root, "skills/no-frontmatter");
  put(join(root, "skills/no-frontmatter/SKILL.md"), "# No frontmatter\ndescription: not metadata\n");
  settings(home, { "fallback@market": true });
  put(join(cwd, ".claude/settings.json"), "{bad");
  put(join(cwd, ".claude/settings.local.json"), []);
  expect(scan()).toEqual([{ name: "fallback:no-frontmatter", about: "Your command" }]);
});

test("manifest paths cannot escape the installed plugin", () => {
  const root = plugin("contained@market", { manifest: { name: "contained", skills: ["../outside", "/tmp", 4] } });
  skill(root, "skills/okay");
  skill(join(root, ".."), "outside/secret");
  settings(home, { "contained@market": true });
  expect(scan().map((c) => c.name)).toEqual(["contained:okay"]);
});

test("a malformed registry does not break user skills", () => {
  skill(home, ".claude/skills/personal");
  const registry = join(home, "alternate plugins/installed_plugins.json");
  for (const value of ["not json", [], { plugins: [] }, { plugins: null }]) {
    put(registry, value);
    expect(scan({ CLAUDE_CODE_PLUGIN_CACHE_DIR: join(home, "alternate plugins") }).map((c) => c.name)).toEqual(["personal"]);
  }
});

test("agent configuration and plugin-cache overrides are honored", () => {
  const config = join(home, "alternate config"), plugins = join(home, "alternate plugins");
  const root = plugin("custom@market");
  skill(root, "skills/found");
  put(join(config, "settings.json"), { enabledPlugins: { "custom@market": true } });
  put(join(plugins, "installed_plugins.json"), { version: 2, plugins: records });
  expect(scan({ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins }).map((c) => c.name)).toEqual(["custom:found"]);
});

test("repository-local settings and installs apply in subdirectories, not sibling projects", () => {
  const repo = cwd;
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  const root = plugin("repo@market", { scope: "local", projectPath: repo });
  skill(root, "skills/found");
  settings(home, { "repo@market": true });
  cwd = join(repo, "subdir");
  mkdirSync(cwd);
  expect(scan().map((c) => c.name)).toEqual(["repo:found"]);
  put(join(repo, ".claude/settings.local.json"), { enabledPlugins: { "repo@market": false } });
  expect(scan()).toEqual([]);
  cwd = join(home, "sibling");
  mkdirSync(cwd);
  expect(scan()).toEqual([]);
});

test("default enablement respects explicit disables and manifest opt-out", () => {
  const root = plugin("default@market");
  const off = plugin("opt-out@market", { manifest: { name: "opt-out", defaultEnabled: false } });
  skill(root, "skills/found"); skill(off, "skills/hidden");
  expect(scan().map((c) => c.name)).toEqual(["default:found"]);
  settings(home, { "default@market": false, "opt-out@market": true });
  expect(scan().map((c) => c.name)).toEqual(["opt-out:hidden"]);
});

test("registered marketplace default overrides the manifest, but not explicit enablement", () => {
  const root = plugin("default@market");
  skill(root, "skills/found");
  const marketplace = join(home, "marketplace with spaces");
  put(join(home, ".claude/plugins/known_marketplaces.json"), { market: { installLocation: marketplace } });
  put(join(marketplace, ".claude-plugin/marketplace.json"), { plugins: [{ name: "default", defaultEnabled: false }] });
  expect(scan()).toEqual([]);
  settings(home, { "default@market": true });
  expect(scan().map((c) => c.name)).toEqual(["default:found"]);
});

test("builtin and legacy precedence and Codex behavior are unchanged", () => {
  put(join(home, ".claude/commands/same.md"), "---\ndescription: User first\n---\n");
  put(join(cwd, ".claude/commands/same.md"), "---\ndescription: Project second\n---\n");
  put(join(cwd, ".claude/commands/model.md"), "---\ndescription: Not builtin\n---\n");
  const mine = scan(), list = commandList("claude", mine);
  expect(list.filter((c) => c.name === "same")).toEqual([{ name: "same", about: "User first" }]);
  expect(list.find((c) => c.name === "model").about).toBe("Choose the model");
  expect(commandList("codex", mine).some((c) => c.name === "same")).toBe(false);
});

test("prefix and substring search find the qualified name; sending preserves it", async () => {
  const entry = { name: "mattpocock-skills:grill-with-docs", about: "Ask about docs" };
  const list = commandList("claude", [entry]);
  for (const text of ["/mattpocock", "/grill", "/GRILL"]) expect(match(list, typing(text))).toEqual([entry]);
  expect(opensMenu("claude", `/${entry.name}`)).toBeNull();
  const calls = [], body = messageBody({ text: `/${entry.name}` });
  await sendTyped({ hc: async (args) => { calls.push(args); return { code: 0, stdout: '{"started":true}' }; } }, "remote/t1", "claude", body);
  expect(calls).toEqual([["send", "remote/t1", "/mattpocock-skills:grill-with-docs"]]);
});

test("desktop actual pick and send methods preserve a plugin command", () => {
  const source = readFileSync(new URL("../mods/chat/main.js", import.meta.url), "utf8");
  const method = (name, args) => source.match(new RegExp(`\\n  ${name}\\(${args}\\) \\{\\n[\\s\\S]*?\\n  \\}`))[0].trim();
  const object = new Function("mentions", "note", `return { ${method("pick", "c, cx")}, ${method("send", "cx, hold = false")} };`)(mentions, () => {});
  let value = "", sent;
  const self = { ...object, box: { value: () => value, set_value: (v) => { value = v; }, focus: () => {} },
    files: [], picked: [], pickedTasks: [], deliver: (msg) => { sent = msg; }, saveSoon: () => {} };
  const cx = { notify: () => {}, timer: { after: () => {} } };
  self.pick({ name: "mattpocock-skills:grill-with-docs" }, cx);
  expect(value).toBe("/mattpocock-skills:grill-with-docs ");
  self.send(cx);
  expect(sent.text).toBe("/mattpocock-skills:grill-with-docs");
});

test("desktop discovery runs on the agent machine and retries an empty result", async () => {
  const source = readFileSync(new URL("../mods/chat/slash.js", import.meta.url), "utf8")
    .replace(/^import .*;$/gm, "").replace(/^export \{.*;$/gm, "").replace("export async function", "async function");
  const calls = [];
  const commands = new Function("exec", "SCAN", "scanned", "commandList", `${source}\nreturn commands;`)(
    async (...args) => { calls.push(args); if (calls.length === 1) throw new Error("offline"); return { stdout: '[{"name":"plugin:found","about":"Found"}]' }; }, SCAN, scanned, commandList);
  expect((await commands("claude", "remote", "/folder with spaces")).some((c) => c.name === "plugin:found")).toBe(false);
  expect((await commands("claude", "remote", "/folder with spaces")).some((c) => c.name === "plugin:found")).toBe(true);
  expect(calls[1]).toEqual(["sh", ["-c", SCAN, "scan", "/folder with spaces"], { on: "remote" }]);
  await commands("codex", "remote", "/folder with spaces");
  expect(calls.length).toBe(2);
});

test("desktop refreshes for cwd changes and after thirty seconds, ignoring an old request", async () => {
  const source = readFileSync(new URL("../mods/chat/main.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("    const cmdFor ="), source.indexOf("    // What the agent's own settings say"));
  let now = 1000;
  const requests = [], completions = [];
  const refresh = new Function("t", "kind", "pid", "cx", "slash", "Date", block);
  const self = { machine: "remote" }, t = { foreground: { cwd: "/one" } };
  const cx = { spawn: (fn) => completions.push(fn({ notify() {} })) };
  const slash = { commands: (kind, machine, cwd) => new Promise((resolve) => requests.push({ kind, machine, cwd, resolve })) };
  const run = () => refresh.call(self, t, "claude", 42, cx, slash, { now: () => now });
  run(); run();
  expect(requests.length).toBe(1);
  t.foreground.cwd = "/two";
  run();
  requests[1].resolve(["new"]);
  await completions[1];
  requests[0].resolve(["old"]);
  await completions[0];
  expect(self.cmds).toEqual(["new"]);
  now += 30001;
  run();
  expect(requests.length).toBe(3);
  expect(requests[2].cwd).toBe("/two");
  requests[2].resolve(["refreshed"]);
  await completions[2];
  expect(self.cmds).toEqual(["refreshed"]);
});

test("web menu reopens with fresh discovery and ignores a closed menu's response", async () => {
  const source = readFileSync(new URL("../web/plugins/chat/client.tsx", import.meta.url), "utf8");
  const component = source.slice(source.indexOf("function SlashList("), source.indexOf("function Composer("));
  const effect = component.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[chatKey, word === null\]\)/)[1];
  const requests = [], lists = [];
  const fetch = (url) => new Promise((resolve) => requests.push({ url, resolve }));
  const open = new Function("word", "chatKey", "fetch", "setList", effect);
  const close = open("grill", "remote/chat", fetch, (l) => lists.push(l));
  close();
  const closeNew = open("grill", "remote/chat", fetch, (l) => lists.push(l));
  requests[1].resolve({ json: async () => ({ commands: [{ name: "plugin:grill", about: "Found" }] }) });
  requests[0].resolve({ json: async () => ({ commands: [] }) });
  await Bun.sleep(0);
  expect(requests.map((r) => r.url)).toEqual(["api/commands?chat=remote%2Fchat", "api/commands?chat=remote%2Fchat"]);
  expect(lists.at(-1)).toEqual([{ name: "plugin:grill", about: "Found" }]);
  closeNew();
});
