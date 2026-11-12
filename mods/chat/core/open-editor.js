// Shared core: the source is core/open-editor.js; bin/sync-shared copies it into mods/chat/core/. Edit it here.
// The task view's Open in VS Code, iTerm2 and Finder (mods/chat/panel.js, SHEP-27, SHEP-38): a task's folder (its
// worktree, or its list's folder for a --here task) in that app on this machine. Says why when it can't: another
// machine's task, a worktree not made yet or removed since (a Done task), the app missing.
// Plain JS: no herdr, node or DOM.

/** sh scripts opening folder $1 without waiting on the app. Each exits 3 when the folder is gone, 4 when the app
 *  isn't there. */
const GONE = `[ -d "$1" ] || exit 3`;
const MAC = `[ "$(uname)" = Darwin ] || exit 4`;

/** VS Code: the `code` CLI when it's on PATH, else macOS's app by name. */
const VSCODE = `${GONE}
if command -v code >/dev/null 2>&1 && code "$1" >/dev/null 2>&1; then exit 0; fi
[ "$(uname)" = Darwin ] && open -a "Visual Studio Code" "$1" >/dev/null 2>&1 && exit 0
exit 4`;

/** iTerm2: `open -a iTerm <dir>` opens a new window (or tab, per iTerm2's own setting) already in that folder.
 *  `open -Ra` only looks the app up, so a missing iTerm2 is told apart from one that fails to start. */
const ITERM = `${GONE}
${MAC}
open -Ra iTerm >/dev/null 2>&1 || exit 4
open -a iTerm "$1"`;

/** Finder: `open <dir>` shows the folder in a Finder window. */
const FINDER = `${GONE}
${MAC}
open "$1"`;

/** The header's buttons, in their order: name, icon (mods/chat), script, and what a missing app says. */
export const APPS = {
  vscode: { name: "VS Code", icon: "vscode.svg", script: VSCODE, missing: "VS Code isn't installed: no `code` command and no Visual Studio Code app." },
  iterm: { name: "iTerm2", icon: "terminal-square.svg", script: ITERM, missing: "iTerm2 isn't installed." },
  finder: { name: "Finder", icon: "finder.svg", script: FINDER, missing: "Finder is only on macOS." },
};

export const title = (app) => `Couldn't open ${APPS[app].name}`;

/** The folder a task opens on: its worktree (a worktree task), else its list's folder. rec: its record (panel.js
 *  loadTask()). null while it has none (a worktree task not started yet). */
export function folderOf(rec) {
  if (!rec) return null;
  if (rec.mode === "worktree" || (rec.mode == null && rec.worktree)) return rec.worktree || null;
  return rec.folder || null;
}

/** Why a button can't run for this task, before trying: { title, body }, or null when it can. */
export function cantOpen(rec, app) {
  const t = title(app);
  if (!rec) return { title: t, body: "The task isn't read yet." };
  if (rec.machine) return { title: t, body: `This task runs on ${rec.machine}: ${APPS[app].name} opens only this machine's folders.` };
  if (!folderOf(rec)) return { title: t, body: "The task has no worktree yet: it's made when the task starts." };
  return null;
}

/** The command: [program, args]. */
export const openCommand = (app, dir) => ["sh", ["-c", APPS[app].script, `open-${app}`, dir]];

/** What a button says after running: null when it worked, else { title, body }. r: the exec result, null when it
 *  couldn't start. done: the task is Done (its worktree removed). */
export function openProblem(app, r, done) {
  if (r && r.code === 0) return null;
  const t = title(app);
  if (!r) return { title: t, body: "sh couldn't start." };
  if (r.code === 3) return { title: t, body: done ? "Its folder is gone (a finished task's worktree is removed)." : "Its folder is gone." };
  if (r.code === 4) return { title: t, body: APPS[app].missing };
  return { title: t, body: String(r.stderr ?? "").trim().split("\n").pop() || `It exited with ${r.code}.` };
}
