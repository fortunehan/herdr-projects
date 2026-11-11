"""Shared ground: paths, Fail, the clock, this herdr-task's own files, and running programs
(hc, herdr-app, git) only in the real environment."""

import contextlib
import io
import json
import os
import pwd
import subprocess
import threading
import time
import zipfile


from . import layout

VERSION = "1"
HOME = os.path.expanduser("~")
# Shepherdr's own folders (layout.py): ~/.local/share/shepherdr/tasks once this machine's data moved
# there, else the old ~/.herdr/tasks (the entry moves it first, so a run sees one or the other).
WHERE = layout.Where()
# HERDR_TASK_STORE: another task list (a test's own), as HERDR_TASK_SETTINGS for settings.
STORE = os.environ.get("HERDR_TASK_STORE") or WHERE.path("tasks")
# Where new task worktrees go (a task keeps the one it has; Settings > Tasks > Worktree folder picks another).
WORKTREES = WHERE.worktrees()


def beside_store(kind, name):
    """A herdr-task file kept beside the task lists: its own place in Shepherdr's folders, or beside a
    test's own HERDR_TASK_STORE."""
    if os.environ.get("HERDR_TASK_STORE"):
        return os.path.join(os.path.dirname(STORE.rstrip("/")), name)
    return WHERE.path(kind)
LEGACY = os.path.join(HOME, ".config", "herdr-app", "data", "tasks")
SHELLS = {"bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "pwsh", "powershell", "elvish"}
RANK = {"blocked": 4, "done": 3, "working": 2, "idle": 1}
MAX_RUNNING = 10
GH = os.environ.get("HERDR_TASK_GH") or "gh"
# SHEP-29: how long one gh call may take (s); past it, it failed (a poll is tried again next round).
GH_TIMEOUT = int(os.environ.get("HERDR_TASK_GH_TIMEOUT") or 45)
# How often tick asks GitHub about a pull request (ms).
PR_EVERY = 60000


class Fail(Exception):
    pass


# Shepherdr's installer (bin/shepherdr) puts this file here while it replaces helpers or templates,
# and removes it once `shepherdr doctor` finds the install whole. Until then nothing copies a helper
# to another machine: not the sync, not a command's self-copy (cli.remote, herdr-artifact's,
# herdr-secret's install --on), so a half-done or wrong copy never reaches every machine.
# It is in Shepherdr's state folder; an older installer's is at ~/.herdr/sync-hold: either holds.
SYNC_HOLD = os.path.join(WHERE.roots["state"], "sync-hold")
SYNC_HOLDS = (SYNC_HOLD, os.path.join(HOME, ".herdr", "sync-hold"))


def sync_held():
    """Why copies to other machines wait now (the hold's first line), or None."""
    for p in SYNC_HOLDS:
        try:
            with open(p) as f:
                return f.readline().strip() or "held by Shepherdr's installer"
        except OSError:
            continue
    return None


# Shepherdr's add-ons (lib/addons.json): one the person switched off in Shepherdr settings >
# Window is in Everywhere's "off" (the settings file, or HERDR_TASK_SETTINGS), and its
# background work here stops (autopilot, browsers, the sync to other machines).
def addon_off(name):
    path = os.environ.get("HERDR_TASK_SETTINGS") or WHERE.path("settings")
    try:
        with open(path) as f:
            off = (json.load(f).get("everywhere") or {}).get("off")
    except (OSError, ValueError, AttributeError):
        return False
    return isinstance(off, list) and name in off


def now():
    return int(time.time() * 1000)


# ---- the stop log (SHEP-189) ----------------------------------------------------------------------
# Every time an agent goes (Shepherdr ends it, or its terminal is gone while its task is running),
# one line here: when, what, which terminal, and what Herdr knew then. Kept small: the last
# STOP_LOG_LINES lines. Never raises: logging must not stop the work it records.
STOP_LOG = os.path.join(STORE, ".stops.jsonl")
STOP_LOG_LINES = 500


def stop_note(kind, **fields):
    """Appends {at, kind, ...fields} to the stop log (a JSON line)."""
    log_line(STOP_LOG, kind, **fields)


def log_line(path, kind, **fields):
    """Appends {at, kind, ...fields} to a small JSON-lines log (the last STOP_LOG_LINES)."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            with open(path) as f:
                lines = f.readlines()
        except OSError:
            lines = []
        lines = lines[-(STOP_LOG_LINES - 1):] + [json.dumps({"at": now(), "kind": kind, **fields}, ensure_ascii=False) + "\n"]
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            f.writelines(lines)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001 - a log line never stops the work it records
        pass


# ---- the real environment -------------------------------------------------------------------
# With a changed HOME, HERDR_APP_HOME or another herdr-core session (a test's), herdr-app and hc
# could still reach the person's real window and core and overwrite every machine's spaces. So
# herdr-task then refuses to run them at all, with why (HERD-55).
GUARDED = {"hc", "herdr-core", "herdr-app"}


def real_home():
    try:
        return pwd.getpwuid(os.getuid()).pw_dir
    except KeyError:
        return os.path.expanduser("~")


def not_real():
    """Why this environment isn't the account's own, or None when it is."""
    env, home = os.environ, real_home()
    same = lambda a, b: os.path.realpath(a) == os.path.realpath(b)
    if env.get("HOME") and not same(env["HOME"], home):
        return f"HOME is {env['HOME']}, not {home}"
    app = env.get("HERDR_APP_HOME")
    if app and not same(app, os.path.join(home, ".config", "herdr-app")):
        return f"HERDR_APP_HOME is {app}"
    if env.get("HC_SESSION") not in (None, "", "default"):
        return f"HC_SESSION is {env['HC_SESSION']}"
    sock = env.get("HC_SOCKET")
    if sock and not any(same(sock, s) for s in (env.get("HC_TERMINAL_SOCKET"), f"/run/user/{os.getuid()}/herdr-core/default.sock") if s):
        return f"HC_SOCKET is {sock}"
    return None


def guard(args):
    """Refuses herdr-app and hc outside the real environment (see not_real)."""
    name = os.path.basename(args[0])
    why = not_real() if name in GUARDED else None
    if why:
        raise Fail(f"refusing to run {name}: {why}. Run herdr-task with the real HOME, HERDR_APP_HOME, "
                   "HC_SESSION and HC_SOCKET: changed ones can reach the real window and wipe its spaces.")


# ---- slow calls never hold a task list's lock (SHEP-29) -------------------------------------------
# A hung `gh pr view` under the scheduler's lock once kept every herdr-task command on that list
# waiting for 18 minutes. So whatever may wait on the network (gh, git fetch/push, another machine,
# Azure DevOps) runs inside unlocked(): each task list this process holds (store.Store) lets go of
# its lock first and takes it again after, merging what others saved meanwhile (Store.reacquire()).
HELD = []
NET_GIT = {"fetch", "push", "pull", "ls-remote", "clone"}
NET_LOG = os.path.join(STORE, ".network.jsonl")


@contextlib.contextmanager
def unlocked():
    # Only the thread that holds them: a helper thread's call (machines asked at once) runs outside them anyway.
    main = threading.current_thread() is threading.main_thread()
    held = [s for s in HELD if s.locked] if main else []
    for s in reversed(held):
        s.release()
    try:
        yield
    finally:
        for s in held:
            s.reacquire()


def is_gh(args):
    return args[0] == GH or os.path.basename(args[0]) == "gh"


def slow(args):
    """Whether a program may wait on the network: gh, git's network verbs, anything --on another machine."""
    name = os.path.basename(args[0])
    if is_gh(args) or "--on" in args:
        return True
    if name == "git":
        verb = next((a for i, a in enumerate(args[1:], 1) if not a.startswith("-") and args[i - 1] not in ("-C", "-c")), None)
        return verb in NET_GIT
    return False


def run(args, cwd=None, check=False, env=None, timeout=None):
    """timeout (s; gh's: GH_TIMEOUT): past it the program is ended and its answer is exit 124, with
    why on stderr (logged in NET_LOG)."""
    guard(args)
    if env is None and args[0] == GH:
        env = gh_env()
    if timeout is None and is_gh(args):
        timeout = GH_TIMEOUT
    with unlocked() if slow(args) else contextlib.nullcontext():
        try:
            r = subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               universal_newlines=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            why = f"{os.path.basename(args[0])} gave no answer within {timeout} seconds"
            log_line(NET_LOG, "timeout", argv=args[:4], seconds=timeout)
            r = subprocess.CompletedProcess(args, 124, "", why)
    if check and r.returncode != 0:
        raise Fail((r.stderr or r.stdout).strip() or f"{args[0]} failed")
    return r


def git(cwd, *args):
    r = run(["git", "-C", cwd, *args])
    return r.returncode == 0, r.stdout.strip(), r.stderr.strip()


def proxy_for(url):
    """(proxy URL or None, where it came from): the one git uses for url (git config
    http.<url>.proxy, http.proxy), else the environment's https_proxy."""
    ok, out, _ = git(HOME, "config", "--get-urlmatch", "http.proxy", url)
    if ok and out.strip():
        return out.strip(), "git config"
    env = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    return (env, "HTTPS_PROXY") if env else (None, None)


_gh_proxy = []


def gh_env():
    """gh's environment: the caller's, with the proxy git uses for GitHub as HTTPS_PROXY and
    HTTP_PROXY. A caller started by launchd (the window, the service) has no proxy variables of
    its own. Looked up once per process (the tick asks GitHub often)."""
    if not _gh_proxy:
        _gh_proxy.append(proxy_for("https://github.com/")[0])
    p = _gh_proxy[0]
    return {**os.environ, "HTTPS_PROXY": p, "HTTP_PROXY": p} if p else dict(os.environ)


def hc_json(*args):
    r = run(["hc", *args, "--json"])
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except ValueError:
        return None
APP_HOME = os.path.join(HOME, ".config", "herdr-app")
# Where a machine that only runs tasks keeps the chat's question-card hook (mods/chat/ask-hook.sh
# and ask-end.py), synced there beside herdr-task (machines.manifest; launch.ask_hook runs it).
ASK_HOME = os.path.join(".local", "share", "herdr", "ask")
# ---- this herdr-task ------------------------------------------------------------------------
# herdr-task is a thin entry beside this package; on another machine it is one zipapp holding
# both (remote installs it as ~/.local/bin/herdr-task). ENTRY is what runs it again (agents' own
# commands, _track, the scheduler); bundle() is all of it as that one file.
PACKAGE = os.path.dirname(os.path.realpath(__file__))
_OUTER = os.path.dirname(PACKAGE)
ENTRY = _OUTER if os.path.isfile(_OUTER) else os.path.join(_OUTER, "herdr-task")


def bundle():
    """This herdr-task as one runnable file (a zipapp), the same bytes for the same code."""
    if zipfile.is_zipfile(ENTRY):
        with open(ENTRY, "rb") as f:
            return f.read()
    with open(ENTRY, "rb") as f:
        entry = f.read()
    buf = io.BytesIO()
    buf.write(b"#!/usr/bin/env python3\n")
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("__main__.py", (1980, 1, 1, 0, 0, 0)), entry, zipfile.ZIP_DEFLATED)
        for name in sorted(os.listdir(PACKAGE)):
            if name.endswith(".py"):
                with open(os.path.join(PACKAGE, name), "rb") as f:
                    z.writestr(zipfile.ZipInfo(f"herdr_task/{name}", (1980, 1, 1, 0, 0, 0)), f.read(), zipfile.ZIP_DEFLATED)
    return buf.getvalue()
