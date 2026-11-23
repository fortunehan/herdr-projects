// Shared core: the source is core/link-click.js; bin/sync-shared copies it into mods/open-paths/core/. Edit it here.
// A Ctrl/Cmd-clicked path in a terminal (SHEP-117, Herdr 0.1.17's link handlers): opened as core/chat-links.js
// says (SHEP-99): a page, picture, PDF or text in the default browser, anything else shown in Finder (a folder opened,
// an app only shown); a missing or remote path gets a toast. URLs go on to Herdr's own opener.
// Plain JS: no herdr, node or DOM.
import { actionOf, command, problem } from "./chat-links.js";

/** What a click does: "handled" or "pass". click: Herdr's LinkClick ({link, source}). env: { os (window().platform),
 *  exec(prog, args) -> {code, stdout, stderr}, toast({title, body, level}), exists(path) -> bool (Windows only) }. */
export async function openClick(click, env) {
  const link = click?.link;
  if (link?.kind !== "file") return "pass";
  const machine = click?.source?.machine;
  if (link.path == null) {
    env.toast(machine
      ? { title: "That path is on another machine", body: `It's on ${machine}: open it there.`, level: "info" }
      : { title: "Couldn't find that path", body: `${link.raw ?? "It"} isn't a path on this machine.`, level: "info" });
    return "handled";
  }
  const os = env.os ?? "macos";
  const p = link.path;
  const action = actionOf(p);
  // Windows has no sh to look first: the window's own exists()
  if (os === "windows" && !(await Promise.resolve(env.exists(p)).catch(() => false))) {
    env.toast({ ...problem(action, os, p, { code: 3 }), level: "error" });
    return "handled";
  }
  const [prog, args] = command(action, os, p);
  const r = await Promise.resolve(env.exec(prog, args)).catch(() => null);
  const why = problem(action, os, p, r);
  if (why) env.toast({ ...why, level: "error" });
  return "handled";
}
