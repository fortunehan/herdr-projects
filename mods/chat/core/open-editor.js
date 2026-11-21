// Shared core: the source is core/open-editor.js; bin/sync-shared copies it into mods/chat/core/ and mods/pane-chat/core/.
// Edit it here.
// Opening a folder of this machine in another app, for the task view's VS Code, iTerm2, Finder and Xcode icons
// (mods/chat/panel.js, SHEP-27, SHEP-38, SHEP-91) and a pane header's Open in iTerm2, VS Code, Finder and Xcode menu
// (mods/pane-chat, SHEP-97). Both run openFolder(): one macOS `open` per click, and a failure says what it printed.
// Plain JS: no herdr, node or DOM.

/** The task view's icons, in their order: name, icon (mods/chat) and how `open` finds the app. VS Code, Finder and
 *  Xcode by bundle id (`open -b`: LaunchServices finds the app wherever it's installed, e.g. ~/Tools); iTerm2 by its
 *  name (`open -a iTerm`), the terminal the person picked (SHEP-97). No lookup script, no folder check first: `open`
 *  says itself when the folder or the app isn't there. */
export const APPS = {
  vscode: { name: "VS Code", icon: "vscode.svg", find: ["-b", "com.microsoft.VSCode"] },
  iterm: { name: "iTerm2", icon: "terminal-square.svg", find: ["-a", "iTerm"] },
  finder: { name: "Finder", icon: "finder.svg", find: ["-b", "com.apple.finder"] },
  xcode: { name: "Xcode", icon: "xcode.svg", find: ["-b", "com.apple.dt.Xcode"] },
};

export const title = (app) => `Couldn't open ${APPS[app].name}`;

const OPEN = "/usr/bin/open";
const TIMEOUT = 15000;

/** A command as the person would type it, for the toast. */
const shown = (cmd, args) => [cmd.split("/").pop(), ...args].map((a) => (/^[\w./@:=+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");

/** What a command printed that says why: its stderr's last line, else its stdout's, else its exit code. */
function said(r) {
  const last = (s) => String(s ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return last(r.stderr) || last(r.stdout) || (r.code == null ? "it didn't finish" : `it exited with ${r.code}`);
}

/** The one command openFolder runs: [program, args]. Off macOS, VS Code's `code` command. */
export function openCommand(app, dir, platform = "macos") {
  if (platform !== "macos") return app === "vscode" ? ["code", [dir]] : null;
  return [OPEN, [...APPS[app].find, "--", dir]];
}

/** Opens folder dir of this machine in app (a key of APPS). exec: herdr's (or a stand-in), never through a shell:
 *  every argument goes as is. Resolves with null when it opened, else { title, body }: the body says what went wrong
 *  in plain words when it's known (the folder or the app missing), else what the command printed, always with the
 *  command. platform: window().platform; off macOS only VS Code opens. done: the task is Done (its worktree removed). */
export async function openFolder(exec, app, dir, { platform = "macos", done = false } = {}) {
  const t = title(app), name = APPS[app].name;
  const command = openCommand(app, dir, platform);
  if (!command) return { title: t, body: `${name} opens only on macOS.` };
  const [cmd, args] = command, how = `(${shown(cmd, args)})`;
  let r;
  try { r = await exec(cmd, args, { timeout: TIMEOUT }); } catch (e) {
    return { title: t, body: `${cmd} couldn't run: ${String(e?.message ?? e).trim() || "no reason given"} ${how}` };
  }
  r = r ?? { code: null, stdout: "", stderr: "" };
  if (r.code === 0) return null;
  const err = String(r.stderr ?? "");
  if (/does not exist/i.test(err)) {
    return { title: t, body: done ? `Its folder is gone (a finished task's worktree is removed): ${dir}` : `The folder is missing: ${dir}` };
  }
  if (/LSCopyApplicationURLsForBundleIdentifier|Unable to find application/i.test(err)) return { title: t, body: `${name} isn't installed. ${how}` };
  return { title: t, body: `Opening ${name} failed: ${said(r)} ${how}` };
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
  if (rec.machine) return { title: t, body: `This task runs on ${rec.machine}: ${APPS[app].name} opens only this machine's folders.` };
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
