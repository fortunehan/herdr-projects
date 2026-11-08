// Shared core: the source is core/chat-resize.js; bin/sync-shared copies it into mods/chat/core/. Edit it here.
// The window's chat list while its pane is dragged wider or narrower (SHEP-7). Its rows are placed by heights measured
// at one width; laying them all out again on every pixel of a drag forgot every height (rows fell back to estimates
// from their words, then snapped to the real ones) and remounted every message, each frame. Now they are laid out
// again once the width settles, or after a big move, and keep their last heights until measured anew.
// Plain JS: no herdr, node or DOM.

/** How long the width stays put (ms) before the rows are laid out at it. */
export const SETTLE_MS = 150;
/** How far (px) a drag moves the width from the laid-out one before the rows are laid out again mid-drag. */
export const STEP = 120;

/** The list's live width and the one its rows were last laid out at. */
export class ListWidth {
  constructor() {
    this.live = 0;
    this.laid = 0;
    this.changedAt = 0;
  }

  /** The pane's width now, at `now` (ms). */
  note(width, now) {
    if (Math.abs(width - this.live) > 1) { this.live = width; this.changedAt = now; }
  }

  /** True when the rows should be laid out at the live width now (it becomes the laid-out one). */
  relayout(now) {
    const off = Math.abs(this.live - this.laid);
    if (off <= 1) return false;
    if (this.laid && off < STEP && now - this.changedAt < SETTLE_MS) return false;
    this.laid = this.live;
    return true;
  }

  /** Milliseconds until relayout() could say yes without another change, or null when nothing waits. */
  wait(now) {
    if (Math.abs(this.live - this.laid) <= 1) return null;
    return Math.max(0, SETTLE_MS - (now - this.changedAt));
  }
}

/** Last known heights to fall back on while rows are measured again: `heights` over `prev`, only for `keys`. */
export function carry(prev, heights, keys) {
  const out = new Map();
  for (const k of keys) {
    const h = heights.get(k) ?? prev.get(k);
    if (h != null) out.set(k, h);
  }
  return out;
}

/**
 * The row to keep in place while rows above it change height: of the first row on screen (`start`) and the next, the
 * one whose top is nearer the scroll position.
 */
export function anchorRow(sizes, start, scrollTop) {
  if (!sizes.length) return -1;
  const i = Math.max(0, Math.min(start, sizes.length - 1));
  let top = 0;
  for (let k = 0; k < i; k++) top += sizes[k];
  if (i + 1 >= sizes.length) return i;
  return scrollTop - top <= top + sizes[i] - scrollTop ? i : i + 1;
}
