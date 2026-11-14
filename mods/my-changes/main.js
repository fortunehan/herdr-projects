// Herdr's Changes with a choice of what to compare against: uncommitted (Herdr's), the repo's
// base, or any branch or ref. Against a ref it diffs the working tree from the merge base, so
// it shows the branch's commits plus what isn't committed yet, new files included.
// While a task is open in the Tasks panel it shows that task's folder (its worktree) in Base mode against the task's
// own base, labelled with its ref; back to the list, the space's folder and the person's own mode again (SHEP-21,
// core/changes-follow.js decides which).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, shared, setShared, layout, openOverlay } from "herdr";
import { target as followTarget, taskOpen, modeFor, goneLine } from "./core/changes-follow.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const MODES = [["uncommitted", "Uncommitted"], ["base", "Base"], ["ref", "Branch"]];
const STORE = "my-changes.target";

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

const verified = async (git, ref) => (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0;

/** The repo's base: git config herdr.base (as Shepherdr's tasks read it), else origin's default branch. */
async function baseRef(git) {
  const configured = (await git(["config", "--get", "herdr.base"])).stdout?.trim();
  const remote = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).stdout?.trim();
  const tries = configured ? [configured, `origin/${configured}`] : [];
  for (const ref of [...tries, remote, "origin/main", "origin/master", "main", "master"].filter(Boolean))
    if (await verified(git, ref)) return ref;
  return null;
}

/** A task's own base (its record's), as a local branch or origin's; null when neither is here. */
async function taskBase(git, base) {
  for (const ref of [base, `origin/${base}`]) if (!ref.startsWith("-") && await verified(git, ref)) return ref;
  return null;
}

/** The current branch's upstream (`origin/feature`), or null when it has none or HEAD is detached. */
async function upstreamRef(git) {
  const r = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE) ?? "{}"); } catch {}
    // The person's own mode (saved) and, while a task shows, the task view's (not saved): this.mode is the shown one.
    this.personMode = MODES.some(([m]) => m === saved.mode) ? saved.mode : "uncommitted";
    this.mode = this.personMode;
    this.taskView = { key: null, mode: null };
    this.ref = saved.ref ?? "";
    this.place();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refInput = InputState.new({ placeholder: "Upstream · or a branch or ref, then Enter", value: this.ref });
    this.refInput.on("submit", (_e, cx) => this.target("ref", this.refInput.value().trim(), cx));
    this.refInput.on("focus", (_e, cx) => { this.typingRef = true; cx.notify(); });
    this.refInput.on("blur", (_e, cx) => { this.typingRef = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  /** What to show now (the open task's folder, else the space's) and in which mode: read from shared state each time. */
  place() {
    const t = followTarget({ open: taskOpen(layout()), thread: shared("tasks.thread") ?? null,
      where: shared("tasks.thread.where") ?? null, space: location() });
    const m = modeFor(t, this.personMode, this.taskView);
    this.taskView = { key: m.key, mode: m.taskMode };
    this.mode = m.mode;
    this.follow = t;
    return t;
  }

  key() {
    const { cwd, on, task, base, pending } = this.place();
    return JSON.stringify({ cwd, on, task, base, pending, mode: this.mode, ref: this.mode === "ref" ? this.ref : null });
  }

  reviewTarget() {
    return { ...this.follow, mode: this.mode, ref: this.mode === "ref" ? this.ref : "", retained: Boolean(this.against?.tip || this.quiet),
      pending: Boolean(this.loading || this.follow?.pending), workspace: spaces().find((s) => s.active)?.id };
  }

  review(cx) {
    const target = this.reviewTarget();
    setShared("changes.review.target", target);
    openOverlay({ mod: "changes-review", kind: "dialog", width: 720, height: 780, props: { target } });
    cx.notify();
  }

  target(mode, ref, cx) {
    this.mode = mode;
    if (this.follow?.follow) this.taskView = { ...this.taskView, mode };
    else this.personMode = mode;
    if (ref !== undefined) this.ref = ref;
    localStorage.setItem(STORE, JSON.stringify({ mode: this.personMode, ref: this.ref }));
    // A refresh for the old target may still run: it sees the key changed and drops its result.
    this.loading = false;
    this.refresh(cx);
    cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    // One loop per watch: going back to a folder whose old loop still waits must not leave two refreshing it.
    const gen = this.watchGen = (this.watchGen ?? 0) + 1;
    cx.spawn(async (cx) => {
      try {
        while (this.watchGen === gen) {
          await watchFolder(root);
          if (this.watchGen === gen) this.refresh(cx);
        }
      } catch { if (this.watchGen === gen) this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const context = this.key(), t = this.follow, { cwd, on } = t;
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null; this.against = null; this.quiet = null;
      this.setLines([]); this.error = null; this.note = null; this.watched = null; this.watchGen = (this.watchGen ?? 0) + 1;
      this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true; this.loadingKey = context;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => ({ code: 1 }));
        if (this.key() !== context) return;
        let root = top.code === 0 ? top.stdout.trim() : null, tip = null;
        // A finished task's worktree is gone: its branch against its base from its list's folder while the branch is
        // there, else a quiet line (no error: nothing is wrong).
        if (!root && t.follow) {
          const repo = t.repo ? await exec("git", ["rev-parse", "--show-toplevel"], { cwd: t.repo, on }).catch(() => ({ code: 1 })) : { code: 1 };
          const kept = repo.code === 0 && t.branch && !t.branch.startsWith("-")
            && (await exec("git", [...READ, "rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`], { cwd: repo.stdout.trim(), on })).code === 0;
          if (this.key() !== context) return;
          this.quiet = goneLine(t.task, kept ? t.branch : null);
          if (!kept) { this.root = null; this.files = []; this.setLines([]); this.open = null; return; }
          root = repo.stdout.trim(); tip = t.branch;
        }
        if (!root) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const { files, total, against } = this.mode === "uncommitted" && !tip ? await this.uncommitted(git, head.code === 0) : await this.versus(git, head.code === 0, tip);
        if (this.key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.against = against;
        this.files = files; this.limited = total > files.length; this.error = null;
        if (!tip) this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (this.key() === context) { this.files = []; this.setLines([]); this.open = null; this.error = e?.message ?? String(e); } }
      finally { if (this.loadingKey === context) this.loading = false; cx.notify(); }
    });
  }

  /** Herdr's own list: what isn't committed, against HEAD. */
  async uncommitted(git, hasHead) {
    const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(status.stderr);
    const stats = {};
    const results = hasHead ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
    for (const result of results) {
      if (result.code !== 0) throw new Error(result.stderr);
      for (const entry of result.stdout.split("\0")) {
        const [a, d, ...parts] = entry.split("\t");
        if (!parts.length) continue;
        const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
        stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
      }
    }
    const entries = status.stdout.split("\0").filter(Boolean), files = [];
    for (const entry of entries.slice(0, 1000)) {
      const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
      const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
      const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
      files.push({ path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) });
    }
    return { files, total: entries.length, against: null };
  }

  /** Against the base or a ref: the working tree from their merge base, untracked files included. With a tip (a gone
   * worktree's branch): that branch's commits from the merge base, nothing else. A task shown uses its own base. */
  async versus(git, hasHead, tip = null) {
    if (!hasHead) throw new Error("No commits yet");
    const base = this.follow?.follow && this.follow.base ? async () => await taskBase(git, this.follow.base) ?? baseRef(git) : () => baseRef(git);
    // Branch with nothing typed compares with the current branch's upstream.
    const label = this.mode === "base" || tip ? await base() : this.ref || await upstreamRef(git);
    if (!label) throw new Error(this.mode === "base" ? "No base found: set git config herdr.base" : "No upstream for this branch: type a branch or ref above");
    if (label.startsWith("-") || !(await verified(git, label))) throw new Error(`Unknown branch or ref: ${label}`);
    const mb = await git(["merge-base", tip ?? "HEAD", label]);
    if (mb.code !== 0) throw new Error(`No common history with ${label}`);
    const rev = mb.stdout.trim(), to = tip ? [tip] : [];
    const [names, nums, fresh] = await Promise.all([
      git(["diff", rev, ...to, "--name-status", "-z", "--no-renames"]),
      git(["diff", rev, ...to, "--numstat", "-z", "--no-renames"]),
      tip ? { code: 0, stdout: "" } : git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    for (const r of [names, nums, fresh]) if (r.code !== 0) throw new Error(r.stderr);
    const stats = {};
    for (const entry of nums.stdout.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (parts.length) stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
    }
    const all = [], parts = names.stdout.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const xy = parts[i], path = parts[i + 1];
      const s = xy.startsWith("U") ? "U" : xy.startsWith("D") ? "D" : xy.startsWith("A") ? "A" : "M";
      all.push({ path, status: s, fresh: false, ...(stats[path] ?? { add: 0, del: 0 }) });
    }
    for (const path of fresh.stdout.split("\0").filter(Boolean)) all.push({ path, status: "A", fresh: true, add: 0, del: 0 });
    all.sort((a, b) => a.path.localeCompare(b.path));
    return { files: all.slice(0, 1000), total: all.length, against: { rev, label, short: rev.slice(0, 7), tip } };
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const from = this.against ? [this.against.rev, ...(this.against.tip ? [this.against.tip] : [])] : this.hasHead ? ["HEAD"] : [];
      const r = await exec("git", [...READ, "diff", ...from, "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (this.key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.against?.tip || this.busy || this.loading || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (this.key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  modes(t) {
    return h_flex().flex_none().px(10).py(6).gap(6).items_center().border_b(1).border_color(t.border).text_size(11)
      .child(h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.raised).children(MODES.map(([mode, label]) =>
        div().id(`mode-${mode}`).px(8).py(2).rounded(5).cursor_pointer()
          .when(this.mode === mode, (e) => e.bg(t.background).text_color(t.foreground))
          .when(this.mode !== mode, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
          .on_click((_e, cx) => { if (this.mode !== mode) this.target(mode, undefined, cx); })
          .child(label))))
      .when(this.mode === "ref", (e) => e.child(div().id("ref-input").flex_1().min_w(0).h(24).px(8).flex().items_center().rounded(6).border_1()
        .border_color(this.typingRef ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.refInput).h_full().text_size(11).text_color(t.foreground))))
      .when(this.mode !== "ref", (e) => e.child(div().flex_1()))
      .when(Boolean(this.against), (e) => e.child(div().flex_none().max_w(220).truncate().text_color(t.dim)
        .child(`vs ${this.against.label} @ ${this.against.short}`)));
  }

  render(cx) {
    if (this.key() !== this.context) this.refresh(cx);
    const reviewTarget = this.reviewTarget(), reviewKey = JSON.stringify(reviewTarget);
    if (this.reviewKey !== reviewKey) {
      this.reviewKey = reviewKey;
      cx.timer.after(0, () => setShared("changes.review.target", reviewTarget));
    }
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.against?.tip && !this.busy && !this.loading);
    const t0 = this.follow;
    const empty = this.error || this.quiet || (this.loading || t0?.pending ? "Loading changes…" : !this.root ? "No folder" : this.against ? `No changes against ${this.against.label}` : "No uncommitted changes");
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && (this.typing || this.typingRef)) { this.typing = this.typingRef = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .when(Boolean(t0?.follow), (e) => e.child(div().id("follows").max_w(120).truncate().px(5).py(1).rounded(4).bg(t.raised)
          .text_size(10).text_color(t.accent).child(t0.task ?? "Task")))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1())
        .child(div().id("changes-review").px(9).py(4).rounded(6).bg(t.raised).cursor_pointer().text_size(12)
          .on_click((_e, cx) => this.review(cx)).child("Review"))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(this.modes(t))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty))))
      .when(Boolean(this.quiet && this.files.length), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(this.quiet)))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
