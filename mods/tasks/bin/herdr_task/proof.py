"""A task's proof and what its Accept card shows (as Shepherdr's merge card): the proof artifact
its agent made, and the evidence from Git, GitHub and that artifact, never the agent's own words
(only its summary)."""

import hashlib
import json
import os
import re

from .base import Fail, HOME, git, WHERE
from .github import BAD, CANT_READ_CHECKS, PENDING, pr_view

ARTIFACTS = WHERE.path("artifacts")
# Files named on the card, and commits.
FEW = 3
# Its Markdown documents shown in full on the card (SHEP-273, #1150): at most this many, each cut at this many characters.
DOCS = 5
DOC_MAX = 60000
MARKDOWN = re.compile(r"\.(md|markdown)$", re.I)


def artifacts_of(folder):
    """This folder's artifacts, newest first (herdr-artifact's list for it; the same slug rule)."""
    rel = os.path.relpath(folder, HOME) if folder == HOME or folder.startswith(HOME + "/") else folder
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", "home" if rel == "." else rel.strip("/")).strip("-") or "root"
    for name in (slug, f"{slug}-{hashlib.sha1(folder.encode()).hexdigest()[:6]}"):
        try:
            with open(os.path.join(ARTIFACTS, name + ".json")) as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if d.get("folder") in (None, folder):
            return d.get("artifacts") or []
    return []


def find_proof(s, t, given=None):
    """The task's proof artifact, {id, title}: the one given (ready --proof <id>), else its newest
    artifact titled as a proof ("HAT-2: ... · Proof") since it started. None: it made none. A proof
    is always a recipe (the person accepts from their phone too): a custom panel is refused."""
    arts = artifacts_of(s.loc["folder"])
    if given:
        a = next((a for a in arts if a.get("id") == given.strip()), None)
        if not a:
            raise Fail(f"No artifact {given} in {s.loc['folder']} (herdr-artifact list shows them).")
    else:
        ref, since = s.ref(t).upper(), t.get("started") or 0
        mine = [a for a in arts if (a.get("task") or "").upper() == ref and re.search(r"\bproof\b", a.get("title") or "", re.I)
                and (a.get("at") or 0) >= since]
        a = mine[0] if mine else None
    if not a:
        return None
    files = a.get("files") or []
    if "main.js" in files or "recipe.json" not in files:
        raise Fail(f"Your proof {a['id']} is a custom panel, which the person can't open on their phone. Make it a recipe "
                   f"(recipe.json; `herdr-artifact guide`, A task's proof), `herdr-artifact update {a['id']} <dir>`, then run ready again.")
    return {"id": a["id"], "title": a.get("title") or a["id"]}


def task_artifacts(s, t, proof=None):
    """The other artifacts its agent published for it since it started (a research task's report),
    newest first, [{id, title}]: linked on its Accept card beside its proof (SHEP-96)."""
    ref, since, skip = s.ref(t).upper(), t.get("started") or 0, (proof or {}).get("id")
    return [{"id": a["id"], "title": a.get("title") or a["id"]} for a in artifacts_of(s.loc["folder"])
            if a.get("id") and a["id"] != skip and (a.get("task") or "").upper() == ref and (a.get("at") or 0) >= since]


def here_mark(s, t):
    """SHEP-95: what a task working in the folder itself (no worktree) has left behind, at ready and later: the folder's
    commit and uncommitted changes (a git folder), and its artifacts' versions. The same mark later means its agent's
    turn changed nothing (tick's settle_back(): Ready again after it answered a question)."""
    folder, ref = s.loc["folder"], s.ref(t).upper()
    mark = {"arts": {a["id"]: a.get("version") or 0 for a in artifacts_of(folder)
                     if a.get("id") and (a.get("task") or "").upper() == ref}}
    if s.loc.get("kind") == "repo":
        ok, head, _ = git(folder, "rev-parse", "HEAD")
        _, status, _ = git(folder, "status", "--porcelain", "--untracked-files=no")
        mark.update(head=head if ok else None, changes=hashlib.sha1(status.encode()).hexdigest())
    return mark


def with_ids(blocks):
    """The blocks in order, each with its id (b1, b2... where it had none, as core/recipe.js withIds()), nested ones too."""
    out, n = [], [0]

    def walk(bs):
        for b in bs if isinstance(bs, list) else []:
            if not isinstance(b, dict):
                continue
            if b.get("id") is None:
                n[0] += 1
            out.append({**b, "id": b["id"] if b.get("id") is not None else f"b{n[0]}"})
            if b.get("type") == "columns":
                for c in b.get("columns") or []:
                    walk(c)
            elif b.get("type") == "tabs":
                for tab in b.get("tabs") or []:
                    walk((tab or {}).get("blocks"))
            elif b.get("type") == "details":
                walk(b.get("blocks"))
    walk(blocks)
    return out


def answer_words(b, value):
    """(what was asked, what the person answered) in words, for the Accept card."""
    if b.get("type") == "form" and isinstance(value, dict):
        said = []
        for f in b.get("fields") or []:
            v = value.get(f.get("name"))
            said.append(f"{f.get('label') or f.get('name')}: " + (("yes" if v else "no") if f.get("kind") == "checkbox" else str(v or "").strip() or "(empty)"))
        return b.get("title") or b.get("submit") or "Form", "; ".join(said)
    if b.get("type") == "choice":
        return b.get("question") or "Choice", str(value)
    return b.get("label") or "Button", "pressed"


def choices_of(folder, proof):
    """The person's answers in its proof (SHEP-87: answers.json beside each version), newest per block:
    [{question, value, at, v}] in the order they were answered. Its agent's recipe says what each block asked."""
    a = next((x for x in artifacts_of(folder) if x.get("id") == proof.get("id")), None) if proof else None
    if not a:
        return []
    found = {}
    for v in sorted(x.get("v") for x in a.get("versions") or [] if isinstance(x.get("v"), int)):
        d = os.path.join(ARTIFACTS, "files", a["id"], f"v{v}")
        try:
            with open(os.path.join(d, "answers.json")) as f:
                answers = json.load(f)
            with open(os.path.join(d, "recipe.json")) as f:
                blocks = with_ids(json.load(f).get("blocks"))
        except (OSError, ValueError, AttributeError):
            continue
        keys = {}
        for b in blocks:
            keys[b["id"]] = b
            if b.get("type") == "buttons":
                for i, x in enumerate(b.get("items") or []):
                    if isinstance(x, dict):
                        keys[f"{b['id']}-{i}"] = {**x, "type": "button"}
        for key, ans in (answers if isinstance(answers, dict) else {}).items():
            b = keys.get(key)
            if not b or not isinstance(ans, dict) or ans.get("value") is None:
                continue
            question, value = answer_words(b, ans["value"])
            at = ans.get("at") or 0
            if key not in found or at >= found[key]["at"]:
                found[key] = {"question": question, "value": value, "at": at, "v": v}
    return sorted(found.values(), key=lambda x: x["at"])


def numstat(out, files):
    """git --numstat lines added into files {path: [added, removed]} (binary files count 0)."""
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            a, r, path = parts
            cur = files.setdefault(path, [0, 0])
            cur[0] += int(a) if a.isdigit() else 0
            cur[1] += int(r) if r.isdigit() else 0


def name_status(out, seen):
    """git --name-status lines into seen {path: "A" | "M"}, oldest first (a file added, then changed, stays new);
    a deleted one goes (it may come back, as new)."""
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        kind, path = parts[0][:1], parts[1]
        if kind == "D":
            seen.pop(path, None)
        elif kind in ("A", "M"):
            seen.setdefault(path, kind)


def docs_of(main, rev, changed, only):
    """Its new and changed Markdown files as they are at rev, for the card to render (SHEP-273, #1150):
    {count, only (every file it changed is Markdown: a plan's, an email draft's task), list: [{path, new, text,
    cut}]}, new ones first; None when it changed none. changed is {path: "A" | "M"}, any file."""
    paths = sorted((p for p in changed if MARKDOWN.search(p)), key=lambda p: (changed[p] != "A", p))
    if not paths:
        return None
    out = []
    for p in paths[:DOCS]:
        try:
            ok, text, _ = git(main, "show", f"{rev}:{p}")
        except (UnicodeDecodeError, ValueError):
            ok, text = False, ""
        if not ok:
            continue
        cut = len(text) > DOC_MAX
        if cut:
            text = text[:DOC_MAX]
            text = text[:text.rfind("\n")] if "\n" in text else text
        out.append({"path": p, "new": changed[p] == "A", "text": text, "cut": cut})
    return {"count": len(paths), "only": only, "list": out} if out else None


def checks_of(t):
    """GitHub's checks on its pull request, in words: {state, text}; failed and running say so,
    so a green one is never assumed."""
    if not t.get("pr"):
        if t.get("pr_on_accept"):
            # SHEP-96: on Azure DevOps its agent opens the pull request once the person accepts it.
            from .ado_flow import OPENED_ON_ACCEPT
            return {"state": "none", "text": OPENED_ON_ACCEPT}
        return {"state": "none", "text": "No GitHub checks here"}
    v = pr_view(t)
    if not v:
        return {"state": "unknown", "text": "Couldn't ask GitHub"}
    rows = v.get("statusCheckRollup") or []
    word = lambda c: (c.get("conclusion") or c.get("state") or "").upper()
    bad = [c.get("name") or c.get("context") or "a check" for c in rows if word(c) in BAD]
    running = [c for c in rows if (c.get("status") or c.get("state") or "").upper() in PENDING and not c.get("conclusion")]
    if bad:
        return {"state": "failed", "text": f"{len(bad)} failing: " + ", ".join(bad[:FEW])}
    if running:
        return {"state": "running", "text": f"{len(running)} of {len(rows)} still running"}
    if v.get("checks_unknown"):
        # SHEP-179: this machine's GitHub token can't read its checks: never said to pass
        return {"state": "unknown", "text": CANT_READ_CHECKS}
    if not rows:
        return {"state": "none", "text": "No checks on its pull request"}
    return {"state": "passed", "text": f"All {len(rows)} passed"}


def evidence(s, t):
    """What an Accept card shows: {summary, details, explain, to_check (ready's plain-words explanation and what
    to check; absent on older tasks), commits: {count, list}, diff: {files, added, removed, list} or None, docs (its
    Markdown files to read: docs_of) or None, git (False: not a git folder), scope, checks, proof, artifacts (its
    others), merges (Accept merges its branch first: an open pull request or commits past its base; the button says
    so)}."""
    main, out = s.loc["folder"], {"summary": t.get("summary"), "details": t.get("details"),
                             "explain": t.get("explain"), "to_check": t.get("to_check") or [], "proof": t.get("proof") or find_proof(s, t)}
    out["artifacts"] = task_artifacts(s, t, out["proof"])
    out["choices"] = choices_of(main, out["proof"])
    commits, files, changed, rev = [], {}, {}, None
    fmt = "--format=%h%x09%s"
    if s.loc["kind"] != "repo":
        out.update(git=False, commits={"count": 0, "list": []}, diff=None, checks=checks_of(t), merges=False)
        return out
    if t.get("mode") == "worktree" and t.get("branch"):
        # Its branch past where it meets its base: exactly what Accept merges.
        ok, tip, _ = git(main, "rev-parse", "--verify", "--quiet", f"refs/heads/{t['branch']}")
        tip = tip if ok and tip else t.get("head")
        base = t.get("base") or "main"
        since = base if git(main, "rev-parse", "--verify", "--quiet", base)[0] else t.get("start")
        if tip and since:
            ok, log, _ = git(main, "log", fmt, f"{since}..{tip}")
            commits = [line.split("\t", 1) for line in log.splitlines() if "\t" in line] if ok else []
            ok, diff, _ = git(main, "diff", "--numstat", f"{since}...{tip}")
            if ok:
                numstat(diff, files)
            else:
                files = None
            ok, names, _ = git(main, "diff", "--name-status", "--no-renames", f"{since}...{tip}")
            if ok:
                name_status(names, changed)
            rev = tip
        out["scope"] = f"{t['branch']} into {base}"
    else:
        # In the folder itself: the commits made here while it worked (other work committed here
        # meanwhile counts too, so the card says "while it worked").
        # not ready yet: no end (a missing ready_at once read as "until 60 s after 1970": a flaky empty card)
        start, end = (t.get("started") or 0) // 1000, (t["ready_at"] // 1000 + 60) if t.get("ready_at") else None
        # git reads --since=@0 as now (nothing): no start known, no lower bound
        rng = ([f"--since=@{start}"] if start else []) + ([f"--until=@{end}"] if end else [])
        ok, log, _ = git(main, "log", fmt, *rng)
        commits = [line.split("\t", 1) for line in log.splitlines() if "\t" in line] if ok else []
        ok, diff, _ = git(main, "log", "--numstat", "--format=", *rng)
        if ok:
            numstat(diff, files)
        else:
            files = None
        ok, names, _ = git(main, "log", "--reverse", "--name-status", "--no-renames", "--format=", *rng)
        if ok:
            name_status(names, changed)
        rev = "HEAD"
        out["scope"] = "committed here while it worked"
    out["git"] = True
    out["commits"] = {"count": len(commits), "list": [{"sha": c[0], "subject": c[1]} for c in commits[:FEW]]}
    out["diff"] = None if files is None else {
        "files": len(files), "added": sum(v[0] for v in files.values()), "removed": sum(v[1] for v in files.values()),
        "list": [{"path": p, "added": v[0], "removed": v[1]} for p, v in sorted(files.items(), key=lambda x: -(x[1][0] + x[1][1]))[:FEW]]}
    out["docs"] = docs_of(main, rev, changed, bool(changed) and all(MARKDOWN.search(p) for p in changed)) if rev else None
    out["checks"] = checks_of(t)
    # What Accept does (cmd_accept): a worktree task's branch with work of its own is merged first; else only done.
    # SHEP-96: an Azure DevOps task whose pull request is opened on Accept merges, whatever the commit list read here.
    out["merges"] = bool(t.get("mode") == "worktree" and t.get("branch") and (t.get("pr") or commits or t.get("pr_on_accept"))
                         and not (t.get("pr") or {}).get("closed"))  # #1106: closed on GitHub, Accept merges nothing
    return out
