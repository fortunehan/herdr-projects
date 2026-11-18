"""SHEP-83: this machine's Shepherdr source checkout updates itself after a task there merges (opt-in).

Settings › Machines › <machine> › "Update after a Shepherdr task merges" (machines[<name> | "local"].self_update, true;
unset: off). It applies only to the folder Shepherdr was installed from (bin/shepherdr's install record, "source"),
never to other repos. A task there merging through its pull request (github.watch_main, every merge path) arms a run
for QUIET_MS later, re-armed by each further merge; the scheduler's round (self_update_pass) starts it as a detached
`herdr-task self-update --worker`, at most one at a time (RUN_LOCK). A merge while one runs arms one follow-up.

A run: git fetch; refuses a checkout with uncommitted tracked changes, mid-merge/rebase/cherry-pick/revert, or not on
its base branch; `git merge --no-edit <remote>/<base>` (a merge commit: the local base often has commits the remote
lacks, so a fast-forward would skip); a conflict is aborted. Then ./install.sh --yes from the checkout (niced), then
`shepherdr doctor` (the installer holds the sync to other machines until doctor finds the install whole). The space's
Assistant hears one line either way (a notice, delivered by the pass until it can take it); a stop also raises an
alert from the scheduler's terminal, with what stopped it, the command to finish by hand and the installer's backup
folder. A failed run is never tried again by itself (merges armed while it ran are dropped too).
"""

import contextlib
import fcntl
import json
import os
import re
import secrets
import subprocess
import sys

from .base import Fail, git, HOME, hc_json, log_line, now, run, SHELLS, STORE
from .settings import LOCAL_MACHINE, machine_name, read_settings

STATE = os.path.join(STORE, ".self-update.json")
RUN_LOCK = os.path.join(STORE, ".self-update.run.lock")
LOG = os.path.join(STORE, ".self-update.jsonl")
RECORDS = (os.path.join(HOME, ".config", "herdr-app", "data", "shepherdr", "installed.json"),
           os.path.join(HOME, ".local", "share", "shepherdr", "installed.json"))

QUIET_MS = 3 * 60000          # a run waits this long after the last merge (several merges close together: one run)
DEFER_MAX_MS = 60 * 60000     # someone typing or a busy machine holds a due run back at most this long
SPAWN_GRACE_MS = 2 * 60000    # a worker just started is given this long to take RUN_LOCK
NOTICE_KEEP_MS = 6 * 3600000  # an Assistant that can't take the notice for this long: dropped (the alert said it)
INSTALL_TIMEOUT_S = 45 * 60
DOCTOR_TIMEOUT_S = 5 * 60
TYPING_KEEP_MS = 5 * 60000    # as news.TYPING_KEEP_MS


def enabled():
    """This machine's own switch (a pushed settings file names this machine in "here")."""
    d = read_settings()
    key = d.get("here") or LOCAL_MACHINE
    return ((d.get("machines") or {}).get(key) or {}).get("self_update") is True


def source_checkout():
    """The checkout Shepherdr was installed from on this machine (the install record's "source"), or None."""
    for rec in RECORDS:
        try:
            with open(rec) as f:
                src = (json.load(f) or {}).get("source")
        except (OSError, ValueError, AttributeError):
            continue
        if src and os.path.isfile(os.path.join(src, "install.sh")) and os.path.isfile(os.path.join(src, "lib", "addons.json")):
            return os.path.realpath(src)
    return None


def is_source(folder):
    src = source_checkout()
    return bool(src and folder and os.path.realpath(folder) == src)


@contextlib.contextmanager
def state():
    """STATE under its lock (the tick's merge, the pass and the worker all write it)."""
    os.makedirs(STORE, exist_ok=True)
    with open(STATE + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        st = read_state()
        yield st
        tmp = f"{STATE}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(st, f)
        os.replace(tmp, STATE)


def read_state():
    try:
        with open(STATE) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def merged(s, t):
    """A task merged through its pull request: arms (or re-arms) a run when the setting is on here and the task's
    folder is this machine's Shepherdr checkout. True when armed."""
    folder = s.loc["folder"]
    if not enabled() or not is_source(folder):
        return False
    with state() as st:
        p = st.setdefault("pending", {})
        p["due"] = now() + QUIET_MS
        p["folder"] = os.path.realpath(folder)
        p["base"] = t.get("base") or "main"
        p["space"] = t.get("space") or p.get("space")
        refs = p.setdefault("refs", [])
        if s.ref(t) not in refs:
            refs.append(s.ref(t))
    return True


def running():
    """Whether a worker holds RUN_LOCK now."""
    os.makedirs(STORE, exist_ok=True)
    with open(RUN_LOCK, "a") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.flock(f, fcntl.LOCK_UN)
    return False


def typing_here():
    """An agent's chat here holds the person's unsent words (mods/chat's herdr.typing label): a reload now would
    swap the panel under their hands."""
    for k in (hc_json("ls") or {}).get("terminals") or []:
        if k.get("state") != "live" or "/" in (k.get("address") or "/") or not k.get("agent") or k.get("agent") in SHELLS:
            continue
        g = hc_json("get", k["address"]) or {}
        try:
            at = int((g.get("labels") or {}).get("herdr.typing") or 0)
        except ValueError:
            at = 0
        if at and now() - at < TYPING_KEEP_MS:
            return True
    return False


def defer_reason():
    """Why a due run waits a little longer ("you're typing in a chat", "CPU is 140% busy"), or None."""
    from .machine import hold_reason, sample
    from .settings import machine_limits
    try:
        if typing_here():
            return "you're typing in a chat"
    except Fail:
        pass
    return hold_reason(sample(), machine_limits())


def spawn():
    from .base import ENTRY
    subprocess.Popen([sys.executable, ENTRY, "self-update", "--worker"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True, cwd=HOME)


def self_update_pass(report):
    """The scheduler's round: delivers a waiting notice, and starts a due run (one at a time, held back while the
    person types or the machine is busy, at most DEFER_MAX_MS)."""
    if not os.path.exists(STATE):
        return
    deliver(report)
    st = read_state()
    p = st.get("pending")
    if not p or now() < (p.get("due") or 0) or running() or now() - (st.get("spawned") or 0) < SPAWN_GRACE_MS:
        return
    if not enabled():
        with state() as st:
            st.pop("pending", None)
        return
    why = defer_reason()
    with state() as st:
        p = st.get("pending")
        if not p:
            return
        if why and now() - p["due"] < DEFER_MAX_MS:
            p["deferred"] = why
            return
        st["spawned"] = now()
    spawn()
    report.setdefault("self_update", []).append({"refs": p.get("refs"), "folder": p.get("folder")})


# ---- the run ------------------------------------------------------------------------------------

def tilde(path):
    return "~" + path[len(HOME):] if path == HOME or path.startswith(HOME + os.sep) else path


def remote_of(folder):
    names = git(folder, "remote")[1].split()
    return "origin" if "origin" in names else (names[0] if names else "origin")


def in_progress(folder):
    """What git is in the middle of there ("merge", "rebase", "cherry-pick", "revert"), or None."""
    for word, ref in (("merge", "MERGE_HEAD"), ("cherry-pick", "CHERRY_PICK_HEAD"), ("revert", "REVERT_HEAD")):
        if git(folder, "rev-parse", "-q", "--verify", ref)[0]:
            return word
    for d in ("rebase-merge", "rebase-apply"):
        ok, p, _ = git(folder, "rev-parse", "--git-path", d)
        if ok and os.path.isdir(p if os.path.isabs(p) else os.path.join(folder, p)):
            return "rebase"
    return None


def tail(text, lines=12):
    out = [x for x in (text or "").strip().splitlines() if x.strip()]
    return "\n".join(out[-lines:])


def installed_version():
    for rec in RECORDS:
        try:
            with open(rec) as f:
                v = (json.load(f) or {}).get("version")
        except (OSError, ValueError, AttributeError):
            continue
        if v:
            return v
    return None


def steps(p):
    """One run over pending p: {ok, step, why, by_hand, backup, version, merged}. Each step must succeed."""
    folder, base = p["folder"], p.get("base") or "main"
    out = {"folder": folder, "base": base, "refs": p.get("refs") or [], "at": now()}
    where = f"cd {tilde(folder)}"
    finish = "./install.sh --yes && shepherdr doctor"

    def stop(step, why, by_hand):
        return {**out, "ok": False, "step": step, "why": why, "by_hand": by_hand}

    if not is_source(folder):
        return stop("check", f"{tilde(folder)} isn't the checkout Shepherdr is installed from any more", None)
    remote = remote_of(folder)
    whole = f"{where} && git fetch {remote} && git merge --no-edit {remote}/{base} && {finish}"
    ok, _, err = git(folder, "fetch", remote, base)
    if not ok:
        return stop("fetch", f"git fetch {remote} {base} failed: {tail(err, 3)}", whole)
    mid = in_progress(folder)
    if mid:
        return stop("check", f"{tilde(folder)} is in the middle of a {mid}", f"finish it or `git {mid} --abort` there, then: {whole}")
    ok, cur, _ = git(folder, "symbolic-ref", "--short", "HEAD")
    if not ok or cur != base:
        return stop("check", f"{tilde(folder)} is on {cur if ok and cur else 'a detached HEAD'}, not {base}",
                    f"{where} && git switch {base}, then: {whole}")
    dirty = git(folder, "status", "--porcelain", "--untracked-files=no")[1]
    if dirty:
        files = git(folder, "diff", "--name-only", "HEAD")[1].split()[:5] or ["staged files"]
        return stop("check", f"{tilde(folder)} has uncommitted changes ({', '.join(files)})", f"commit or stash them, then: {whole}")
    before = git(folder, "rev-parse", "HEAD")[1]
    r = run(["git", "-C", folder, "merge", "--no-edit", f"{remote}/{base}"])
    if r.returncode != 0:
        conflicts = git(folder, "diff", "--name-only", "--diff-filter=U")[1].split()
        if in_progress(folder) == "merge":
            git(folder, "merge", "--abort")
        why = (f"merging {remote}/{base} conflicts in {', '.join(conflicts[:5])}" if conflicts
               else f"git merge {remote}/{base} failed: {tail(r.stderr or r.stdout, 3)}")
        return stop("merge", why + "; the merge was aborted", f"{where} && git merge --no-edit {remote}/{base}, resolve and commit, then {finish}")
    out["merged"] = git(folder, "rev-parse", "HEAD")[1] != before
    nice = ["nice", "-n", "10"] if sys.platform != "win32" and os.path.exists("/usr/bin/nice") else []
    r = run([*nice, "sh", os.path.join(folder, "install.sh"), "--yes"], cwd=folder, timeout=INSTALL_TIMEOUT_S)
    m = re.findall(r"backup of what it replaced: (\S+)", r.stdout or "")
    if m:
        out["backup"] = m[-1]
    if r.returncode != 0:
        return stop("install", f"./install.sh --yes failed: {tail(r.stderr or r.stdout, 6)}", f"{where} && {finish}")
    r = run([sys.executable, os.path.join(folder, "bin", "shepherdr"), "doctor"], cwd=folder, timeout=DOCTOR_TIMEOUT_S)
    if r.returncode != 0:
        bad = [x.strip() for x in (r.stdout or "").splitlines() if x.strip().startswith("✗")]
        return stop("doctor", "shepherdr doctor doesn't find the install whole" + (f": {'; '.join(bad[:4])}" if bad else ""),
                    "fix what `shepherdr doctor` lists, then run it again (the sync to other machines waits for it)")
    return {**out, "ok": True, "version": installed_version()}


def preload():
    """The install swaps herdr-task's own files under this process: what the rest of the run needs is imported first."""
    from . import launch, news, scheduler  # noqa: F401


def esc(text):
    return str(text).replace("<", "‹").replace(">", "›")


def notice_text(res):
    refs = ", ".join(res.get("refs") or []) or "a task"
    where = tilde(res["folder"])
    if res["ok"]:
        v = res.get("version") or "?"
        body = (f"This machine's Shepherdr updated itself to {v} after {refs} merged: the base branch merged into {where}, "
                "installed, and shepherdr doctor finds it whole. The manual steps after an Accept are done. "
                "One quiet line to the person at most.")
        return f'<herdr-news event="self-update" version="{esc(v)}">{esc(body)}</herdr-news>'
    body = f"This machine's Shepherdr didn't update itself after {refs} merged: {res['why']} (step: {res['step']})."
    if res.get("by_hand"):
        body += f" To finish by hand: {res['by_hand']}"
    if res.get("backup"):
        body += f" What the installer replaced is in {res['backup']}."
    body += " Tell the person in a line or two. It won't try again by itself."
    return f'<herdr-news event="self-update-stopped">{esc(body)}</herdr-news>'


def alert(res):
    """A stop reaches the person at once: an alert from the scheduler's terminal (as memory_guard's)."""
    from .scheduler import SCHEDULER
    body = res["why"] + (f". Finish by hand: {res['by_hand']}" if res.get("by_hand") else "") \
        + (f". Backup: {res['backup']}" if res.get("backup") else "")
    a = {"id": secrets.token_hex(4), "at": now(), "title": "Shepherdr didn't update itself", "body": body[:300],
         "about": True, "task": machine_name() or "This computer"}
    try:
        k = hc_json("get", SCHEDULER)
        if k and k.get("state") == "live":
            run(["hc", "label", SCHEDULER, "herdr.alert=" + json.dumps(a, ensure_ascii=False, separators=(",", ":"))])
    except Fail:
        pass


def send(space, text):
    """The space's Assistant takes the notice now (False: not now, tried again next round)."""
    from .launch import coordinator_in
    from .news import news_send
    try:
        to = coordinator_in(space) if space else None
        return bool(to and news_send(to, text))
    except Fail:
        return False


def deliver(report):
    st = read_state()
    n = st.get("notice")
    if not n or n.get("sent") or n.get("dropped"):
        return
    if send(n.get("space"), n["text"]):
        with state() as st:
            if st.get("notice", {}).get("at") == n["at"]:
                st["notice"]["sent"] = now()
        report.setdefault("news", []).append({"to": n.get("space"), "lines": ["self-update"]})
    elif now() - (n.get("at") or 0) > NOTICE_KEEP_MS:
        with state() as st:
            if st.get("notice", {}).get("at") == n["at"]:
                st["notice"]["dropped"] = True


def run_worker():
    """The detached run: RUN_LOCK held throughout; the pending request claimed at the start (a merge meanwhile arms
    the follow-up)."""
    preload()
    os.makedirs(STORE, exist_ok=True)
    with open(RUN_LOCK, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return None
        with state() as st:
            p = st.pop("pending", None)
            st.pop("spawned", None)
            if not p:
                return None
            st["running"] = {"at": now(), "pid": os.getpid(), "refs": p.get("refs") or []}
        try:
            res = steps(p)
        except Exception as e:  # noqa: BLE001 - a crash is a stop the person hears of, never a silent one
            res = {"folder": p["folder"], "base": p.get("base"), "refs": p.get("refs") or [], "at": now(), "ok": False,
                   "step": "error", "why": f"the update stopped with an error: {e}", "by_hand": None}
        with state() as st:
            st.pop("running", None)
            st["last"] = res
            if not res["ok"]:
                st.pop("pending", None)
            st["notice"] = {"text": notice_text(res), "space": p.get("space"), "at": now()}
        log_line(LOG, "ok" if res["ok"] else "stopped", **{k: v for k, v in res.items() if k != "at"})
        if not res["ok"]:
            alert(res)
        deliver({})
        return res


def cmd_self_update(args):
    from .output import say
    if args.worker:
        run_worker()
        return
    st = read_state()
    src = source_checkout()
    on = enabled()
    lines = [f"Update after a Shepherdr task merges: {'on' if on else 'off'} on this machine"
             + (f" (checkout: {tilde(src)})" if src else " (no install record names a checkout)")]
    if st.get("running"):
        lines.append(f"Running now, for {', '.join(st['running'].get('refs') or [])}.")
    p = st.get("pending")
    if p:
        lines.append(f"Waiting to run for {', '.join(p.get('refs') or [])}" + (f" ({p['deferred']})" if p.get("deferred") else "") + ".")
    last = st.get("last")
    if last:
        lines.append(f"Last run: updated to {last.get('version')}." if last.get("ok")
                     else f"Last run stopped: {last.get('why')}." + (f" Finish by hand: {last['by_hand']}" if last.get("by_hand") else ""))
    say(args, {"on": on, "source": src, **st}, "\n".join(lines))
