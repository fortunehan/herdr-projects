// Shared core: the source is core/open-editor.js; bin/sync-shared copies it into mods/chat/core/ and mods/pane-chat/core/.
// Edit it here.
// Opening a folder of this machine in another app, for the task view's VS Code, iTerm2, Finder and Xcode icons
// (mods/chat/panel.js, SHEP-27, SHEP-38, SHEP-91) and a pane header's Open in Terminal, VS Code, Finder and Xcode menu
// (mods/pane-chat, SHEP-97). Both run openFolder(): the same commands, and a failure says which step failed and what
// the command printed.
// Plain JS: no herdr, node or DOM.

/** The task view's icons, in their order: name, icon (mods/chat) and the app's bundle id. `open -b <id>` asks
 *  LaunchServices for the app wherever it's installed (VS Code in ~/Applications or ~/Tools too) and needs no lookup
 *  script (SHEP-97). */
export const APPS = {
  vscode: { name: "VS Code", icon: "vscode.svg", bundle: "com.microsoft.VSCode" },
  iterm: { name: "iTerm2", icon: "terminal-square.svg", bundle: "com.googlecode.iterm2" },
  finder: { name: "Finder", icon: "finder.svg", bundle: "com.apple.finder" },
  xcode: { name: "Xcode", icon: "xcode.svg", bundle: "com.apple.dt.Xcode" },
};

/** The pane header's Terminal: the person's default terminal app, not a fixed one. */
export const TERMINAL = { name: "Terminal" };

export const appName = (app) => (app === "terminal" ? TERMINAL.name : APPS[app].name);
export const title = (app) => `Couldn't open ${appName(app)}`;

/** NSWorkspace's handler for Unix executables is the system's default terminal (macOS 12+).
 *  https://developer.apple.com/documentation/appkit/nsworkspace/urlforapplication(toopen:)-95cvp
 *  A fixed script: the folder never goes into it. Prints the app's path. */
export const DEFAULT_TERMINAL = `ObjC.import("AppKit");
ObjC.import("/System/Library/Frameworks/UniformTypeIdentifiers.framework");
function run() {
  const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenContentType($.UTType.typeWithIdentifier("public.unix-executable"));
  if (app.isNil()) throw Error("No default terminal application is configured.");
  return ObjC.unwrap(app.path);
}`;

const OPEN = "/usr/bin/open";
/** /bin/test, never /usr/bin/test: macOS 26 has no /usr/bin/test, so exec refused to start it and every Open failed
 *  before reaching the app (SHEP-97). */
const TEST = "/bin/test";
const TIMEOUT = 15000;

/** A command as the person would type it, for the toast. */
const shown = (cmd, args) => [cmd.split("/").pop(), ...args].map((a) => (/^[\w./@:=+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");

/** What a command printed that says why: its stderr's last line, else its stdout's, else its exit code. */
function said(r) {
  const last = (s) => String(s ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return last(r.stderr) || last(r.stdout) || (r.code == null ? "it didn't finish" : `it exited with ${r.code}`);
}

/** The app's path from the default-terminal lookup's stdout, or null. */
function appPath(stdout) {
  const line = String(stdout ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return line.startsWith("/") && line.endsWith(".app") ? line : null;
}

/** Opens folder dir of this machine in app ("terminal" or a key of APPS). exec: herdr's (or a stand-in), never
 *  through a shell: every argument goes as is. Resolves with null when it opened, else { title, body }: the body
 *  names the step that failed, its command and what it printed. platform: window().platform; off macOS only
 *  VS Code opens (its `code` command). done: the task is Done (its worktree removed). */
export async function openFolder(exec, app, dir, { platform = "macos", done = false } = {}) {
  const t = title(app), name = appName(app);
  const step = async (cmd, args) => {
    let r;
    try { r = await exec(cmd, args, { timeout: TIMEOUT }); } catch (e) {
      r = { code: null, stdout: "", stderr: `${cmd} couldn't run: ${String(e?.message ?? e).trim() || "no reason given"}` };
    }
    return r ?? { code: null, stdout: "", stderr: `${cmd} gave no result` };
  };
  const fail = (what, cmd, args, r) => ({ title: t, body: `${what} failed: ${said(r)} (${shown(cmd, args)})` });

  if (platform !== "macos") {
    if (app !== "vscode") return { title: t, body: `${name} opens only on macOS.` };
    const r = await step("code", [dir]);
    return r.code === 0 ? null : fail("Opening VS Code with its code command", "code", [dir], r);
  }

  const there = await step(TEST, ["-d", dir]);
  if (there.code !== 0) {
    if (there.code == null) return fail("Checking the folder", TEST, ["-d", dir], there);
    return { title: t, body: done ? `Its folder is gone (a finished task's worktree is removed): ${dir}` : `The folder is missing or can't be read: ${dir}` };
  }

  if (app !== "terminal") {
    const args = ["-b", APPS[app].bundle, "--", dir];
    const r = await step(OPEN, args);
    if (r.code === 0) return null;
    if (/LSCopyApplicationURLsForBundleIdentifier|Unable to find application/i.test(r.stderr ?? "")) {
      return { title: t, body: `${name} isn't installed: macOS has no app with the bundle id ${APPS[app].bundle}. (${shown(OPEN, args)})` };
    }
    return fail(`Opening ${name}`, OPEN, args, r);
  }

  // The default terminal: looked up each time (the person may change it); Terminal.app when the lookup fails.
  const lookupArgs = ["-l", "JavaScript", "-e", DEFAULT_TERMINAL];
  const lookup = await step("/usr/bin/osascript", lookupArgs);
  const found = lookup.code === 0 ? appPath(lookup.stdout) : null;
  if (found) {
    const args = ["-a", found, "--", dir];
    const r = await step(OPEN, args);
    if (r.code === 0) return null;
    return fail(`Opening ${found.split("/").pop().replace(/\.app$/, "")}`, OPEN, args, r);
  }
  const why = lookup.code === 0 ? `it printed no app (${said(lookup)})` : said(lookup);
  const args = ["-a", "Terminal", "--", dir];
  const r = await step(OPEN, args);
  if (r.code === 0) return null;
  return { title: t, body: `Finding the default terminal failed: ${why}. Opening Terminal instead failed: ${said(r)} (${shown(OPEN, args)})` };
}

/** The commands openFolder runs on macOS when every step works, for docs and proof. */
export function openCommands(app, dir) {
  if (app !== "terminal") return [[TEST, "-d", dir], [OPEN, "-b", APPS[app].bundle, "--", dir]];
  return [[TEST, "-d", dir], ["/usr/bin/osascript", "-l", "JavaScript", "-e", "<DEFAULT_TERMINAL>"], [OPEN, "-a", "<the default terminal's app>", "--", dir]];
}

/** The folder a task opens on: its worktree (a worktree task), else its list's folder. rec: its record (panel.js
 *  loadTask()). null while it has none (a worktree task not started yet). */
export function folderOf(rec) {
  if (!rec) return null;
  if (rec.mode === "worktree" || (rec.mode == null && rec.worktree)) return rec.worktree || null;
  return rec.folder || null;
}

/** Why a task view button can't run for this task, before trying: { title, body }, or null when it can. */
export function cantOpen(rec, app) {
  const t = title(app);
  if (!rec) return { title: t, body: "The task isn't read yet." };
  if (rec.machine) return { title: t, body: `This task runs on ${rec.machine}: ${appName(app)} opens only this machine's folders.` };
  if (!folderOf(rec)) return { title: t, body: "The task has no worktree yet: it's made when the task starts." };
  return null;
}

/** The task header's Copy path and Copy panel ID (SHEP-91), as an Assistant pane header's (mods/pane-chat): the
 *  task's folder (on whichever machine it runs) and its worker's hc terminal address (a remote machine's prefix
 *  included). what: "path" or "id"; addr: the worker's address, null when none runs. */
export const COPIES = {
  path: { name: "Copy path", icon: "copy-path.svg", done: "Full path copied" },
  id: { name: "Copy panel ID", icon: "copy-id.svg", done: "Panel ID copied" },
};

/** What to copy: { text } or, when there's nothing, { problem } in plain words. */
export function copyOf(what, rec, addr) {
  if (what === "id") return addr ? { text: addr } : { problem: "No live terminal is available for this task." };
  if (!rec) return { problem: "The task isn't read yet." };
  const dir = folderOf(rec);
  return dir ? { text: dir } : { problem: "The task has no worktree yet: it's made when the task starts." };
}
