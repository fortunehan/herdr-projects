// Shared core: the source is core/chat-focus.js; bin/sync-shared copies it into mods/chat/core/. Edit it here.
// Cmd+Shift+L (SHEP-15): which chat's message box gets the keyboard. The chat itself keeps the keyboard off its box
// over a text selection (mods/chat refocus(), SHEP-192) and lets the request override that.
// Plain JS: no herdr, node or DOM.

/**
 * Which chat's message box Cmd+Shift+L gives the keyboard (SHEP-15; mods/tabs-tasks acts on it, the chat named takes
 * it from shared "chat.composereq"). The chat last typed or clicked in, while it is on screen; else the focused chat
 * pane; else the space's Assistant when its chat shows; else any chat in the shown tab; else a task's chat open in the
 * Tasks panel; else the space's Assistant, wherever it is; else a new Assistant for the space.
 * holder: shared "keyboard.holder"'s who (a chat's pane, "thread", "tasks"...); focused: the focused pane; shown: the
 * chat panes in the shown tab; thread: the Tasks panel shows a task's chat; assistant: the space's Assistant pane
 * (its chat's, else its terminal's; null: the space has none); space: a space is shown.
 * -> "thread", a pane, "new", or null (nothing to do).
 */
export function composeTarget({ holder = null, focused = null, shown = [], thread = false, assistant = null, space = true } = {}) {
  if (holder === "thread" && thread) return "thread";
  if (holder && shown.includes(holder)) return holder;
  if (focused && shown.includes(focused)) return focused;
  if (assistant && shown.includes(assistant)) return assistant;
  if (shown.length) return shown[0];
  if (thread) return "thread";
  if (assistant) return assistant;
  return space ? "new" : null;
}
