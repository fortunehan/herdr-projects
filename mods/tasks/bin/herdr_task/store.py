"""Where a folder's tasks live (~/.herdr/tasks/<slug>.json) and the locked Store that edits them."""

import errno
import fcntl
import hashlib
import json
import os
import re
import time

from .base import Fail, git, hc_json, HELD, HOME, LEGACY, MAX_RUNNING, now, run, STORE
from .settings import settings_for
from .agents import agent_running
from .sessions import session_of
from .launch import retag_tabs


# ---- where a folder's tasks live ------------------------------------------------------------

def locate(path):
    """The task folder for a path: {folder, kind: repo|folder, name, common}."""
    path = os.path.realpath(os.path.expanduser(path or os.getcwd()))
    if not os.path.isdir(path):
        raise Fail(f"No such folder: {path}")
    ok, out, _ = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel")
    lines = out.split("\n") if ok else []
    if len(lines) == 2:
        common, top = lines
        main = common[:-5] if common.endswith("/.git") else top
        return {"folder": main, "kind": "repo", "name": os.path.basename(main) or "/", "common": common}
    name = "~" if path == HOME else (os.path.basename(path) or "/")
    return {"folder": path, "kind": "folder", "name": name, "common": None}


def slug_of(folder):
    # Folders in home drop the home part: ~/dev/app -> dev-app, ~ -> home.
    rel = os.path.relpath(folder, HOME) if folder == HOME or folder.startswith(HOME + "/") else folder
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", "home" if rel == "." else rel.strip("/")).strip("-")
    return s or "root"


# ---- a repo's stable id (SHEP-141) ------------------------------------------------------------
# A repo's tasks are kept by its folder's name (the slug), so renaming or moving the folder would lose them. Each
# repo gets an id of its own in its .git/config (`git config --local shepherdr.id`: never committed, shared by its
# worktrees, moved with it), recorded in its task list as "project_id": a folder with no list of its own finds the
# list whose repo it is, when that list's folder is gone, and goes on with it (same slug, so its tasks' keys stay).

def project_id(folder, make=False):
    """The repo's id (None outside git); make: give it one when it has none."""
    ok, out, _ = git(folder, "config", "--local", "--get", "shepherdr.id")
    if ok and out.strip():
        return out.strip()
    if not make:
        return None
    import uuid
    new = str(uuid.uuid4())
    return new if git(folder, "config", "--local", "shepherdr.id", new)[0] else None


def moved_list(folder):
    """The list of the repo now at `folder` that was kept under its old folder (gone now), or None."""
    pid = project_id(folder) if os.path.isdir(os.path.join(folder, ".git")) else None
    if not pid:
        return None
    for p in (os.path.join(STORE, f) for f in sorted(os.listdir(STORE))) if os.path.isdir(STORE) else []:
        if not p.endswith(".json"):
            continue
        d = read_list(p)
        if is_task_list(d) and d.get("project_id") == pid and d.get("folder") != folder and not os.path.isdir(d.get("folder") or ""):
            return p
    return None


def store_path(folder):
    slug = slug_of(folder)
    p = os.path.join(STORE, slug + ".json")
    if not os.path.exists(p):
        moved = moved_list(folder)
        if moved:
            return os.path.basename(moved)[:-5], moved
    # Two folders can share a readable slug ("a-b/c", "a/b-c"): the second gets a hash.
    if os.path.exists(p):
        try:
            with open(p) as f:
                if json.load(f).get("folder") not in (None, folder):
                    slug = f"{slug}-{hashlib.sha1(folder.encode()).hexdigest()[:6]}"
                    p = os.path.join(STORE, slug + ".json")
        except (OSError, ValueError):
            pass
    return slug, p


def words_of(name):
    """A folder name's words: split on anything but letters, and at camelCase humps."""
    return [w for w in re.split(r"[^A-Za-z]+", re.sub(r"([a-z])([A-Z])", r"\1 \2", name)) if w]


def auto_prefix(name):
    """A task id prefix from a folder name: the initials of its words (herdr-app-ttt -> HAT, up
    to 5), or a single word's first 4 letters (shepherdr -> SHEP); at least 2 letters."""
    ws = words_of(name)
    p = "".join(w[0] for w in ws)[:5] if len(ws) > 1 else (ws[0][:4] if ws else "")
    if len(p) < 2:
        letters = "".join(ws)
        p = letters[:2] if len(letters) >= 2 else "TASK"
    return p.upper()


def prefixes_in_use(skip=None):
    """{prefix: folder} for every folder's tasks on this machine, but `skip` (a list's path)."""
    out = {}
    for path in store_files():
        d = read_list(path) if path != skip else None
        if is_task_list(d) and d.get("prefix"):
            out[d["prefix"]] = d.get("folder")
    return out


def parse_ref(ref):
    """"HAT-1", "hat-1", "#1", "1" or a label key "<slug>#1" -> (prefix or None, number)."""
    r = str(ref).strip()
    if "#" in r[1:]:
        r = r.rsplit("#", 1)[-1]
    r = r.lstrip("#")
    m = re.fullmatch(r"([A-Za-z]+[0-9]*)-([0-9]+)", r)
    if m:
        return m.group(1).upper(), int(m.group(2))
    if r.isdigit():
        return None, int(r)
    raise Fail(f"{ref!r} isn't a task id; use one like HAT-4 or 4.")


def open_lock(path):
    """(a list's lock file, writable): opened to write, else, where nothing can be written (a
    read-only sandbox: a Codex reviewer's, #841), to read (a shared lock still works on it), else
    None when it doesn't exist yet."""
    try:
        return open(path, "a"), True
    except OSError as e:
        if e.errno not in (errno.EROFS, errno.EACCES, errno.EPERM):
            raise
    try:
        return open(path), False
    except OSError:
        return None, False


# SHEP-29: a read never waits long on the lock. Every list is saved whole (os.replace), so one read
# without it is still a whole list: show and list wait this long (s), then read without saving.
READ_WAIT = 2.0


def take(lock, mode, wait=None):
    """flock(lock, mode), waiting at most `wait` seconds (None: as long as it takes). False: timed out."""
    if wait is None:
        fcntl.flock(lock, mode)
        return True
    end = time.monotonic() + wait
    while True:
        try:
            fcntl.flock(lock, mode | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            if time.monotonic() >= end:
                return False
            time.sleep(0.05)


def stamp(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st.st_ino, st.st_mtime_ns, st.st_size


_GONE = object()


def merge(ours, base, theirs):
    """Three-way, in place: ours becomes theirs plus what ours changed since base (ours wins where
    both changed one value). Dicts merge key by key, keeping ours' objects (callers hold them); a
    list's tasks by id; any other list is one value."""
    for k in set(ours) | set(base) | set(theirs):
        o, b, t = ours.get(k, _GONE), base.get(k, _GONE), theirs.get(k, _GONE)
        if k == "tasks" and isinstance(o, list) and isinstance(t, list):
            merge_tasks(o, b if isinstance(b, list) else [], t)
        elif isinstance(o, dict) and isinstance(t, dict):
            merge(o, b if isinstance(b, dict) else {}, t)
        elif o == b:
            if t is _GONE:
                ours.pop(k, None)
            else:
                ours[k] = t
    if isinstance(ours.get("tasks"), list) and "next" in ours:
        ours["next"] = max([ours["next"], theirs.get("next") or 0] + [x["id"] + 1 for x in ours["tasks"] if isinstance(x.get("id"), int)])


def merge_tasks(ours, base, theirs):
    """Tasks by id: theirs' order, each merged into ours' own dict; ours' new ones after. One either
    side removed stays removed; one both sides added under the same id: ours gets the next id."""
    by_o = {x.get("id"): x for x in ours}
    by_b = {x.get("id"): x for x in base}
    out = []
    for x in theirs:
        i = x.get("id")
        if i not in by_o:
            if i not in by_b:
                out.append(x)
            continue
        if i not in by_b:
            out.append(x)  # both added one with this id: ours is renumbered below
            continue
        merge(by_o[i], by_b[i], x)
        out.append(by_o[i])
    taken = {x.get("id") for x in theirs}
    for x in ours:
        i = x.get("id")
        if i in by_b:
            continue
        if i in taken:
            x["id"] = max(int(y.get("id") or 0) for y in [*ours, *theirs]) + 1
        out.append(x)
    ours[:] = out


class Store:
    """One folder's tasks, locked while open. `with Store(loc) as s: s.data[...]; s.dirty = True`.
    write: True (refused where nothing can be written), False (read only), or "try" (a read that
    saves what it learns when it can: show, list). A read lets go of the lock once it has read; a
    change lets go of it around slow calls (base.unlocked()) and merges what others saved then."""

    def __init__(self, loc, write=True):
        self.loc, self.write, self.best_effort = loc, bool(write), write == "try"
        self.slug, self.path = store_path(loc["folder"])
        self.dirty = self.read_only = False

    def __enter__(self):
        try:
            os.makedirs(STORE, exist_ok=True)
        except OSError:
            pass
        self.lock, can = open_lock(os.path.join(STORE, "." + os.path.basename(self.path) + ".lock"))
        if not can:
            if self.write and not self.best_effort:
                if self.lock:
                    self.lock.close()
                raise Fail(f"Can't change the task list here: {STORE} is read-only (a sandbox?). Run this outside it.")
            self.write, self.read_only = False, True
        self.locked = False
        if self.lock:
            reading = not self.write or self.best_effort
            if take(self.lock, fcntl.LOCK_EX if self.write else fcntl.LOCK_SH, READ_WAIT if reading else None):
                self.locked = True
            else:
                # A change holds it: the last saved list, read without it; nothing saved.
                self.lock.close()
                self.lock = None
                self.write, self.read_only = False, True
        try:
            self.data, self.base, self.seen = self.load()
        except BaseException:
            self.unlock()
            raise
        if not self.write:
            self.unlock()
        else:
            HELD.append(self)
        d = self.data
        d.setdefault("version", 1)
        if self.write and d.get("folder") not in (None, self.loc["folder"]) and os.path.exists(self.path):
            self.dirty = True   # its repo moved (moved_list): kept under its new folder from now on
        d["folder"], d["kind"], d["name"] = self.loc["folder"], self.loc["kind"], self.loc["name"]
        if d.get("slug") != self.slug and os.path.exists(self.path):
            d["slug"] = self.slug
            self.dirty = True
        d["slug"] = self.slug
        d.setdefault("next", 1)
        d.setdefault("tasks", [])
        self.new_prefix = False
        if self.write and self.loc["kind"] == "repo" and not d.get("project_id"):
            pid = project_id(self.loc["folder"], make=True)
            if pid:
                d["project_id"] = pid
                self.dirty = self.dirty or os.path.exists(self.path)
        if self.write:
            self.migrate()
            if not d.get("prefix"):
                # Its id prefix, unique on this machine; lists made before prefixes get one too.
                taken, base = prefixes_in_use(self.path), auto_prefix(os.path.basename(self.loc["folder"]))
                n = 1
                while (base if n == 1 else f"{base}{n}") in taken:
                    n += 1
                d["prefix"] = base if n == 1 else f"{base}{n}"
                self.dirty = self.new_prefix = bool(d["tasks"]) or os.path.exists(self.path)
        return self

    def load(self):
        """(data, base: the same as read, its file's stamp)."""
        seen = stamp(self.path)
        try:
            with open(self.path) as f:
                text = f.read()
        except FileNotFoundError:
            return {}, {}, None
        try:
            return json.loads(text), json.loads(text), seen
        except ValueError:
            raise Fail(f"{self.path} isn't valid JSON. Fix it first.")

    def release(self):
        """Lets go of the lock for a slow call (base.unlocked()); what's changed stays in memory."""
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.locked = False

    def reacquire(self):
        """Takes the lock again and merges in what others saved meanwhile (merge())."""
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        self.locked = True
        if stamp(self.path) == self.seen:
            return
        theirs, base, self.seen = self.load()
        merge(self.data, self.base, theirs)
        self.base = base

    def unlock(self):
        if self in HELD:
            HELD.remove(self)
        if self.lock:
            if self.locked:
                fcntl.flock(self.lock, fcntl.LOCK_UN)
            self.lock.close()
            self.lock, self.locked = None, False

    def __exit__(self, kind, *_):
        try:
            if kind is None and self.write and self.dirty:
                tmp = f"{self.path}.{os.getpid()}.tmp"
                with open(tmp, "w") as f:
                    json.dump(self.data, f, indent=2)
                    f.write("\n")
                os.replace(tmp, self.path)
        finally:
            self.unlock()
        if kind is None and self.new_prefix:
            # A list that just got its prefix: its running tasks' tabs say it too.
            retag_tabs(self)

    def key(self, task):
        return f"{self.slug}#{task['id']}"

    @property
    def prefix(self):
        return self.data.get("prefix") or auto_prefix(os.path.basename(self.loc["folder"]))

    def ref(self, task):
        """What people and agents call it: HAT-4."""
        return f"{self.prefix}-{task['id']}"

    def find(self, ref):
        pre, n = parse_ref(ref)
        if pre and pre != self.prefix:
            raise Fail(f"{pre}-{n} isn't a task in {self.loc['folder']} (its tasks are {self.prefix}-n).")
        for t in self.data["tasks"]:
            if t["id"] == n:
                return t
        raise Fail(f"No task {self.prefix}-{n} in {self.loc['folder']}.")

    def max_running(self):
        return int(settings_for(self)["tasks"].get("max_running") or MAX_RUNNING)

    def new(self, title, prompt="", mode="here"):
        d = self.data
        t = {"id": d["next"], "title": title, "prompt": prompt, "mode": mode, "state": "todo",
             "created": now(), "agents": []}
        d["next"] += 1
        d["tasks"].append(t)
        self.dirty = True
        return t

    # The Tasks panel's old lists: <repo>/.git/herdr-tasks.json, and data/tasks/<slug>.json in the
    # app's home for folders outside git. Read once, then set aside as *.migrated.
    def migrate(self):
        old = []
        if self.loc["common"]:
            old.append(os.path.join(self.loc["common"], "herdr-tasks.json"))
        old.append(os.path.join(LEGACY, re.sub(r"[^\w.-]+", "_", "local" + self.loc["folder"]) + ".json"))
        for p in old:
            if not os.path.isfile(p):
                continue
            try:
                with open(p) as f:
                    items = json.load(f).get("tasks") or []
            except (OSError, ValueError):
                continue
            for o in items:
                if not isinstance(o, dict) or not o.get("title"):
                    continue
                state = {"started": "running", "complete": "done"}.get(o.get("state"), "todo")
                t = self.new(o["title"], o.get("prompt") or "", "here")
                t.update(state=state, created=o.get("created") or now(), legacy_id=o.get("id"))
                if o.get("started"):
                    t["started"] = o["started"]
                if o.get("completed"):
                    t["done_at"] = o["completed"]
                if o.get("terminal"):
                    a = {"address": o["terminal"], "agent": o.get("agent") or "", "at": o.get("started") or now()}
                    k = hc_json("get", o["terminal"])
                    if k and k.get("state") == "live":
                        # Still running: label it so it shows as this task's agent.
                        run(["hc", "label", o["terminal"], f"herdr.task={self.key(t)}"])
                        labels = k.get("labels") or {}
                        t["space"], t["tab"] = labels.get("herdr.space"), labels.get("herdr.tab")
                        pid = (k.get("foreground") or {}).get("pid")
                        sid, log = session_of(pid) if pid and agent_running(k) else (None, None)
                        if sid:
                            a["session"], a["log"] = sid, log
                    t["agents"].append(a)
            os.replace(p, p + ".migrated")
            self.dirty = True


def open_store(args, write=True):
    """The list a command works on: --folder's, else the one whose prefix the id names (HAT-4
    from anywhere), else the current folder's."""
    folder = getattr(args, "folder", None)
    ref = getattr(args, "id", None)
    if not folder and ref:
        m = re.fullmatch(r"([A-Za-z]+[0-9]*)-[Aa]?[0-9]+", str(ref).strip())
        if m:
            folder = prefixes_in_use().get(m.group(1).upper())
    return Store(locate(folder), write)


def is_task_list(d):
    """THE rule for what in STORE is a folder's task list: a JSON object with a string "folder"
    and a list "tasks". Everything else there (herdr-task's own .news.json, .seen.json, ...; some
    are lists) is skipped. A list's slug can start with a dot (~/.config/x: .config-x.json), so
    names can't tell them apart. The panels' copy of this rule: lib/tasklists.js."""
    return isinstance(d, dict) and isinstance(d.get("folder"), str) and isinstance(d.get("tasks"), list)


def store_files(folder=None):
    """`folder`'s list path, or every task list in STORE (see is_task_list)."""
    if folder:
        return [store_path(locate(folder)["folder"])[1]]
    names = sorted(f for f in os.listdir(STORE) if f.endswith(".json")) if os.path.isdir(STORE) else []
    return [p for p in (os.path.join(STORE, f) for f in names) if is_task_list(read_list(p))]


def read_list(p):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None
