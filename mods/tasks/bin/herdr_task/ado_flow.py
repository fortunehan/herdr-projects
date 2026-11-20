"""Azure DevOps from Accept to Done (docs/adr/0001-ado-own-accept-to-done-flow.md,
docs/adr/0003-ado-pull-request-opened-on-accept-by-agent.md).

SHEP-96: ready opens no pull request and pushes nothing (finalize(): the task's "pr_on_accept"). The
person's Accept hands opening it to the task's agent (request_pr(): resumed when it ended), with the
ado-push-pr skill, auto-complete on; the task reads Opening pull request ("pr_requested") until the agent
records it (`herdr-task pr`, cmd_pr()) and is then Waiting to merge, or says it can't (`herdr-task status
--cant-fix`, cant_fix()) or ends its turn without either (opening_pass()): Needs you with why, and Accept asks
it again. A failing check while it waits to merge goes to the agent to fix and push (ghnews.pr_news():
fix_round()), at most Settings' fix_rounds times per pull request; then Needs you with the last failure.

A task whose pull request was opened before SHEP-96 (at ready) still goes as below. Accept completes a task's pull request when Azure DevOps allows that now (checks passed, approvals
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
OPEN_FAILED = "Couldn't open the pull request"
ACCEPT_AGAIN = (AUTO_FAILED, AUTO_OFF, OPEN_FAILED)
PULL_FAILED = "The main checkout couldn't pull"
# SHEP-96: the task's agent opens its pull request after Accept (as core/tasks.js readyWait()).
OPENING = "Opening pull request"
OPENED_ON_ACCEPT = "Its pull request is opened on Accept (Azure DevOps)"
CANT_FIX = "Its agent can't fix it"
ROUNDS_OUT = "Checks still fail after"
# Needs you until the pull request's head moves (a fix pushed), whatever its checks say meanwhile (tick.facts()).
STUCK = (CANT_FIX, ROUNDS_OUT)
QUIET_MS = 20_000  # an agent quiet this long after the request, with no pull request recorded: Needs you
STARTING_MS = 120_000  # an agent started for the request that isn't up after this: Needs you


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
    return wait(s, t, v)


def wait(s, t, v=None):
    """Auto-complete on, set by Herdr's account: Waiting to merge until Azure DevOps completes it
    (the tick: watch(), merged()). Couldn't: Needs you with Azure DevOps' reason; Accept retries.
    v: the pull request as read; one with auto-complete already on (an Accept that was cut short,
    run again) isn't set again."""
    ok, why = (True, "") if v and v.get("autoComplete") else ado.auto_complete(t)
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


# ---- SHEP-96: its agent opens the pull request after Accept ------------------------------------

def pr_on_accept(s, t):
    """A worktree task on Azure DevOps with work to merge and no pull request yet: ready opens none, Accept asks its
    agent to (request_pr())."""
    return bool(t.get("mode") == "worktree" and t.get("worktree") and not t.get("pr") and not t.get("nothing_to_merge")
                and ado.repo_of(s))


def open_msg(s, t):
    """What the task's agent is told on Accept: open its pull request with the ado-push-pr skill, then record it."""
    from .launch import own_path
    ref, ht, folder = s.ref(t), own_path(), shlex.quote(s.loc["folder"])
    base = t.get("base") or "main"
    wid = ado.wids(t)
    item = f"work item #{wid[0]}, checked live" if wid else "the work item the skill finds, checked live"
    return (f"The person accepted {ref} \"{t.get('title') or ''}\". Open its pull request now with the ado-push-pr skill "
            f"(PR mode): push {t['branch']} from {t['worktree']} and create its pull request into {base} (the task's base "
            f"branch, even when the repository's default branch is another one), with auto-complete on. Follow the skill's own "
            f"steps: {item}, the title \"#<work item>: <Summary>\", and the repository's pull request template. Don't add, change "
            f"or rebase commits.\n"
            f"Once it exists, record it: `{ht} pr {ref} --folder {folder} --url <its URL>`. Herdr then waits for Azure DevOps "
            f"to merge it and sends you any check that fails.\n"
            f"If you can't create it (no valid work item, the push refused, the skill missing, a sign-in failing), don't open "
            f"it any other way: run `{ht} status {ref} --folder {folder} \"Couldn't open the pull request\" --cant-fix "
            f"\"<why, in one line>\"` and end your turn. The person decides what happens next.")


def request_pr(s, t, args):
    """The person's Accept on a task with no pull request yet: its agent (resumed, or started with a handoff, when it
    ended) opens it. Opening pull request until it records one (cmd_pr()). Returns (terminal, started), or raises Fail
    with the task Needs you (OPEN_FAILED: Accept asks again)."""
    from .commands import tell
    from .base import Fail
    for k in ("attention", "attention_at", "merge_failed_head", "auto_merge"):
        t.pop(k, None)
    t["pr_requested"] = t["handed_at"] = now()
    s.dirty = True
    try:
        return tell(s, t, open_msg(s, t), args)
    except Fail as e:
        t.pop("pr_requested", None)
        t["attention"], t["attention_at"] = f"{OPEN_FAILED}: couldn't reach its agent: {e}", now()
        raise Fail(t["attention"])


def opened(s, t, v):
    """Its agent recorded its pull request (v: as read): Waiting to merge (auto-complete on, the skill's, else turned
    on now), Done when it merged already, else why not (Needs you)."""
    t.pop("pr_requested", None)
    t.pop("pr_on_accept", None)
    t["pr"]["checked"] = 0
    if v.get("state") == "MERGED":
        merged(s, t, v, even_if_busy=True)
        return None
    return wait(s, t, v)


PR_NUMBER = re.compile(r"/pullrequest/(\d+)(?:[/?#]|$)", re.I)


def cmd_pr(args):
    """herdr-task pr <id> --url <its URL> (or --number N): a task's agent records the pull request it opened on Azure
    DevOps after the person's Accept (SHEP-96). Checked live: the task's repo, branch and base. Then Waiting to merge."""
    from .base import Fail
    from .commands import open_store, say, view, branch_tip
    n = getattr(args, "number", None)
    if n is None:
        m = PR_NUMBER.search(str(args.url or ""))
        if not m:
            raise Fail("Give the pull request's URL (…/_git/<repo>/pullrequest/<number>) with --url, or --number.")
        n = int(m.group(1))
    with open_store(args) as s:
        t = s.find(args.id)
        repo = ado.repo_of(s)
        if not repo:
            raise Fail(f"{s.ref(t)}'s folder isn't on Azure DevOps: herdr-task pr records Azure DevOps pull requests only.")
        if args.url and not str(args.url).lower().startswith(ado.web(repo).lower() + "/pullrequest/"):
            raise Fail(f"That URL isn't a pull request of {repo[len(ado.PREFIX):]} ({ado.web(repo)}/pullrequest/<number>).")
        if t["state"] not in ("ready", "running") or t.get("merged"):
            raise Fail(f"{s.ref(t)} isn't waiting for its pull request ({t['state']}).")
        if t.get("pr") and int(t["pr"].get("number") or 0) != int(n):
            raise Fail(f"{s.ref(t)} already has pull request #{t['pr']['number']}.")
        try:
            v = ado.view(repo, int(n))
        except ado.AdoError as e:
            raise Fail(f"Couldn't read pull request #{n} on Azure DevOps: {e}")
        base = t.get("base") or "main"
        if v.get("headRefName") != t.get("branch") and v.get("headRefOid") != branch_tip(s, t):
            raise Fail(f"Pull request #{n} is from {v.get('headRefName')}, not {s.ref(t)}'s branch {t.get('branch')}.")
        if v.get("baseRefName") != base:
            raise Fail(f"Pull request #{n} goes into {v.get('baseRefName')}, but {s.ref(t)} merges into {base}: change its "
                       f"target branch to {base} in Azure DevOps, then run this again.")
        if v.get("state") == "CLOSED":
            raise Fail(f"Pull request #{n} is abandoned.")
        t["pr"] = {**(t.get("pr") or {}), "number": int(n), "url": ado.pr_url(repo, n), "repo": repo}
        if t["state"] == "running":
            t["state"], t["ready_at"] = "ready", t.get("ready_at") or now()
        t.pop("attention", None)
        why = opened(s, t, v)
        s.dirty = True
        out = view(s, t)
    if why and why != WAITS:
        say(args, {**out, "error": why}, f"{s.ref(t)}: pull request #{n} recorded, but: {why}")
        return
    say(args, out, f"{s.ref(t)}: pull request #{n} recorded; " + ("merged, done." if why is None else
        "waiting for Azure DevOps to merge it (auto-complete is on). A check that fails comes back to you."))


def cant_fix(s, t, why):
    """The task's agent says it can't (herdr-task status --cant-fix): open its pull request after Accept, or fix its
    failing checks. Needs you with why and the last failure, until its pull request's head moves (a fix pushed)."""
    why = " ".join(str(why or "").split())[:300] or "it didn't say why"
    if t.get("pr_requested") and not t.get("pr"):
        t.pop("pr_requested", None)
        t["attention"] = f"{OPEN_FAILED}: {why}"
    else:
        last = ((t.get("pr") or {}).get("last_failure") or {})
        t["attention"] = f"{CANT_FIX}: {why}" + (f" Last failure: {last['text']}" if last.get("text") else "")
        t["stuck_head"] = last.get("head") or git(t.get("worktree") or s.loc["folder"], "rev-parse", "HEAD")[1] or None
    t["attention_at"] = now()
    t.pop("handed_at", None)
    s.dirty = True
    return t["attention"]


def opening_pass(s, t, report):
    """A task whose agent was asked to open its pull request (pr_requested) that has none yet: its agent gone, or quiet
    after the request without recording one or saying why, needs the person (Accept asks again)."""
    from .agents import quiet_since, status_word
    from .commands import workers
    at = t.get("pr_requested")
    if not at or t.get("pr") or t.get("attention") or t["state"] != "ready":
        return
    live = workers(s, t)
    if not live:
        if now() - at < STARTING_MS:
            return
        why = "its agent stopped before it opened one"
    else:
        quiet = quiet_since(live)
        if any(status_word(k) not in ("idle", "done") for k in live) or not quiet or quiet <= at or now() - quiet < QUIET_MS:
            return
        why = "its agent ended its turn without recording one (herdr-task pr) or saying why"
    t.pop("pr_requested", None)
    t["attention"], t["attention_at"] = f"{OPEN_FAILED}: {why}", now()
    s.dirty = True
    report["attention"].append(t["id"])


def fix_round(s, t, failed, head):
    """A new failing check on a task's accepted Azure DevOps pull request (ghnews.pr_news()). Returns the lines for its
    agent (one more fix round) or None once its fix rounds are used up: then it Needs you with the last failure."""
    from .launch import own_path
    from .settings import fix_rounds
    pr = t["pr"]
    names = ", ".join(c.get("name") or c.get("context") or "a check" for c in failed[:5])
    pr["last_failure"] = {"text": names + (f" ({failed[0].get('detailsUrl')})" if failed[0].get("detailsUrl") else ""),
                          "head": head or None, "at": now()}
    limit, used = fix_rounds(s, t), int(pr.get("fix_rounds") or 0)
    if used >= limit:
        t["attention"], t["attention_at"] = f"{ROUNDS_OUT} {used} fix round{'' if used == 1 else 's'}: {names}", now()
        t["stuck_head"] = pr["last_failure"]["head"]
        return None
    pr["fix_rounds"] = used + 1
    ref, ht, folder = s.ref(t), own_path(), shlex.quote(s.loc["folder"])
    return [f"Fix round {used + 1} of {limit}: the person accepted this pull request and Azure DevOps completes it by itself "
            f"once its checks pass, so fix what fails. Find out why from the log, fix it in {t.get('worktree')}, run the "
            f"checks, commit and push to the pull request's branch (`git push`; never force-push, don't run ready): its "
            f"checks run again on the push.",
            f"If the failure isn't one you can fix (outside your change, the base is red too, an agent or service down), run "
            f"`{ht} status {ref} --folder {folder} \"Can't fix the checks\" --cant-fix \"<why, in one line>\"` and end your "
            f"turn. After {limit} rounds the person takes over."]
