// A task's side views inside the Tasks panel's task view (mods/chat/panel.js): Pull request
// (mods/task-pr), Browser (mods/task-browser) and Shell (mods/task-shell), each a child
// of the view's body stack beside the worker's chat and terminal, picked in its header.
// Which task: shared "tasks.thread.where", published by the header from the task's record =
// { terminal, ref, folder (its worktree, else its list's folder), machine (null: here), repo (its list's folder), branch,
//   base, start (the commit it started from), pr ({ number, url, repo } once herdr-task made one),
//   key (its herdr.task key, "<slug>#<id>"), state (its record's: running, ready, done...) }.
// Shared: the source is lib/taskwhere.js; bin/sync-shared copies it into each mod in lib/COPIES (the header too).
import { shared, layout, appHome, readTextFile, writeTextFile } from "herdr";

export const BODY = "tasks-thread-body";
export const PR = "tasks-thread-pr";
export const BROWSER = "tasks-thread-browser";
export const SHELL = "tasks-thread-shell";
export const SHELL_HOST = "tasks-thread-shell-host", SHELL_VIEW = "tasks-thread-shell-view";

/** Whether w (a "tasks.thread.where") is thread's (a "tasks.thread"): the same terminal and, when known, the same key. */
export function whereFits(w, thread) {
  if (!w || !thread || (w.terminal ?? null) !== (thread.terminal ?? null)) return false;
  // Two tasks never started both have no terminal: the key tells them apart.
  const k = thread.key;
  return !k?.slug || (w.key === `${k.slug}#${k.id}` && (w.machine ?? null) === (k.machine ?? null));
}

// Only the shown task's: while another opens, its place isn't read yet (null).
export function where() {
  const w = shared("tasks.thread.where");
  return whereFits(w, shared("tasks.thread")) ? w : null;
}

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
}

// On screen: the panel shows, on the Tasks stack's task view, with this child picked. A copy
// stays alive hidden (the list, another child): it reads git only while shown.
export function shown(child) {
  const l = layout();
  return !find(l, "panel")?.hidden && find(l, "panel-body")?.active === "tasks"
    && find(l, "tasks")?.active === "tasks-thread" && find(l, BODY)?.active === child;
}

// The Shell (mods/task-shell) ------------------------------------------------------------------
// Its column: the mod's block (SHELL_HOST) alone, or hidden beside a terminal block (SHELL_VIEW) showing the task's shell.

export const machineOf = (addr) => (String(addr).includes("/") ? String(addr).split("/")[0] : null);

/** The task's live shell among the core's terminals (on the task's machine), or null. */
export function shellOf(list, key, machine) {
  return (list ?? []).find((k) => k.state === "live" && k.labels?.["herdr.task-shell"] === key
    && machineOf(k.address) === (machine ?? null)) ?? null;
}

/** The terminal the Shell column shows now, or null. */
export const shellShown = (tree) => find(tree, SHELL_VIEW)?.content?.terminal ?? null;

/**
 * Whether the Shell column's terminal (addr) may show for the task w (its where()): "ok" (none, or that task's live
 * shell), "stale" (another task's shell, an ended one, or the task is done) or "unknown" (not in the list: just started,
 * or gone).
 */
export function shellFits(addr, w, list) {
  if (!addr) return "ok";
  if (!w) return "unknown";
  if (w.state === "done") return "stale";
  const k = (list ?? []).find((x) => x.address === addr);
  if (!k) return "unknown";
  return k.state === "live" && k.labels?.["herdr.task-shell"] === w.key && machineOf(addr) === (w.machine ?? null) ? "ok" : "stale";
}

/** The Shell column as it should be: the shell's terminal shown (addr), or the mod alone. */
export function arrangeShell(tree, addr) {
  const col = find(tree, SHELL);
  if (!col) throw new Error("This layout has no task shell.");
  const host = { id: SHELL_HOST, type: "block", size: { weight: 1 }, content: { mod: "task-shell" }, ...(addr ? { hidden: true } : {}) };
  col.type = "column";
  delete col.content;
  col.children = addr ? [host, { id: SHELL_VIEW, type: "block", content: { terminal: addr } }] : [host];
}

// One edit of the layout's file, only if it's unchanged since read (else read again); then Herdr reads it.
export async function pointShell(addr, cx) {
  const path = `${appHome()}/layouts/${shared("layout")}.json`;
  try {
    for (let i = 0; ; i++) {
      const text = await readTextFile(path);
      const tree = JSON.parse(text ?? "null");
      if (shellShown(tree) === (addr ?? null) && find(tree, SHELL)?.type === "column") break;
      arrangeShell(tree, addr);
      try { await writeTextFile(path, JSON.stringify(tree, null, 2), text); break; }
      catch (e) { if (i >= 2) throw e; }
    }
    for (let i = 0; i < 30 && shellShown(layout()) !== (addr ?? null); i++) await new Promise((r) => cx.timer.after(100, () => r()));
    if (shellShown(layout()) !== (addr ?? null)) throw new Error("Herdr didn't load the layout with this task's shell.");
  } catch (e) {
    console.log(`[task-shell] pointShell failed (${path}, terminal ${addr ?? "none"}): ${String(e?.message ?? e)}`);
    throw e;
  }
}
