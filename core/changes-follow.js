// Which folder the Changes side panel (mods/my-changes) shows, SHEP-21: the task open in the Tasks panel, else the space.
// Shared core: the source is core/changes-follow.js; bin/sync-shared copies it into mods/my-changes/core/. Edit it here.
// A task is open while the layout's "tasks" stack shows "tasks-thread" (the panel may show Changes meanwhile: both are
// children of "panel-body"); ‹ Tasks back to the list leaves it. Shared "tasks.thread" names the task, and the task
// view's header publishes its record's place in shared "tasks.thread.where" (lib/taskwhere.js). Decided from what both
// name now, never from a queue of switches, so opening tasks fast reads only the last one (as core/thread-bind.js).
// Plain JS: no herdr, node or DOM.

export const MODES = ["uncommitted", "base", "ref"];

/** Whether the layout's Tasks stack shows a task (its "tasks-thread"), hidden panel or not. */
export function taskOpen(tree) {
  const find = (n) => {
    if (!n || typeof n !== "object") return null;
    if (n.id === "tasks") return n;
    for (const c of n.children ?? []) { const hit = find(c); if (hit) return hit; }
    return null;
  };
  return find(tree)?.active === "tasks-thread";
}

const machineOf = (terminal) => (typeof terminal === "string" && terminal.includes("/") ? terminal.split("/")[0] : null);

/** The "tasks.thread.where" that is this thread's: the same terminal, or for one never started the same ref. */
export function whereOf(thread, where) {
  if (!thread || !where) return null;
  const t = thread.terminal ?? null;
  if ((where.terminal ?? null) !== t) return null;
  if (t === null && (!thread.task || where.ref !== thread.task)) return null;
  return where;
}

/**
 * What to show: { follow (a task is open), task (its ref; null until known), terminal, cwd, on (machine, null: here),
 * base (the task's own base branch), branch, repo (its list's folder, for a worktree that is gone), pending (the task's
 * place isn't read yet) }. space: { cwd, on } (the panel's location() today).
 */
export function target({ open, thread, where, space }) {
  const none = { base: null, branch: null, repo: null, pending: false };
  if (!open || !thread) return { follow: false, task: null, terminal: null, cwd: space?.cwd ?? null, on: space?.on ?? null, ...none };
  const w = whereOf(thread, where), terminal = thread.terminal ?? null;
  const task = w?.ref ?? thread.task ?? null;
  if (w) {
    return { follow: true, task, terminal, cwd: w.folder ?? null, on: w.machine ?? machineOf(terminal), base: w.base ?? null,
      branch: w.branch ?? null, repo: w.repo ?? null, pending: !w.folder };
  }
  // Never started: no worktree yet, so its list's folder (the key the Tasks list sent).
  if (!terminal && thread.key?.folder) return { follow: true, task, terminal, cwd: thread.key.folder, on: thread.key.machine ?? null, ...none };
  return { follow: true, task, terminal, cwd: null, on: machineOf(terminal), ...none, pending: true };
}

/** One task's identity for the panel (null: the space's): a new one starts again in Base mode. */
export const taskKey = (t) => (t.follow ? `${t.on ?? ""}|${t.terminal ?? ""}|${t.task ?? ""}` : null);

/**
 * The mode to show and the task view's own mode to keep. person: the mode the person picked for the space (saved,
 * untouched while a task shows); prev: { key, mode } of the task shown last (mode: picked while it showed, or null).
 * A task opens in Base; leaving it shows the person's mode again.
 */
export function modeFor(t, person, prev) {
  const key = taskKey(t);
  const own = MODES.includes(person) ? person : "uncommitted";
  if (key === null) return { mode: own, key: null, taskMode: null };
  const taskMode = prev?.key === key && MODES.includes(prev?.mode) ? prev.mode : "base";
  return { mode: taskMode, key, taskMode };
}

/** The quiet line for a task whose folder isn't a git checkout any more, by whether its branch still shows. */
export function goneLine(ref, branch) {
  const whose = ref ? `${ref}'s` : "This task's";
  return branch ? `${whose} worktree is gone: its branch ${branch} against its base` : `${whose} worktree is gone`;
}
