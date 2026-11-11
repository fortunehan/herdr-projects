// The Tasks panel follows the space picked (SHEP-28). The panel is the window's, not a space's: its "tasks" stack kept
// showing the task opened in space A after the person picked space B. Now each space remembers the task it had open
// (and which of its views showed: Chat, Shell, Pull request...); picking a space shows its task again, else its list.
// Shared "tasks.thread.spaces" = { seen (the space the panel last showed), open: { <space id>: { thread, view } } }.
// Asked from every render of the Tasks list (mods/tasks) and of the task view's header (mods/chat/panel.js), so it
// works whichever of them shows: the first to run after the switch moves the panel, the other then finds nothing to
// do (seen is the shown space).
// Shared core: the source is core/thread-space.js; bin/sync-shared copies it into mods/tasks/core/ and mods/chat/core/.
// Plain JS: no herdr, node or DOM.

export const KEY = "tasks.thread.spaces";
export const STACK = "tasks", LIST = "tasks-list", THREAD = "tasks-thread";
export const BODY = "tasks-thread-body", CHAT = "tasks-thread-chat", TERM = "tasks-thread-term";

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
}

const keyOf = (w) => (w?.key ? `${w.key.machine ?? ""}:${w.key.slug}#${w.key.id}` : null);

/**
 * What a space switch does. now: the shown space's id; mem: the shared KEY; open: the panel shows a task; thread: the
 * shared "tasks.thread"; view: the task view's body child; ids: the window's space ids (a closed space is forgotten).
 * Returns null (nothing to do), else { mem (to share), restore ({ thread, view } to show again) or list (true: back
 * to the list) }.
 */
export function decide({ now, mem, open, thread, view, ids }) {
  if (!now) return null;
  if (!mem?.seen) return { mem: { seen: now, open: {} }, restore: null, list: false };
  if (mem.seen === now) return null;
  const kept = Object.fromEntries(Object.entries(mem.open ?? {}).filter(([id]) => !ids || ids.includes(id)));
  if (open && thread) kept[mem.seen] = { thread, view: view ?? null };
  else delete kept[mem.seen];
  const back = kept[now] ?? null;
  if (!back) return { mem: { seen: now, open: kept }, restore: null, list: Boolean(open) };
  // The same task the panel names now (a Resume that ended meanwhile follows its new agent): that, not the old one.
  const same = keyOf(back.thread) && keyOf(back.thread) === keyOf(thread);
  // The Terminal block shows whichever agent it was pointed at last: the task's chat instead.
  const v = !back.view || back.view === TERM ? CHAT : back.view;
  return { mem: { seen: now, open: kept }, restore: { thread: same ? thread : back.thread, view: v }, list: false };
}

/** Whether the shown space isn't the one the panel last showed (cheap: a render asks, then a timer moves it). */
export function switched(h) {
  const now = (h.spaces() ?? []).find((s) => s.active)?.id ?? null;
  return Boolean(now) && (h.shared(KEY)?.seen ?? null) !== now;
}

/** Moves the panel after a space switch. h: { spaces, layout, shared, setShared, run } (herdr's). True when it did. */
export function followSpace(h) {
  const all = h.spaces() ?? [];
  const now = all.find((s) => s.active)?.id ?? null;
  const tree = h.layout(), stack = find(tree, STACK);
  if (!stack || !find(tree, THREAD)) return false;
  const step = decide({ now, mem: h.shared(KEY) ?? null, open: stack.active === THREAD, thread: h.shared("tasks.thread") ?? null,
    view: find(tree, BODY)?.active ?? null, ids: all.map((s) => s.id) });
  if (!step) return false;
  h.setShared(KEY, step.mem);
  if (step.restore) {
    h.setShared("tasks.thread", step.restore.thread);
    h.run("layout.select", { stack: STACK, child: THREAD });
    if (find(tree, BODY)) h.run("layout.select", { stack: BODY, child: step.restore.view });
  } else if (step.list) {
    h.run("layout.select", { stack: STACK, child: LIST });
  }
  return Boolean(step.restore || step.list);
}
