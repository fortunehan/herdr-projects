import { exec, hc, writeTextFile, openOverlay, shared, setShared } from "herdr";
import { panes, terminals, spaces } from "./live.js";
import * as fs from "fs/promises";
import { dirsReady } from "./dirs.js";
import { DEFAULTS, menuFor, parseDefaults, sessionOf } from "./core/agents.js";
import { FIND, Conversation } from "./core/chat-log.js";
import { CLEAN_ENV, AGENT_PATH } from "./core/clean-env.js";
import { chatPane } from "./core/spaces.js";
import { ChangesReview, completedMessage, sourceMessages, finished, reportText, sourceKey } from "./core/changes-review.js";
import { capture } from "./core/review-target.js";
import { ReviewLaunchBridge } from "./core/review-launch.js";

function sourceInTab(address, workspace, tab) {
  const space = spaces().find((s) => s.id === workspace && !s.machine && s.tabs.some((t) => t.id === tab));
  const terminal = terminals().find((t) => t.address === address);
  return Boolean(space && terminal && panes().some((p) => p.tab === tab
    && (p.terminal === address || p.mod === "chat" && p.pane === chatPane(terminal))));
}

/** Resolve only the producer's clicked target and process; focused/global Changes state is never consulted. */
export async function bindReviewLaunch(input, clicked) {
  if (!sourceInTab(clicked.source.address, input.workspace, input.tab)) throw new Error("The selected Source tab or workspace is unavailable");
  const observed = await capture({ exec }, input);
  if (observed.head !== clicked.head || (input.mode === "uncommitted" ? observed.head : observed.base) !== clicked.baseline)
    throw new Error("The Annotator comparison changed; refresh Changes before opening Review");
  const terminal = terminals().find((t) => t.address === clicked.source.address);
  const source = terminal && await liveSource(terminal, observed.root);
  if (!source || source.pid !== clicked.source.pid || !sourceInTab(source.address, input.workspace, input.tab) || !await sameSource(source))
    throw new Error("The selected Source conversation changed or does not match this checkout");
  return { ...input, task: source.task, binding: source,
    expected: { root: observed.root, gitdir: observed.gitdir, head: observed.head, base: observed.base, resolvedRef: observed.resolvedRef } };
}

let launchBridge;
/** Only the tab host starts the launcher; report/storage consumers need no bridge instance. */
export function reviewLauncher() {
  return launchBridge ??= new ReviewLaunchBridge({
    now: () => Date.now(), token: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    read: shared, write: setShared, bind: bindReviewLaunch,
    open: (target) => openOverlay({ mod: "changes-review", kind: "dialog", width: 720, height: 780, props: { target, bound: true } }),
  });
}

const PROBE = String.raw`
import json, mmap, os, shutil, subprocess
from pathlib import Path
home = Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude')))
folders = [home] + [p / '.claude' for p in [Path.cwd(), *Path.cwd().parents]]
if any((p / 'skills/code-review/SKILL.md').exists() or (p / 'commands/code-review.md').exists() for p in folders):
    raise ValueError('A custom code-review command or skill prevents verification of the bundled skill')
binary = shutil.which('claude')
if not binary: raise ValueError('Claude Code CLI is missing')
r = subprocess.run([binary, '--help'], capture_output=True, text=True, timeout=20)
if r.returncode or any(f not in r.stdout for f in ['--effort', '--permission-mode', '--session-id', '--append-system-prompt']): raise ValueError('This Claude Code CLI does not support the required launch settings')
try:
    with open(os.path.realpath(binary), 'rb') as f:
        with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as data:
            bundled = all(data.find(s) >= 0 for s in [b'code-review', b'ReportFindings', b'--max-findings'])
except (OSError, ValueError): bundled = False
if not bundled: raise ValueError('The required bundled code-review skill could not be verified in this CLI installation')
print(json.dumps({'ok': True}))
`;

let base;
const ready = async () => base ??= (await dirsReady()).reviews;
const recordPath = async (id) => `${await ready()}/${id}.json`;
const valid = (id) => /^review-[a-z0-9-]+$/.test(id);
/** Native fs omits code and names paths relative to the granted read root.
 * https://github.com/herdrdev/herdr-app/blob/v0.1.15/vendor/gpui-kit/crates/shell/src/engine/quickjs/host.rs#L450
 * https://github.com/herdrdev/herdr-app/blob/v0.1.15/vendor/gpui-kit/crates/shell/src/capability.rs#L459
 */
const missing = (e, verb, path) => {
  if (e?.code !== undefined) return e.code === "ENOENT";
  const match = /^cannot (read|list) `(.+)`: No such file or directory \(os error 2\)$/.exec(e?.message ?? "");
  return match?.[1] === verb && (match[2] === path
    || (!match[2].startsWith("/") && path.endsWith(`/${match[2]}`)));
};
const snapshots = new WeakMap();
const lockKey = (r) => {
  /** A collision conservatively blocks another launch; it cannot select another recipient. */
  let a = 2166136261, b = 5381;
  for (const c of `${r.target.root}\0${r.source.conversation}`) {
    a = Math.imul(a ^ c.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ c.charCodeAt(0);
  }
  return `${a >>> 0}-${b >>> 0}`;
};
const checked = (r) => {
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Herdr command failed").trim());
  return r;
};
async function app(name, args) {
  const r = checked(await exec("herdr-app", ["do", name, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)])]));
  const out = JSON.parse(r.stdout || "{}");
  if (out.error) throw new Error(out.error);
  return out;
}
async function liveSource(t, root) {
  const kind = ["claude", "claude-code"].includes(t.foreground?.name ?? t.report?.app) ? "claude"
    : (t.foreground?.name ?? t.report?.app) === "codex" ? "codex" : null;
  if (!kind || !t.foreground?.pid || t.state !== "live" || t.address.includes("/") || t.labels?.["herdr.review"]) return null;
  const cwd = t.foreground.cwd ?? t.cwd;
  if (!cwd) return null;
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (r.code !== 0 || await fs.realpath(r.stdout.trim()) !== root) return null;
  const log = checked(await exec("sh", ["-c", FIND, "chat", kind, String(t.foreground.pid)])).stdout.trim().split("\n").pop();
  const conversation = sessionOf(kind, log);
  if (!conversation) return null;
  return { address: t.address, conversation, path: log, pid: t.foreground.pid, root, kind,
    task: t.labels?.["herdr.task"] ?? null, name: t.title || t.address };
}
async function sameSource(source) {
  const r = await hc(["get", source.address, "--json"]);
  if (r.code !== 0) return false;
  const now = await liveSource(JSON.parse(r.stdout), source.root);
  return now && sourceKey(now) === sourceKey(source);
}
async function ownTerminal(r) {
  if (!r.owned?.terminal) return null;
  const result = await hc(["get", r.owned.terminal, "--json"]);
  if (result.code !== 0) return null;
  const t = JSON.parse(result.stdout);
  const argv = t.foreground?.argv ?? t.argv ?? [];
  return t.labels?.["herdr.review"] === r.id && argv.includes(r.session)
    && (!r.reviewerPid || !t.foreground?.pid || t.foreground.pid === r.reviewerPid) ? t : null;
}
async function stop(r) {
  if ((await ownTerminal(r))?.state === "live") checked(await hc(["kill", r.owned.terminal]));
}

const openDialog = (address) => (shared("chat.screens") ?? {})[address]?.at(-1)?.state === "open";
async function conversation(source) {
  const text = await fs.readFile(source.path, "utf8");
  const parsed = new Conversation(source.kind);
  parsed.feed(text.split("\n").flatMap((line, off) => {
    let r; try { r = JSON.parse(line); } catch { return []; }
    if (r.sessionId && r.sessionId !== source.conversation || r.isSidechain) return [];
    return [{ kind: "J", data: line, off }];
  }));
  return parsed;
}
async function reviewerSource(run) {
  const terminal = await ownTerminal(run);
  if (!terminal || terminal.state !== "live" || !terminal.foreground?.pid) return null;
  const found = await exec("sh", ["-c", FIND, "chat", "claude", String(terminal.foreground.pid)]);
  const path = found.stdout.trim().split("\n").pop();
  if (sessionOf("claude", path) !== run.session) return null;
  return { address: run.owned.terminal, path, conversation: run.session, kind: "claude" };
}

const io = {
  exec,
  uuid: () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16); return (c === "x" ? n : n & 3 | 8).toString(16);
  }),
  async catalog() {
    /** DEFAULTS historically masks shell errors; Review explicitly validates discovery before using its parser. */
    const strict = 'f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"; if [ -e "$f" ]; then [ -r "$f" ] || exit 1; command -v jq >/dev/null || exit 1; jq empty "$f" || exit 1; fi;\n';
    const r = checked(await exec("sh", ["-c", strict + DEFAULTS, "defaults", "claude"]));
    const d = parseDefaults("claude", r.stdout);
    return { origin: d.models?.length ? "configured" : "fallback", models: menuFor("claude", d).models };
  },
  async probe(target) {
    const r = await exec("python3", ["-I", "-c", PROBE], { cwd: target.cwd });
    return r.code === 0 ? JSON.parse(r.stdout) : { ok: false, reason: (r.stderr || "The required CLI/skill is unavailable").trim().split("\n").pop() };
  },
  async sources(target) {
    const candidates = target.binding ? terminals().filter((t) => t.address === target.binding.address
      && sourceInTab(t.address, target.workspace, target.tab)) : terminals();
    const found = await Promise.all(candidates.map((t) => liveSource(t, target.root)));
    return found.filter(Boolean);
  },
  async reserve(r) {
    checked(await exec("mkdir", ["-p", "-m", "700", `${await ready()}/locks`]));
    try { await writeTextFile(`${base}/locks/${lockKey(r)}.json`, JSON.stringify({ id: r.id }), null); }
    catch { throw new Error("A Review for this checkout and Source session is already active. Open its retained report"); }
  },
  async release(r) {
    const p = `${await ready()}/locks/${lockKey(r)}.json`;
    if (JSON.parse(await fs.readFile(p, "utf8")).id === r.id) checked(await exec("rm", [p]));
  },
  async save(r) {
    const p = await recordPath(r.id), text = JSON.stringify(r, null, 2);
    await writeTextFile(p, text, snapshots.get(r) ?? null);
    snapshots.set(r, text);
    // Human-readable companion; the JSON record is authoritative for lifecycle and delivery state.
    const md = `${base}/${r.id}.md`;
    let old = null;
    try { old = await fs.readFile(md, "utf8"); } catch (e) { if (!missing(e, "read", md)) throw e; }
    await writeTextFile(md, reportText(r), old);
  },
  async load(id) {
    if (!valid(id)) throw new Error("Invalid Review identity");
    const path = await recordPath(id);
    try {
      const text = await fs.readFile(path, "utf8");
      const record = JSON.parse(text);
      snapshots.set(record, text); return record;
    } catch (e) { if (missing(e, "read", path)) return null; throw e; }
  },
  async open(r, argv) {
    const space = spaces().find((s) => s.id === r.input.workspace && !s.machine);
    if (!space) throw new Error("The current local workspace is unavailable");
    const result = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", r.target.root,
      "--label", `herdr.review=${r.id}`, "--label", "herdr.role=reviewer", "--label", "herdr.agent=claude",
      "--", "sh", "-c", `${CLEAN_ENV} ${AGENT_PATH} exec "$@"`, "review", ...argv]).catch((e) => ({ code: 1, stderr: String(e.message ?? e), stdout: "" }));
    let out = {};
    try { out = JSON.parse(result.stdout); } catch {}
    if (!out.address) {
      const tagged = terminals().filter((t) => t.labels?.["herdr.review"] === r.id);
      if (tagged.length === 1) r.owned = { terminal: tagged[0].address, tab: null, pane: null, space: space.id };
      const error = new Error((result.stderr || "Reviewer launch could not be confirmed").trim());
      error.uncertain = !r.owned;
      throw error;
    }
    r.owned = { terminal: out.address, tab: null, pane: null, space: space.id };
    r.reviewerPid = out.foreground?.pid ?? null;
    await io.save(r);
    checked(result);
    let tab;
    try { tab = await app("tab.new", { space: space.id, name: "Review", mod: "chat", props: { terminal: out.address, review: r.id } }); }
    catch (e) {
      const owner = await ownTerminal(r), pane = owner && panes().find((p) => p.pane === chatPane(owner) && p.mod === "chat");
      if (pane) { r.owned.tab = pane.tab; r.owned.pane = pane.pane; await io.save(r); }
      throw e;
    }
    r.owned.tab = tab.tab;
    r.owned.pane = tab.pane ?? panes().find((p) => p.tab === tab.tab && p.mod === "chat")?.pane;
    await io.save(r);
    if (!r.owned.tab || !r.owned.pane) throw new Error("The reviewer Chat tab was not created");
    await app("tab.select", { id: r.owned.tab });
    return r.owned;
  },
  stop,
  async cleanup(r) {
    const owner = await ownTerminal(r);
    if (!owner) {
      if (r.owned?.terminal) throw new Error("Reviewer ownership changed; its tab was left open");
      return;
    }
    await stop(r);
    const mine = panes().find((p) => p.pane === r.owned?.pane && p.tab === r.owned?.tab && p.mod === "chat");
    if (mine) {
      if ((spaces().find((s) => s.id === r.owned.space)?.tabs.length ?? 0) < 2)
        throw new Error("The reviewer is the workspace's last tab; it was left open to preserve the workspace");
      await app("tab.close", { id: r.owned.tab });
    }
  },
  sameSource,
  async sameReviewer(r) {
    const t = await ownTerminal(r);
    if (!t || t.state !== "live") return !!r.closeRequested && !!t;
    if (r.reviewerPid && t.foreground?.pid !== r.reviewerPid) return false;
    if (r.logPath && !await reviewerSource(r)) return false;
    return true;
  },
  async sourceReady(s) {
    const t = JSON.parse(checked(await hc(["get", s.address, "--json"])).stdout);
    return !openDialog(s.address) && ["idle", "done"].includes(t.status?.state);
  },
  async deliver(s, body, active = () => true) {
    // The status guard is enforced at transport admission. No force, keys, or send-now path is reachable here.
    if (openDialog(s.address)) return { accepted: false, notSent: true, error: "A question or permission dialog is open" };
    if (!await sameSource(s)) return { accepted: false, notSent: true, error: "The Source conversation changed before admission" };
    if (!active()) return { accepted: false, notSent: true, error: "Review cancelled before admission" };
    const r = await hc(["send", s.address, body, "--if", "idle"]);
    return { accepted: r.code === 0, error: r.code === 0 ? null : (r.stderr || r.stdout) };
  },
  async received(s, body) {
    if (!await sameSource(s)) return false;
    // Use the same Claude/Codex user-message parsing as Chat; a token or quoted tool result is never a receipt.
    return (await conversation(s)).items.some((m) => m.kind === "user" && m.text?.includes(body));
  },
  async reviewerReady(r) {
    const t = await ownTerminal(r);
    return !openDialog(r.owned?.terminal) && ["idle", "done"].includes(t?.status?.state);
  },
  async reviewerReceived(r, body) {
    const source = await reviewerSource(r);
    if (!source) return false;
    return (await conversation(source)).items.some((m) => m.kind === "user" && m.text?.includes(body));
  },
  async recheck(r, body, active = () => true) {
    const source = await reviewerSource(r);
    if (!source || !await io.reviewerReady(r) || !await sameSource(r.source)) return { accepted: false, notSent: true, error: "The bound conversations are not ready" };
    // Persist the transcript boundary before submission, so old completed turns cannot complete the recheck.
    r.round.logOffset ??= (await fs.readFile(source.path, "utf8")).length;
    await io.save(r);
    if (!active() || !await io.sameReviewer(r) || !await sameSource(r.source)) return { accepted: false, notSent: true, error: "Review or bound conversation changed before admission" };
    if (!active()) return { accepted: false, notSent: true, error: "Review cancelled before admission" };
    const result = await hc(["send", source.address, body, "--if", "idle"]);
    return { accepted: result.code === 0, error: result.code === 0 ? null : result.stderr || result.stdout };
  },
  reportPath: (r) => `${base}/${r.id}.md`,
};

export const reviews = new ChangesReview(io);
export async function reviewRecords() {
  const path = await ready();
  let names;
  try { names = await fs.readdir(path); } catch (e) { if (missing(e, "list", path)) return []; throw e; }
  const records = [];
  for (const n of names) if (valid(n.replace(/\.json$/, "")) && n.endsWith(".json")) records.push(await io.load(n.slice(0, -5)));
  return records.sort((a, b) => b.created - a.created);
}
export async function reviewTick(id, path, status, deliver = true) {
  const r = await io.load(id);
  if (!r || finished(r)) return r;
  if (path && r.round.findings === null) {
    if (sessionOf("claude", path) !== r.session) return reviews.message({ type: "failed", runId: r.id, roundId: r.round.id,
      reportId: r.round.reportId, session: r.session, error: "The reviewer conversation changed; its replacement was left alone" });
    if (r.logPath !== path) { r.logPath = path; await io.save(r); }
    const text = await fs.readFile(path, "utf8");
    const offset = r.round.logOffset ?? 0;
    if (text.length < offset) return reviews.message({ type: "failed", runId: r.id, roundId: r.round.id,
      reportId: r.round.reportId, session: r.session, error: "The reviewer transcript was truncated during recovery" });
    if (r.round.number > 1 && r.round.logOffset === undefined) return deliver ? reviews.tick(id) : r;
    const records = text.slice(offset).split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const event = completedMessage(r, records, status === "idle" || status === "done");
    if (event) await reviews.message(event);
  }
  return deliver ? reviews.tick(id) : io.load(id);
}

let sweeping = false;
/** Owned by the tab bar, so closing a finished reviewer cannot cancel its own final persistence task. */
export async function reviewSweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const r of await reviewRecords()) {
      if (finished(r) || r.state === "launching") continue;
      if (r.state === "launch-uncertain") {
        const tagged = terminals().filter((t) => t.labels?.["herdr.review"] === r.id);
        if (tagged.length === 1) {
          r.owned = { terminal: tagged[0].address, tab: null, pane: null };
          await io.save(r); await io.cleanup(r);
          r.state = "failed"; await io.save(r); await io.release(r);
        }
        continue;
      }
      if (!panes().some((p) => p.pane === r.owned?.pane && p.tab === r.owned?.tab) && !r.closeRequested) {
        await reviews.cancel(r.id); continue;
      }
      const result = r.owned?.terminal ? await hc(["get", r.owned.terminal, "--json"]) : null;
      const terminal = result?.code === 0 ? JSON.parse(result.stdout) : null;
      let path = null;
      if (terminal?.foreground?.pid) {
        const found = await exec("sh", ["-c", FIND, "chat", "claude", String(terminal.foreground.pid)]);
        const candidate = found.stdout.trim().split("\n").pop();
        if (sessionOf("claude", candidate) === r.session) path = candidate;
      }
      if (r.round.findings?.length && await sameSource(r.source)) {
        for (const event of sourceMessages(r, (await conversation(r.source)).items)) await reviews.message(event);
      }
      await reviewTick(r.id, path, terminal?.status?.state);
    }
  } finally { sweeping = false; }
}

export function openReviewReport(id) {
  openOverlay({ mod: "changes-review", kind: "dialog", width: 760, height: 660, props: { report: id } });
}
