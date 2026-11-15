/** Bounded, versioned cross-mod dialog launch. No review, delivery or repair commands are exposed. */
export const REVIEW_BRIDGE = "changes.review.bridge";
export const REVIEW_RESULTS = "changes.review.launch-results";
export const REVIEW_COMMAND = "review-open:";
const AGE = 10000;
const text = (v) => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\0\r\n]/.test(v);
const localId = (v) => text(v) && !v.includes("/");
const oid = (v) => v === null || typeof v === "string" && /^[a-f0-9]{40,64}$/.test(v);
const fail = (message) => { throw new Error(message); };
const fields = (v, names) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((key) => names.includes(key));

export function launchTarget(r) {
  if (!fields(r, ["version", "id", "bridge", "at", "target"]) || r.version !== 1 || !localId(r.id) || r.id.length > 100) fail("Invalid Review launch request");
  const t = r.target;
  if (!fields(t, ["cwd", "on", "workspace", "tab", "comparison", "head", "baseline", "source", "pending", "retained"])) fail("Invalid Review target fields");
  if (!t || !text(t.cwd) || !t.cwd.startsWith("/") || !localId(t.workspace) || !localId(t.tab)) fail("Review needs an absolute checkout and local workspace/tab");
  if (t.on != null || !fields(t.source, ["address", "pid"]) || !localId(t.source.address)) fail("Review supports local targets and Source sessions only");
  if (!Number.isSafeInteger(t.source.pid) || t.source.pid <= 0) fail("Capture the Source process before opening Review");
  if (t.pending || t.retained) fail("The review target is loading or its worktree is gone");
  const c = t.comparison;
  if (!fields(c, ["mode", "base"]) || !["uncommitted", "base", "branch"].includes(c.mode)) fail("Unsupported comparison: choose Uncommitted, Base or Branch");
  if (c.mode !== "uncommitted" && (!text(c.base) || c.base.startsWith("-"))) fail("Capture the actual comparison ref before opening Review");
  if (!oid(t.head) || !oid(t.baseline) || t.head === undefined || t.baseline === undefined) fail("Capture the snapshot HEAD and baseline before opening Review");
  /** Annotator's automatic base is already resolved in snapshot.scope.comparison.base. Never infer it again. */
  return { cwd: t.cwd, on: null, workspace: t.workspace, tab: t.tab,
    mode: c.mode === "branch" ? "ref" : c.mode, ref: c.mode === "uncommitted" ? "" : c.base };
}

export class ReviewLaunchBridge {
  constructor(io) { this.io = io; this.instance = io.token(); this.seen = new Map(); this.busy = false; }
  announce() {
    const value = { version: 1, instance: this.instance, expires: this.io.now() + AGE,
      command: `tabs-tasks.${REVIEW_COMMAND}`, results: REVIEW_RESULTS };
    this.io.write(REVIEW_BRIDGE, value);
    return value;
  }
  async handle(command) {
    if (!command.startsWith(REVIEW_COMMAND)) return false;
    let r;
    try {
      if (command.length > 16000) fail("Review launch request is too large");
      r = JSON.parse(decodeURIComponent(command.slice(REVIEW_COMMAND.length)));
      launchTarget(r);
    } catch (e) { return this.result(r?.id, "error", String(e?.message ?? e)); }
    const now = this.io.now();
    for (const [id, entry] of this.seen) if (now - entry.at > AGE * 3 && entry.done) this.seen.delete(id);
    const previous = this.seen.get(r.id), key = JSON.stringify(r);
    if (previous) {
      if (previous.key !== key) return this.result(r.id, "error", "Review request id was reused for a different target");
      return previous.job;
    }
    if (r.bridge !== this.instance || !Number.isFinite(r.at) || now - r.at > AGE || r.at > now + 1000)
      return this.result(r.id, "error", "Review bridge changed or request expired; click AI Review again");
    if (this.busy || this.seen.size >= 64) return this.result(r.id, "error", "Review dialog is already opening; try again");
    this.busy = true;
    const entry = { key, at: now, done: false };
    this.seen.set(r.id, entry);
    entry.job = (async () => {
      try {
        const target = await this.io.bind(launchTarget(r), r.target);
        if (this.io.now() - r.at > AGE) fail("Review request expired while binding its target; try again");
        const overlay = this.io.open(target);
        return this.result(r.id, "opened", null, overlay);
      } catch (e) { return this.result(r.id, "error", String(e?.message ?? e)); }
      finally { this.busy = false; entry.done = true; }
    })();
    return entry.job;
  }
  result(id, status, error = null, overlay = null) {
    const result = { id: localId(id) ? id : null, status, error, overlay, at: this.io.now() };
    const old = this.io.read(REVIEW_RESULTS);
    this.io.write(REVIEW_RESULTS, [...(Array.isArray(old) ? old : []).filter((r) => r.id !== result.id), result].slice(-16));
    return result;
  }
}
