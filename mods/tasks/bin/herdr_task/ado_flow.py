"""Azure DevOps from Accept to Done (docs/adr/0001-ado-own-accept-to-done-flow.md).

Accept completes a task's pull request when Azure DevOps allows that now (checks passed, approvals
in); else (an approval still needed, checks running, or the completion refused) it turns on
auto-complete and the task is Waiting to merge ("merge_wait") until Azure DevOps merges it. Herdr
never completes one in the background as a fallback. Done only once Azure DevOps says merged; then
the main checkout pulls, and a pull that fails is a Needs you card on the Done task ("pull").

GitHub's way (commands.merge_now, github.update_main) is not this one. Reading pull requests in
gh's shapes stays shared (ado.py, github.py)."""

import re
import shlex

from .base import git, now
from . import ado
from .github import finish, needs_approval, pr_pending, pr_problem, pr_view, remote_of, watch_main


WAITS = "It waits to merge in Azure DevOps."
AUTO_FAILED = "Couldn't turn on auto-complete in Azure DevOps"
AUTO_OFF = "Auto-complete was turned off in Azure DevOps"
# The problems the person's Accept itself fixes (it turns auto-complete on again): Needs you with
# Accept on its row (core/tasks.js acceptAgain()).
ACCEPT_AGAIN = (AUTO_FAILED, AUTO_OFF)
PULL_FAILED = "The main checkout couldn't pull"


def accept(s, t, publish=True):
    """The person's Accept or Merge (publish: a draft is published first), or a merge policy, on a
    task whose pull request is on Azure DevOps. Returns None once it merged (the task Done), WAITS
    while Azure DevOps merges it (Waiting to merge), else why it can't (the task Needs you)."""
    n = t["pr"]["number"]
    v = pr_view(t)
    s.dirty = True
    if not v:
        return f"Couldn't reach pull request #{n} on Azure DevOps."
    if v.get("state") == "MERGED":
        merged(s, t, v, even_if_busy=True)
        return None
    problem = pr_problem(v)
    if problem:
        stop_waiting(t)
        t["attention"], t["attention_at"] = problem, now()
        return problem
    if v.get("isDraft"):
        if not publish:
            return "It's still a draft pull request: Accept publishes and merges it."
        ok, err = ado.publish(t)
        if not ok:
            from .commands import merge_failed
            return merge_failed(t, v, f"couldn't publish the draft: {err}")
    elif not pr_pending(v) and not needs_approval(v) and v.get("mergeable") == "MERGEABLE":
        done, _ = ado.complete(t, v)
        if done == "merged":
            merged(s, t, pr_view(t) or v, even_if_busy=True)
            return None
        # Refused (a permission, a policy) or still completing: auto-complete takes it from here.
    return wait(s, t)


def wait(s, t):
    """Auto-complete on, set by Herdr's account: Waiting to merge until Azure DevOps completes it
    (the tick: watch(), merged()). Couldn't: Needs you with Azure DevOps' reason; Accept retries."""
    ok, why = ado.auto_complete(t)
    if not ok:
        again = pr_view(t)
        if again and again.get("state") == "MERGED":
            merged(s, t, again, even_if_busy=True)
            return None
        stop_waiting(t)
        t["attention"], t["attention_at"] = f"{AUTO_FAILED}: {why}", now()
        return t["attention"]
    t["merge_wait"] = now()
    t.pop("auto_merge", None)
    t["pr"]["checked"] = 0
    return WAITS


def stop_waiting(t):
    t.pop("merge_wait", None)


def watch(s, t, v, problem, report):
    """The tick's look at a Waiting to merge task's open pull request: auto-complete turned off in
    Azure DevOps needs the person (Accept turns it on again). Other problems (a rejecting vote,
    failing checks, a conflict, abandoned) are the tick's, as every pull request's."""
    if not t.get("merge_wait") or v.get("state") != "OPEN" or problem or t.get("attention"):
        return
    if not v.get("autoComplete"):
        t["attention"], t["attention_at"] = AUTO_OFF, now()
        s.dirty = True
        report["attention"].append(t["id"])


def merged(s, t, v, even_if_busy=False):
    """Azure DevOps merged it: Done, and the main checkout pulls (pull_main())."""
    t["merged"] = True
    stop_waiting(t)
    watch_main(s, t, (v.get("mergeCommit") or {}).get("oid"))
    pull_main(s, t, v)
    finish(s, t, even_if_busy=even_if_busy)


# git's lines that say nothing the card's command doesn't: hints, and what to do next.
NOISE = re.compile(r"^(?:hint:|Aborting$|Please commit your changes or stash them|Please move or remove them)")


def reason(err):
    """git's words, short: its error lines on one line, without hints."""
    lines = [re.sub(r"^(?:error|fatal):\s*", "", x.strip()) for x in str(err or "").splitlines()
             if x.strip() and not NOISE.match(x.strip())]
    text = " ".join(lines)
    return (text[:297] + "…" if len(text) > 300 else text) or "git failed"


def pull_main(s, t, v=None):
    """After Azure DevOps merged it. The pull request's target checked out in the main checkout:
    a fast-forward-only pull there, uncommitted changes or not (git refuses what they'd lose, and a
    fast-forward never leaves a merge half done). One that fails is the person's to know: a Needs
    you card on the Done task (t["pull"]), until the main checkout holds the merge or they dismiss
    it. A target not checked out there: its local branch moves forward when that's a fast-forward,
    silently, as on GitHub."""
    main = s.loc["folder"]
    target = (v or {}).get("baseRefName") or t.get("base") or "main"
    remote = remote_of(main)
    ok, cur, _ = git(main, "symbolic-ref", "--short", "HEAD")
    if not (ok and cur == target):
        git(main, "fetch", remote, f"{target}:{target}")
        return
    ok, _, err = git(main, "pull", "--quiet", "--ff-only", "--no-rebase", "--no-autostash", remote, target)
    if ok:
        t.pop("pull", None)
        return
    sha = ((v or {}).get("mergeCommit") or {}).get("oid") or \
        git(main, "rev-parse", "--verify", "--quiet", f"refs/remotes/{remote}/{target}")[1] or None
    t["pull"] = {"branch": target, "why": reason(err), "sha": sha, "at": now(),
                 "command": f"git -C {shlex.quote(main)} pull --ff-only {shlex.quote(remote)} {shlex.quote(target)}"}
    s.dirty = True


def card(p):
    """A failed pull's Needs you card, in words."""
    return f"{PULL_FAILED} {p.get('branch')}: {p.get('why')}"


def pull_pass(s, t):
    """A failed pull's card goes by itself once the main checkout holds the merge (pulled by hand,
    say). Returns whether it went."""
    p = t.get("pull") or {}
    if not p.get("sha") or not git(s.loc["folder"], "merge-base", "--is-ancestor", p["sha"], f"refs/heads/{p.get('branch')}")[0]:
        return False
    t.pop("pull")
    s.dirty = True
    return True


def cmd_dismiss(args):
    """herdr-task dismiss <id>: the person dismisses a Done task's failed-pull card."""
    from .commands import open_store, say, view
    with open_store(args) as s:
        t = s.find(args.id)
        was = t.pop("pull", None)
        if was:
            s.dirty = True
        v = view(s, t)
    say(args, {**v, "dismissed": bool(was)}, f"{s.ref(t)}: dismissed." if was else f"{s.ref(t)} has nothing to dismiss.")
