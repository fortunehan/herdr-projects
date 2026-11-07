"""This machine's own additions, kept out of Shepherdr's settings and templates: an Assistant's local
notes (~/.herdr/assistant)."""

import os

from .base import Fail, HOME


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
