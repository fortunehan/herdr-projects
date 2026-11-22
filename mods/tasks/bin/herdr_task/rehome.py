"""SHEP-112: tasks kept for a space that closed. Herdr gives every space a new id: closing one drops
its id for good, and opening its folder again (New space, the recent list) makes another. A task
started from the old one would route its news, its sidebar marks and its next agent to an id nobody
has; it goes to the live space at its folder on this computer instead, once (the record keeps it)."""

import os

from .base import run
from .settings import bare
from .agents import live_agents
from .store import locate, read_list, Store, store_files


def _real(p):
    return os.path.realpath(os.path.expanduser(p)) if p else None


def _local(spaces):
    return [x for x in spaces or [] if x.get("id") and "/" not in x["id"] and not x.get("machine")]


def window_spaces():
    from .autopilot import window_spaces as ls
    return ls()


def live_space(space, folder, spaces=None):
    """A task's space as it is now: `space` while this computer's window still has it (or can't say,
    or it's another machine's); else the live space at `folder` here (with several, the one whose
    Assistant is running, else the first), else `space` unchanged."""
    if not space or "/" in space or not folder:
        return space
    mine = _local(window_spaces() if spaces is None else spaces)
    if not mine or any(x["id"] == space for x in mine):
        return space
    at = _real(folder)
    hits = [x["id"] for x in mine if x.get("folder") and _real(x["folder"]) == at]
    if not hits:
        return space
    from .launch import coordinator_in
    # Its Assistant still runs here: the space is there, only not in this window's list (another window's).
    if coordinator_in(space):
        return space
    if len(hits) > 1:
        led = [i for i in hits if coordinator_in(i)]
        hits = led + [i for i in hits if i not in led]
    return hits[0]


def rehome(s, spaces):
    """Moves the list's tasks (and their queued starts) whose space is gone to the folder's live one,
    relabelling their live agents. -> [(ref, old, new)]."""
    moved, folder = [], s.loc["folder"]
    for t in s.data["tasks"]:
        if t.get("archived"):
            continue
        q = t.get("queue") or {}
        old = t.get("space") or q.get("space")
        new = live_space(old, folder, spaces) if old else None
        if not new or new == old:
            continue
        if t.get("space") == old:
            t["space"] = new
        if q.get("space") == old:
            q["space"] = new
        s.dirty = True
        moved.append((s.ref(t), old, new))
        for k in live_agents(s.key(t)):
            if bare((k.get("labels") or {}).get("herdr.task.space")) == old:
                run(["hc", "label", k["address"], f"herdr.task.space={new}"])
    return moved


def rehome_pass(report, folder=None):
    """The tick's look: every list with a task kept for a space this window no longer has, at a
    folder that has a live space now."""
    spaces = window_spaces()
    mine = _local(spaces)
    if not mine:
        return
    ids = {x["id"] for x in mine}
    for p in store_files(folder):
        d = read_list(p)
        if not d or not os.path.isdir(d.get("folder") or "") or not any(not t.get("archived") and any(
                v and "/" not in v and v not in ids for v in (t.get("space"), (t.get("queue") or {}).get("space")))
                for t in d.get("tasks") or []):
            continue
        at = _real(d["folder"])
        if not any(x.get("folder") and _real(x["folder"]) == at for x in mine):
            continue
        with Store(locate(d["folder"])) as s:
            for ref, old, new in rehome(s, spaces):
                report.setdefault("rehomed", []).append({"folder": s.loc["folder"], "ref": ref, "from": old, "to": new})
