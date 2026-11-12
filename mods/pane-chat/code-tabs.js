// Code tabs (SHEP-31): a file clicked in Files (mods/files-tasks) opens as a read-only tab of its own in the middle,
// the mod code-view with props {root, file, on}. One tab per file: a click on a file whose tab is still open goes
// back to that tab. panes() doesn't give a mod pane's props, so the opened tabs are kept in shared "files.tabs":
// key -> {space, tab, pane, root, file, on}; pane-chat reads it to name a code tab's header after its file.
//
// Shared: the source is lib/code-tabs.js; bin/sync-shared copies it into each mod in lib/COPIES.
// Edit lib/code-tabs.js, never a mod's copy, then run bin/sync-shared.
import { exec, run, shared, setShared, panes, spaces, notify } from "herdr";

export const CODE_VIEW = "code-view";
const KEY = "files.tabs";

/** Which tab shows a file: one per space, machine and path. */
export const codeKey = (space, on, root, file) => JSON.stringify([space ?? null, on ?? null, `${root}/${file}`]);

const opened = () => shared(KEY) ?? {};

/** The entries whose code tab is still there. */
export function liveCodeTabs(ps = panes()) {
  const have = new Set(ps.filter((p) => p.mod === CODE_VIEW).map((p) => p.pane));
  return Object.fromEntries(Object.entries(opened()).filter(([, e]) => e?.pane && have.has(e.pane)));
}

/** What a code-view pane shows ({root, file, on}), or null. */
export function codeOfPane(pane) {
  return Object.values(opened()).find((e) => e?.pane === pane) ?? null;
}

/** The last part of a path. */
export const baseName = (path) => String(path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

// One app command, waited for, with what it made ({ tab, pane }).
async function app(name, args) {
  const r = await exec("herdr-app", ["do", name, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)])]);
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch {}
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${name} failed`);
  return out;
}

/** Shows a file's code tab: its open one, else a new tab in the space. */
export async function openCode({ space, root, file, on = null }) {
  if (!root || !file) return;
  const key = codeKey(space, on, root, file), live = liveCodeTabs();
  const have = live[key];
  if (have) {
    if (space && !spaces().find((s) => s.id === space)?.active) run("space.select", { id: space });
    run("tab.select", { id: have.tab });
    run("pane.focus", { pane: have.pane });
    if (Object.keys(live).length !== Object.keys(opened()).length) setShared(KEY, live);
    return;
  }
  try {
    const out = await app("tab.new", { ...(space ? { space } : {}), name: baseName(file), mod: CODE_VIEW, props: { root, file, on } });
    const pane = out.pane ?? panes().find((p) => p.tab === out.tab && p.mod === CODE_VIEW)?.pane ?? null;
    setShared(KEY, { ...liveCodeTabs(), [key]: { space: space ?? null, tab: out.tab, pane, root, file, on } });
  } catch (e) {
    notify({ title: `Couldn't open ${baseName(file)}`, body: String(e?.message ?? e), level: "error" });
  }
}
