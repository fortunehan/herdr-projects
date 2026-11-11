// A task's Shell (SHEP-25): a plain shell in the task's worktree (its list's folder for a --here task), for the
// person's own commands (npm run dev) while the task's agent keeps its own Terminal. A child of the Tasks panel's
// task view body stack, laid out as the Browser is (mods/task-browser): a column ("tasks-thread-shell") of this
// mod's block ("-host", what's going on while no shell shows) and, once one runs, a layout terminal block ("-view")
// pointed at it in the layout's file (mods/chat/panel.js pointTerm).
// One shell per task, started the first time its Shell view shows (hc run --bg, the machine's own shell, no
// parent) and found again by its labels: herdr.task-shell=<the task's herdr.task key> and herdr.shell=task. It
// outlives this view, so switching tasks or views keeps it (and a dev server in it) running. It never carries
// herdr.task: it is none of the task's agents. herdr-task ends it when the task becomes Done or its worktree goes
// (herdr_task/shells.py). One the person exited is replaced by a new one the next time the view shows.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { exec, hc, run, theme, terminals, appHome, shared, layout, readTextFile, writeTextFile } from "herdr";
import { shown, where, SHELL } from "./taskwhere.js";
import { button } from "./ui.js";

const HOST = "tasks-thread-shell-host", VIEW = "tasks-thread-shell-view";
const BEAT_MS = 1500;

export const machineOf = (addr) => (String(addr).includes("/") ? String(addr).split("/")[0] : null);

/** The task's live shell among the core's terminals (on the task's machine), or null. */
export function shellOf(list, key, machine) {
  return (list ?? []).find((k) => k.state === "live" && k.labels?.["herdr.task-shell"] === key
    && machineOf(k.address) === (machine ?? null)) ?? null;
}

/** The shown task's shell: { key, folder, machine }, or { why } there's none to show (why null: nothing yet). */
export function target(w, thread) {
  if (!thread) return { why: "Pick a task to use its shell." };
  if (!w) return { why: null };
  if (w.state === "done") return { why: "This task is done: its shell has ended." };
  if (!w.key || !w.folder) return { why: "This task has no folder yet." };
  return { key: w.key, folder: w.folder, machine: w.machine ?? null };
}

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
}

/** The Shell column as it should be: the shell's terminal shown (addr), or this mod alone. */
export function arrange(tree, addr) {
  const col = find(tree, SHELL);
  if (!col) throw new Error("This layout has no task shell.");
  const host = { id: HOST, type: "block", size: { weight: 1 }, content: { mod: "task-shell" }, ...(addr ? { hidden: true } : {}) };
  col.type = "column";
  delete col.content;
  col.children = addr ? [host, { id: VIEW, type: "block", content: { terminal: addr } }] : [host];
}

// One edit of the layout's file, only if it's unchanged since read (else read again); then Herdr reads it.
async function pointView(addr, cx) {
  const path = `${appHome()}/layouts/${shared("layout")}.json`;
  for (let i = 0; ; i++) {
    const text = await readTextFile(path);
    const tree = JSON.parse(text ?? "null");
    if ((find(tree, VIEW)?.content?.terminal ?? null) === (addr ?? null) && find(tree, SHELL)?.type === "column") break;
    arrange(tree, addr);
    try { await writeTextFile(path, JSON.stringify(tree, null, 2), text); break; }
    catch (e) { if (i >= 2) throw e; }
  }
  for (let i = 0; i < 30 && (find(layout(), VIEW)?.content?.terminal ?? null) !== (addr ?? null); i++) await new Promise((r) => cx.timer.after(100, () => r()));
}

export default class TaskShell extends View {
  init(_props, cx) {
    this.key = null;        // the task whose shell the view shows (or is starting)
    this.addr = null;       // that shell's terminal
    this.state = "idle";    // idle | starting | live | ended | error
    this.why = "";
    this.busy = false;
    this.was = false;       // shown at the last tick
    this.failedAt = 0;
    cx.timer.every(BEAT_MS, (cx) => this.tick(cx));
  }

  // Every BEAT_MS, and at once when it shows: the shown task's shell in the view, started if it has none. Hidden,
  // nothing changes (the shell keeps running).
  tick(cx) {
    const on = shown(SHELL), fresh = on && !this.was;
    this.was = on;
    if (!on || this.busy) return;
    const tg = target(where(), shared("tasks.thread"));
    if (!tg.key) {
      if (tg.why !== null && (this.state !== "idle" || this.why !== tg.why)) {
        this.state = "idle";
        this.why = tg.why;
        this.key = null;
        // Also one left pointed at from before this copy (a reload): a Done task's ended shell isn't shown.
        if (this.addr || find(layout(), VIEW)) { this.addr = null; this.repoint(null, cx); }
        cx.notify();
      }
      return;
    }
    const live = shellOf(terminals(), tg.key, tg.machine);
    if (live) {
      const again = this.addr !== live.address || (find(layout(), VIEW)?.content?.terminal ?? null) !== live.address;
      this.key = tg.key;
      this.addr = live.address;
      if (this.state !== "live") { this.state = "live"; this.why = ""; cx.notify(); }
      if (again) this.repoint(live.address, cx, true);
      else if (fresh) run("pane.focus", { terminal: live.address });
      return;
    }
    // The person exited it (or it was ended): the view says so until it shows again or they ask for a new one.
    if (this.key === tg.key && this.state === "live") {
      const gone = this.addr;
      this.addr = null;
      this.state = "ended";
      this.why = "The shell ended.";
      if (gone) hc(["rm", gone]).catch(() => {});
      this.repoint(null, cx);
      cx.notify();
      return;
    }
    if (this.key === tg.key && this.state === "ended" && !fresh) return;
    if (fresh || this.key !== tg.key || Date.now() - this.failedAt > 10000) this.start(tg, cx);
  }

  repoint(addr, cx, focus) {
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await pointView(addr, cx);
        if (focus && addr) run("pane.focus", { terminal: addr });
      } catch (e) {
        this.state = "error";
        this.why = String(e?.message ?? e);
        this.failedAt = Date.now();
      }
      this.busy = false;
      cx.notify();
    });
  }

  start(tg, cx) {
    this.busy = true;
    this.key = tg.key;
    this.state = "starting";
    this.why = "";
    const old = this.addr || find(layout(), VIEW);
    this.addr = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // Another task's shell isn't shown meanwhile.
        if (old) await pointView(null, cx);
        const on = tg.machine ? { on: tg.machine } : {};
        const there = await exec("test", ["-d", tg.folder], on).catch(() => null);
        if (there?.code !== 0) throw new Error(`Its folder isn't there: ${tg.folder}`);
        const r = await hc(["run", "--bg", "--json", ...(tg.machine ? ["--on", tg.machine] : []), "--cwd", tg.folder, "--no-parent",
          "--label", `herdr.task-shell=${tg.key}`, "--label", "herdr.shell=task"]);
        let addr = JSON.parse(r.stdout || "{}")?.address;
        if (r.code !== 0 || !addr) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || "The shell didn't start.");
        if (tg.machine && !addr.includes("/")) addr = `${tg.machine}/${addr}`;
        this.addr = addr;
        await pointView(addr, cx);
        this.state = "live";
        run("pane.focus", { terminal: addr });
      } catch (e) {
        this.state = "error";
        this.why = String(e?.message ?? e);
        this.failedAt = Date.now();
        await pointView(null, cx).catch(() => {});
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    // Shown now: it looks at once rather than at the next tick.
    if (shown(SHELL) !== this.was && !this.kick) {
      this.kick = true;
      cx.timer.after(0, (cx) => { this.kick = false; this.tick(cx); });
    }
    const line = this.state === "starting" ? "Starting the shell…" : this.why || "Opening…";
    const tg = this.state === "ended" ? target(where(), shared("tasks.thread")) : null;
    return v_flex().id("task-shell").size_full().min_h(0).items_center().justify_center().px(24).gap(10)
      .bg(t.background).text_size(12.5).text_color(t.dim)
      .child(div().text_center().max_w(380).child(line))
      .when(Boolean(tg?.key), (el) => el.child(button("task-shell-new", "New shell", { onClick: (_e, cx) => this.start(tg, cx) })));
  }
}
