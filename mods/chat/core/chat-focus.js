// Shared core: the source is core/chat-focus.js; bin/sync-shared copies it into mods/chat/core/. Edit it here.
// When the window's chat may put the keyboard back in its message box (SHEP-14). It did so on every render more than
// 1.5 s after the last press, and a working agent renders the chat each second: a drag selecting a message's text that
// lasted longer, or the Cmd+C after it, found the box focused and the selection gone. The pane just getting focus did
// the same 600 ms after a press that both focused the pane and started a selection. Now a press that is still held, or
// that left text selected (a drag, a double or triple click), keeps the keyboard where it is until the next press, or
// until the person goes to another pane and comes back.
// Plain JS: no herdr, node or DOM.

/** How long after a plain press in the chat (ms) the box isn't given the keyboard back. */
export const QUIET_MS = 1500;
/** How far (px) the pointer moves between press and release before it counts as a drag that selects. */
export const DRAG_PX = 4;
/** How long after its press (ms) a selection is let go once the chat's pane loses focus. */
export const LEAVE_MS = 1000;

/** The last left press in the chat, as far as the keyboard goes. Positions are window points { x, y }. */
export class TextPress {
  constructor() {
    this.at = 0;
    this.from = null;
    this.held = false;
    this.selects = false;
  }

  /** A press at `pos`, the `clicks`th of its sequence, at `now`. */
  down(pos, clicks, now) {
    this.at = now;
    this.from = pos ?? null;
    this.held = true;
    this.selects = (clicks ?? 1) >= 2;
  }

  /** Its release at `pos` (inside the chat). True when that changed anything. */
  up(pos) {
    if (!this.held) return false;
    this.held = false;
    const a = this.from, b = pos;
    if (a && b && Math.hypot(b.x - a.x, b.y - a.y) > DRAG_PX) this.selects = true;
    return true;
  }

  /** The chat's pane is not focused at `now`: a selection made a while ago no longer holds the keyboard. */
  leftPane(now) {
    if (!this.held && now - this.at > LEAVE_MS) this.selects = false;
  }

  /** The person is selecting text in the chat, or has just selected some. */
  get selecting() {
    return this.held || this.selects;
  }

  /** The pane just got focus: the box may take the keyboard. */
  mayTake() {
    return !this.selecting;
  }

  /** The pane is focused but the box lost the keyboard: it may take it back at `now`. */
  mayRefocus(now) {
    return !this.selecting && now - this.at > QUIET_MS;
  }
}
