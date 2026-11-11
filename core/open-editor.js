// Shared core: the source is core/open-editor.js; bin/sync-shared copies it into mods/chat/core/. Edit it here.
// The task view's Open in VS Code (mods/chat/panel.js, SHEP-27): a task's folder (its worktree, or its list's folder
// for a --here task) in VS Code on this machine. Says why when it can't: another machine's task, a worktree not made
// yet or removed since (a Done task), no VS Code.
// Plain JS: no herdr, node or DOM.

/** sh: opens folder $1 in VS Code without waiting on it: the `code` CLI when it's on PATH, else macOS's app by name.
 *  Exits 3 when the folder is gone, 4 when no VS Code opened it. */
export const OPEN = `[ -d "$1" ] || exit 3
if command -v code >/dev/null 2>&1 && code "$1" >/dev/null 2>&1; then exit 0; fi
[ "$(uname)" = Darwin ] && open -a "Visual Studio Code" "$1" >/dev/null 2>&1 && exit 0
exit 4`;

export const TITLE = "Couldn't open VS Code";

/** The folder a task opens on: its worktree (a worktree task), else its list's folder. rec: its record (panel.js
 *  loadTask()). null while it has none (a worktree task not started yet). */
export function folderOf(rec) {
  if (!rec) return null;
  if (rec.mode === "worktree" || (rec.mode == null && rec.worktree)) return rec.worktree || null;
  return rec.folder || null;
}

/** Why the button can't run for this task, before trying: { title, body }, or null when it can. */
export function cantOpen(rec) {
  if (!rec) return { title: TITLE, body: "The task isn't read yet." };
  if (rec.machine) return { title: TITLE, body: `This task runs on ${rec.machine}: VS Code opens only this machine's folders.` };
  if (!folderOf(rec)) return { title: TITLE, body: "The task has no worktree yet: it's made when the task starts." };
  return null;
}

/** The command: [program, args]. */
export const command = (dir) => ["sh", ["-c", OPEN, "open-vscode", dir]];

/** What the button says after running: null when it worked, else { title, body }. r: the exec result, null when it
 *  couldn't start. done: the task is Done (its worktree removed). */
export function problem(r, done) {
  if (r && r.code === 0) return null;
  if (!r) return { title: TITLE, body: "sh couldn't start." };
  if (r.code === 3) return { title: TITLE, body: done ? "Its folder is gone (a finished task's worktree is removed)." : "Its folder is gone." };
  if (r.code === 4) return { title: TITLE, body: "VS Code isn't installed: no `code` command and no Visual Studio Code app." };
  return { title: TITLE, body: String(r.stderr ?? "").trim().split("\n").pop() || `It exited with ${r.code}.` };
}
