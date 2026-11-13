// Slash commands for the "/" list above the message box, the window's chat's and the web app's: the CLIs' own, the
// ones that open a menu in the CLI, and the script that finds the person's own commands and skills on the agent's
// machine. Whatever the person types goes to the agent as typed; this only suggests.
// Shared core: the source is core/slash.js; bin/sync-shared copies it into the mods in lib/COPIES.

export const CLAUDE = [
  ["add-dir", "Add a working folder"], ["agents", "Manage subagents"], ["clear", "Start a new conversation"],
  ["compact", "Summarize the conversation to free context"], ["config", "Open settings"], ["context", "Show context use"],
  ["cost", "Show this session's cost"], ["doctor", "Check the installation"], ["effort", "Set the effort level"],
  ["export", "Export the conversation"], ["fast", "Turn fast mode on or off"], ["help", "Show help"], ["hooks", "Manage hooks"],
  ["init", "Write a CLAUDE.md for this project"], ["login", "Sign in"], ["logout", "Sign out"], ["mcp", "Manage MCP servers"],
  ["memory", "Edit memory files"], ["model", "Choose the model"], ["permissions", "Manage tool permissions"],
  ["plugin", "Manage plugins"], ["resume", "Resume another conversation"], ["review", "Review a pull request"],
  ["rewind", "Go back to an earlier point"], ["status", "Show version, model and account"], ["theme", "Change the theme"],
  ["usage", "Show plan usage"],
];
export const CODEX = [
  ["model", "Choose the model and effort"], ["approvals", "Choose what runs without asking"], ["review", "Review changes"],
  ["new", "Start a new conversation"], ["init", "Write an AGENTS.md for this project"], ["compact", "Summarize the conversation to free context"],
  ["diff", "Show the git diff"], ["mention", "Mention a file"], ["status", "Show session settings and usage"],
  ["mcp", "List MCP tools"], ["resume", "Resume another conversation"], ["fork", "Fork this conversation"],
  ["logout", "Sign out"], ["quit", "Exit Codex"],
];
// Commands that open a menu in the CLI when given no arguments.
export const MENU = {
  claude: new Set(["agents", "config", "doctor", "effort", "export", "hooks", "login", "mcp", "memory", "model", "permissions", "plugin", "resume", "rewind", "status", "theme", "usage"]),
  codex: new Set(["model", "approvals", "review", "mention", "resume", "fork", "status", "diff"]),
};

// Run on the agent's machine, not the machine hosting the window or web service.
// Python's JSON reader handles settings, the install registry and manifests without shell interpolation.
export const SCAN = String.raw`python3 - "$1" <<'PY'
import json, os, re, subprocess, sys
from pathlib import Path

def obj(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}

def frontmatter(path):
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, ValueError):
        return {}
    if not lines or lines[0].strip() != "---":
        return {}
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return {}
    out = {}
    # Only the menu's scalar fields; other YAML (tools, hooks, etc.) is never interpreted.
    for i in range(1, end):
        m = re.match(r"^(name|description|user-invocable):\s*(.*)$", lines[i])
        if not m:
            continue
        key, value = m.groups()
        if re.match(r"^[>|][+-]?(?:\s+#.*)?$", value) or not value:
            continuation = []
            for line in lines[i + 1:end]:
                if line and not line.startswith((" ", "\t")):
                    break
                continuation.append(line.strip())
            value = " ".join(continuation)
        elif value.startswith('"'):
            try:
                value = json.JSONDecoder().raw_decode(value)[0]
            except ValueError:
                continue
        elif value.startswith("'"):
            m = re.match(r"^'((?:[^']|'')*)'(?:\s+#.*)?$", value)
            if not m:
                continue
            value = m[1].replace("''", "'")
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
            if key == "user-invocable":
                value = value.lower() != "false"
        out[key] = value
    return out

def files(root, filename, contained=None):
    if not root.is_dir():
        return
    for folder, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and (contained is None or inside(contained, Path(folder) / d)))
        for name in sorted(names):
            path = Path(folder) / name
            if (name == filename or filename == "*.md" and name.endswith(".md")) and (contained is None or inside(contained, path)):
                yield path

def inside(root, path):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError, RuntimeError):
        return False

def valid(name):
    return isinstance(name, str) and re.fullmatch(r"[\w.-]+(?::[\w.-]+)*", name, re.ASCII)

def absolute(value):
    if not isinstance(value, str) or not value or "\0" in value:
        return None
    try:
        path = Path(value)
        return path.resolve() if path.is_absolute() else None
    except (OSError, ValueError, RuntimeError):
        return None

commands, seen = [], set()
def add(path, name, prefix="", skill=False):
    meta = frontmatter(path)
    if meta.get("user-invocable") is False:
        return
    if skill and valid(meta.get("name")):
        name = meta["name"]
    name = prefix + name
    if not valid(name) or name in seen:
        return
    seen.add(name)
    about = meta.get("description", "")
    commands.append({"name": name, "about": " ".join(str(about).split())[:90] or "Your command"})

home = Path(os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude"))
cwd = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 and sys.argv[1] else None
for root in [home / "commands"] + ([cwd / ".claude/commands"] if cwd else []):
    for path in files(root, "*.md"):
        add(path, ":".join(path.relative_to(root).with_suffix("").parts))
for root in [home / "skills"] + ([cwd / ".claude/skills"] if cwd else []):
    if root.is_dir():
        for folder in sorted(root.iterdir()):
            path = folder / "SKILL.md"
            if path.is_file():
                add(path, folder.name, skill=True)

def git(*args):
    if not cwd:
        return None
    try:
        r = subprocess.run(["git", "-C", str(cwd), "rev-parse", *args], capture_output=True, text=True, timeout=3)
        return Path(r.stdout.strip()).resolve() if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None

root = git("--show-toplevel")
common = git("--path-format=absolute", "--git-common-dir")
local_root = common.parent if common and common.name == ".git" else root
settings = [home / "settings.json"]
if cwd:
    settings += [cwd / ".claude/settings.json", cwd / ".claude/settings.local.json"]
    if local_root and local_root != cwd and local_root != Path.home():
        settings.append(local_root / ".claude/settings.local.json")
enabled = {}
for path in settings:
    values = obj(path).get("enabledPlugins")
    if isinstance(values, dict):
        enabled.update({k: v for k, v in values.items() if isinstance(v, bool)})

plugins_home = Path(os.environ.get("CLAUDE_CODE_PLUGIN_CACHE_DIR") or str(home / "plugins"))
registry = obj(plugins_home / "installed_plugins.json").get("plugins", {})
if not isinstance(registry, dict):
    registry = {}
projects = {p for p in [cwd, root, local_root] if p}
for plugin_id, installs in registry.items():
    if not isinstance(installs, list):
        continue
    candidates = []
    for install in installs:
        if not isinstance(install, dict) or absolute(install.get("installPath")) is None:
            continue
        scope = install.get("scope")
        project = install.get("projectPath")
        if scope == "user" or scope in ("project", "local") and absolute(project) in projects:
            candidates.append(install)
    if not candidates:
        continue
    install = max(candidates, key=lambda v: {"user": 0, "project": 1, "local": 2}[v["scope"]])
    plugin = Path(install["installPath"])
    manifest_path = plugin / ".claude-plugin/plugin.json"
    manifest = obj(manifest_path)
    if manifest_path.exists() and not manifest:
        continue
    if enabled.get(plugin_id, manifest.get("defaultEnabled", True)) is not True:
        continue
    namespace = manifest.get("name", plugin_id.split("@")[0])
    if not valid(namespace) or ":" in namespace:
        continue
    roots = [plugin / "skills"]
    custom = manifest.get("skills", [])
    for location in [custom] if isinstance(custom, str) else custom if isinstance(custom, list) else []:
        if isinstance(location, str) and (location == "." or location.startswith("./")) and ".." not in Path(location).parts:
            path = plugin / location
            if inside(plugin, path):
                roots.append(path)
    for skills in roots:
        for path in files(skills, "SKILL.md", plugin):
            add(path, path.parent.name, namespace + ":", skill=True)
print(json.dumps(commands))
PY`;

// Accept the older line protocol too, during a rolling service/window update.
export function scanned(stdout) {
  try { const list = JSON.parse(stdout); if (Array.isArray(list)) return list.filter((c) => typeof c?.name === "string" && typeof c?.about === "string"); } catch {}
  return String(stdout ?? "").split("\n").filter(Boolean).map((l) => { const [name, about] = l.split("\t"); return { name, about: about || "Your command" }; });
}

// Every command an agent knows, its CLI's first: [{ name, about }]. mine: the person's own (Claude Code only).
export function commandList(kind, mine = []) {
  const list = (kind === "codex" ? CODEX : CLAUDE).map(([name, about]) => ({ name, about }));
  if (kind !== "claude") return list;
  const seen = new Set(list.map((c) => c.name));
  return [...list, ...mine.filter((c) => !seen.has(c.name) && seen.add(c.name))];
}

// The "/word" being typed, when the whole message is one command so far.
export function typing(text) {
  const m = /^\/([\w:.-]*)$/.exec(text);
  return m ? m[1] : null;
}

// Suggestions for what is typed: names that start with it first, then names that contain it.
export function match(list, word) {
  const w = word.toLowerCase();
  const starts = list.filter((c) => c.name.toLowerCase().startsWith(w));
  const has = list.filter((c) => !c.name.toLowerCase().startsWith(w) && c.name.toLowerCase().includes(w));
  return [...starts, ...has].slice(0, 8);
}

export function opensMenu(kind, text) {
  const m = /^\/([\w:-]+)\s*$/.exec(text.trim());
  if (!m) return null;
  if (MENU[kind]?.has(m[1])) return m[1];
  // The CLI completes a prefix to its first match ("/mo" runs /model).
  const all = (kind === "codex" ? CODEX : CLAUDE).map(([n]) => n).filter((n) => n.startsWith(m[1]));
  return all.length && MENU[kind]?.has(all[0]) ? all[0] : null;
}
