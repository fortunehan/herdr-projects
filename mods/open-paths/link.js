// Ctrl/Cmd-clicked paths in terminals (SHEP-117): the layout's link_handlers names this mod; core/link-click.js decides.
import { exec, notify, window } from "herdr";
import * as fs from "fs/promises";
import { openClick } from "./core/link-click.js";

export function handleLink(click) {
  let os = "macos";
  try { os = window()?.platform ?? os; } catch {}
  return openClick(click, {
    os,
    exec: (prog, args) => exec(prog, args),
    toast: (n) => notify(n),
    exists: (p) => fs.exists(p),
  });
}
