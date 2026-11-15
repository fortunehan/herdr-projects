// A stand-in for herdr-app's "herdr" module in bun tests of window mods. Bun's mock.module is one per process: the
// first test file to import "herdr" fixes its export names, so a later file's stand-in may only change what they do.
// Every test that mocks "herdr" goes through here, so each one has every name the mods import (none is missing).
const NAMES = [
  "agents", "appHome", "closeOverlay", "commands", "exec", "focused", "hc", "home", "keys", "knownAgents", "layout",
  "layouts", "machines", "nextCommand", "notify", "openOverlay", "panes", "pickFolder", "placement", "playSound", "props",
  "readTextFile", "run", "setShared", "settings", "shared", "spaces", "terminals", "theme", "updates", "watchFolder",
  "window", "writeTextFile",
] as const;

type Given = Partial<Record<(typeof NAMES)[number], unknown>>;

// A mod that imports "herdr" binds the functions of the stand-in that was current when the mod first loaded, and Bun
// does not rebind them when a later test file mocks "herdr" again. So each name is one function for the whole process,
// forwarding to whichever test file's stand-in was installed last (SHEP-61: spaces-chat/live.js kept emoji-pick's
// empty spaces() and the sidebar test saw no spaces).
const latest: Given = {};
const stable = Object.fromEntries(NAMES.map((n) => [n, (...args: unknown[]) => {
  const f = latest[n];
  return typeof f === "function" ? f(...args) : undefined;
}]));

export function fakeHerdr(given: Given): Record<string, unknown> {
  for (const n of NAMES) latest[n] = given[n];
  return { ...stable };
}
