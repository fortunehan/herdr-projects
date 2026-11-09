// Shared core: the source is core/thread-bind.js; bin/sync-shared copies it into mods/chat/core/. Edit it here.
// Which agent the Tasks panel's task chat shows (mods/chat/panel.js, SHEP-16). The header names the task in shared
// "tasks.thread"; the body draws a nested Chat made for one terminal. The body used to set a "swapping" latch in render,
// leave the swap to a timer, and draw whichever Chat it had: a swap that never ran or failed part-way (a render Herdr
// stopped, release() throwing) kept the latch on for good, so the previous task's chat (its log, its question cards)
// stayed under the next task's header, answers included. Now the body draws a Chat only for the task the header names,
// a swap that hasn't started in RETRY_MS is asked for again, and the swap reads what to show when it runs.
// A Resume or model switch that ends after the person opened another task leaves that task alone (followed()).
// Plain JS: no herdr, node or DOM.

/** How long (ms) a swap asked for in render may take to start before render asks again. */
export const RETRY_MS = 1500;
/** How long (ms) a swap may run (closing the old Chat) before another may start instead. */
export const STUCK_MS = 10000;

/** Which task a "tasks.thread" names: its agent's terminal, else its key (one never started); null for none. */
export function threadId(w) {
  if (!w) return null;
  if (w.terminal) return `t:${w.terminal}`;
  return w.key ? `k:${w.key.machine ?? ""}:${w.key.slug}#${w.key.id}` : null;
}

/** The same task in two "tasks.thread" values: by its key when both have one, else by its id and terminal. */
export function sameTask(a, b) {
  if (!a || !b) return false;
  const k = (w) => (w.key ? `${w.key.machine ?? ""}:${w.key.slug}#${w.key.id}` : null);
  if (k(a) && k(b)) return k(a) === k(b);
  return (a.task ?? null) === (b.task ?? null) && (a.terminal ?? null) === (b.terminal ?? null);
}

/** The body's binding: which "tasks.thread" its Chat was made for, and the swap under way. */
export class ThreadBinding {
  constructor() {
    this.cur = null;
    this.asked = null;
    // The swap under way: { n, at }; a later one makes an older one stale (one stuck past STUCK_MS is given up).
    this.run = null;
    this.n = 0;
  }

  /** For render: whether the Chat it has may show (made for this task), and whether to ask for a swap now. */
  plan(want, now) {
    const show = threadId(want) === threadId(this.cur);
    const busy = this.run && now - this.run.at < STUCK_MS;
    const fresh = this.asked && this.asked.id === threadId(want) && now - this.asked.at < RETRY_MS;
    const ask = !show && !busy && !fresh;
    if (ask) this.asked = { id: threadId(want), at: now };
    return { show, ask };
  }

  /** A swap starts at `now`: its token, or null while another runs (that one picks up the newest want). */
  begin(now) {
    if (this.run && now - this.run.at < STUCK_MS) return null;
    this.run = { n: ++this.n, at: now };
    return this.run.n;
  }

  /** Whether the swap with this token is still the one under way (else it must change nothing). */
  current(token) {
    return this.run?.n === token;
  }

  /** The swap made its Chat for `want` (null: none), or failed at `now` (the old one is gone either way): asked again
   * after RETRY_MS, not on every render. False for a stale swap, which changes nothing. */
  end(token, want, made, now) {
    if (!this.current(token)) return false;
    this.cur = made ? want ?? null : null;
    this.run = null;
    this.asked = made ? null : { id: threadId(want), at: now };
    return true;
  }
}

/**
 * What "tasks.thread" becomes once a Resume or model switch started `addr` for the task shown as `before`: the same
 * task with its new agent while it is still the one shown (`now`), else null (the person opened another task meanwhile:
 * leave theirs as it is).
 */
export function followed(now, before, addr, at) {
  if (!addr || !sameTask(now, before)) return null;
  return { ...now, terminal: addr, log: null, note: null, at };
}
