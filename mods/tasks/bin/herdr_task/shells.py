"""Tasks' shells (SHEP-25): the person's own shell in a task's folder, started by the window's Shell view
(mods/task-shell) on the machine where the task runs, labelled herdr.shell=task and herdr.task-shell=<its
task's herdr.task key>. It never carries herdr.task, so it is none of the task's agents (no worker, no news).
It ends with its task: when the task becomes Done (end_done(), finish(), tidy_done(): before its worktree
goes, as a live terminal there keeps it), and in a tick (shell_pass()) once its task is gone or Done or its
worktree is no longer on disk."""

import os

from .base import Fail, hc_json, run
from .browsers import _task


def task_shells(key):
    """Its live shells; none where hc is refused (a test's or a sandbox's changed home: base.guard())."""
    try:
        d = hc_json("ls", "--label", f"herdr.task-shell={key}") or {}
    except Fail:
        return []
    return [k for k in d.get("terminals") or [] if k.get("state") == "live"]


def _end(addr):
    run(["hc", "kill", addr])
    run(["hc", "rm", addr])


def end_shells(key):
    """Ends the task's shells (and what runs in them, a dev server). Returns their addresses."""
    ended = [k["address"] for k in task_shells(key)]
    for a in ended:
        _end(a)
    return ended


def shell_pass(report):
    """Ends every shell whose task is gone or Done, or whose worktree was removed. hc ls leaves labels out, so
    each shell's task key comes from hc get."""
    d = hc_json("ls", "--label", "herdr.shell=task") or {}
    for k in d.get("terminals") or []:
        if k.get("state") != "live":
            continue
        key = ((hc_json("get", k["address"]) or {}).get("labels") or {}).get("herdr.task-shell")
        if not key:
            continue
        found, t = _task(key)
        if not found:
            continue
        wt = (t or {}).get("worktree")
        if t is None or t.get("state") == "done" or (wt and not os.path.isdir(wt)):
            _end(k["address"])
            report.setdefault("shells_ended", []).append(key)
