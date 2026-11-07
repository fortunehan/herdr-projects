"""This machine's own additions, kept out of Shepherdr's settings and templates: an Assistant's local
notes (~/.herdr/assistant), and a repo's own git config (herdr.base, herdr.branch, herdr.wid).

git config herdr.*: the repo's (its main checkout's .git/config, shared by its worktrees) over the
global one (git config --global), both over Shepherdr's space settings; a task's own --base, --branch
or --wid over all of them."""

import os
import re

from .base import Fail, git, HOME


NOTES = os.path.join(HOME, ".herdr", "assistant")
EVERYWHERE = "_everywhere.md"
NOTES_MAX = 8000  # characters of each file an Assistant is told


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read(NOTES_MAX + 1).strip()
    except OSError:
        return ""


def notes_files(k):
    """The local notes files for an Assistant's terminal (an hc record): every space's
    (_everywhere.md), then its folder's (<slug>.md, the slug of `herdr-task where`)."""
    from .store import locate, store_path
    files = [os.path.join(NOTES, EVERYWHERE)]
    cwd = (k or {}).get("cwd") or ((k or {}).get("foreground") or {}).get("cwd")
    if cwd:
        try:
            files.append(os.path.join(NOTES, store_path(locate(cwd)["folder"])[0] + ".md"))
        except Fail:
            pass
    return files


def assistant_notes(k):
    """What an Assistant's new session is told after its settings: its local notes, the person's
    own words for it (rules, the sibling repos of its space), whichever CLI it runs; "" without."""
    parts = []
    for path in notes_files(k):
        text = _read(path)
        if text:
            cut = len(text) > NOTES_MAX
            parts.append(f"From {path.replace(HOME, '~', 1)}:\n{text[:NOTES_MAX]}" + ("\n(cut here: the file is longer)" if cut else ""))
    if not parts:
        return ""
    return "\n\nThe person's local notes for you (their own words, kept on this machine, not in any repo):\n\n" + "\n\n".join(parts)


# ---- a repo's own git config ------------------------------------------------------------------

def git_setting(folder, key):
    """git config herdr.<key> for the folder (the repo's, else the global one), or ""."""
    ok, out, _ = git(folder, "config", "--get", f"herdr.{key}")
    return out.strip() if ok else ""


def base(folder):
    """herdr.base: the branch a repo's new worktree tasks branch from and merge into."""
    return git_setting(folder, "base")


def branch_pattern(s, task):
    """herdr.branch, a task branch's name as Branch names takes it, plus {wid}: the task's work item.
    "" when unset, or when it needs a work item the task has none of."""
    p = git_setting(s.loc["folder"], "branch")
    if "{wid}" in p:
        if not str(task.get("wid") or "").isdigit():
            return ""
        p = p.replace("{wid}", str(task["wid"]))
    return p


def set_wid(s, t, wid):
    """--wid: the task's Azure DevOps work item (its pull request links it; {wid} in herdr.branch),
    else herdr.wid; "" for none. 16951176, #16951176 and ADO-16951176 all say the same."""
    if wid is None:
        wid = git_setting(s.loc["folder"], "wid")
    wid = str(wid).strip()
    m = re.fullmatch(r"(?:ADO-|#)?(\d+)", wid, re.I)
    if wid and not m:
        raise Fail(f"--wid takes a work item's number, e.g. 16951176 (not {wid!r}).")
    if m:
        t["wid"] = m.group(1)
    else:
        t.pop("wid", None)
