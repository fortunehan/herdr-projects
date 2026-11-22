"""The task commands: add, start, status, ready, accept, merge and the rest."""

import argparse
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import time

from . import sandbox
from .base import ENTRY, Fail, git, guard, now, run, STORE, stop_note, VERSION
from .settings import (
    agent_argv, agent_key, bare, merge_policy, review_limits, set_opts, settings_block, settings_for, space_base,
    task_settings, worker_argv, worker_pick, worktrees_on, ensure_launcher, launcher_of,
)
from .agents import (
    accepting, agent_log, agent_running, background_jobs, busy_again, detail, fit, LINE_MAX, live_agents, mid_turn_agents, ready_turns, STATUSES, SUMMARY_MAX,
    WORKING_AGAIN,
)
from .sessions import refresh_sessions
from . import ado, ado_flow, local
from .github import (already_merged, checks_missing, github_unreachable, pr_for_branch, checks_since, drop_branch, expected_checks, finish, gh, github, merged_here, needs_approval, note_checks, own_work, pr_adopt, pr_open,
                     pr_pending, pr_problem, pr_view, publish as publish_pr, rebase_hint, remote_of, restack, RESTACK_NEEDS, update_main, watch_main)
from .github import branch_tip_of
from .github import CHECKS_RUNNING as PR_CHECKS_RUNNING
from .launch import (
    base_ref, brief, caller_labels, caller_space, current_base, default_space, folder_for, git_quick, handoff, launch, name_tabs, on_remote,
    own_path, parent_for, resume_argv, retag_tabs, set_branch, tab_title, task_tabs,
)
from .store import bare_by_mistake, is_task_list, locate, open_store, prefixes_in_use, read_list, Store, store_files
from .queues import after_refs, parse_after, queue_reason, set_after
from .archive import unarchive
from .output import line, minutes, say, view
from .scheduler import ensure_scheduler
from .proof import evidence, find_proof, here_mark
from .when import when_from


# ---- commands -------------------------------------------------------------------------------

def cmd_where(args):
    loc = locate(args.folder)
    with Store(loc, write="try") as st:  # makes ~/.herdr/tasks and moves old lists in, where it can (#900)
        pass
    slug, path = st.slug, st.path
    say(args, {**loc, "slug": slug, "store": path, "prefix": st.prefix, "version": VERSION}, f"{loc['folder']}\n{path}")


def cmd_list(args):
    if args.all:
        folders = [d["folder"] for d in map(read_list, store_files()) if is_task_list(d)]
    else:
        folders = [locate(args.folder)["folder"]]
    groups = []
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        with Store(locate(folder), write="try") as s:
            out = []
            archived = sum(1 for t in s.data["tasks"] if t.get("archived"))
            for t in s.data["tasks"]:
                if bool(t.get("archived")) != args.archived:
                    continue
                mine = live_agents(s.key(t)) if t["state"] in ("running", "ready") else []
                if mine:
                    refresh_sessions(s, t, mine)
                v = view(s, t, [detail(k) for k in mine] if mine else [])
                if t["state"] == "queued":
                    v["reason"] = queue_reason(s, t)
                out.append(v)
            if args.archived:
                out.sort(key=lambda v: -(v.get("archived") or 0))
            groups.append({"folder": s.loc["folder"], "name": s.loc["name"], "kind": s.loc["kind"], "tasks": out,
                           **({} if args.archived else {"archived": archived})})
    if args.json:
        print(json.dumps(groups if args.all else groups[0]))
        return
    for g in groups:
        if args.all:
            print(f"{g['name']}  {g['folder']}")
        for v in g["tasks"]:
            if v["state"] != "done" or args.all or args.archived:
                print(("  " if args.all else "") + line(v))
        hidden = sum(1 for v in g["tasks"] if v["state"] == "done") if not args.archived else 0
        more = [f"{hidden} done"] if hidden and not args.all else []
        if g.get("archived") and not args.all:
            more.append(f"{g['archived']} archived: --archived lists them")
        if more:
            print(f"({'; '.join(more)})")
        elif not g["tasks"] and not args.all:
            print("No archived tasks." if args.archived else "No tasks.")


def cmd_add(args):
    prompt = args.prompt or ""
    if args.prompt_file:
        with open(args.prompt_file) as f:
            prompt = f.read()
    at = scheduled_at(args)  # refused before anything is added
    with open_store(args) as s:
        repo = s.loc["kind"] == "repo"
        wrong = None if repo else bare_by_mistake(s.loc["folder"])
        if wrong:
            raise Fail(wrong)
        if args.worktree and not repo:
            raise Fail("Worktrees need a git repo; this folder isn't one.")
        # The person's setting wins: worktrees off for this repo means in the folder, --worktree or not.
        mode = "here" if args.here or not worktrees_on(s) else "worktree"
        t = s.new(args.title.strip(), prompt, mode)
        space = bare(args.space) or caller_space()
        set_opts(t, args, launcher=worker_pick(s, t, space).get("launcher"))
        set_base(s, t, args.base, space, new=True)
        set_branch(s, t, getattr(args, "branch", None))
        local.set_wid(s, t, getattr(args, "wid", None))
        set_notes(t, args)
        if args.after:
            set_after(s, t, *parse_after(s, args.after))
        if at:
            # Started later by the scheduler, with no caller to ask: its space is kept now.
            schedule(s, t, at, {"space": space or default_space(s.loc["folder"])})
        v = view(s, t)
    if at:
        ensure_scheduler_quietly()
    say(args, v, s.ref(t) + (f": {v['why']}" if at else ""))


# ---- scheduled (SHEP-38) -----------------------------------------------------------------------
# A task that starts by itself at a time (--at "fri 9:00", --in 6h): state "scheduled" with
# scheduled_for (ms) and what start would use (queue: argv, space, parent). The scheduler's tick
# (tick.py's due_pass) queues it once that time comes, also a time passed while the machine was
# off, and the queue starts it as any queued task (after its --after tasks, when there's room).

def scheduled_at(args):
    """--at / --in as a moment (ms), or None when neither was given."""
    at, within = getattr(args, "at", None), getattr(args, "in_", None)
    if at is None and within is None:
        return None
    return when_from(at, within)


def schedule(s, t, at, plan=None):
    if t["state"] not in ("todo", "scheduled", "queued"):
        raise Fail(f"{s.ref(t)} has already started ({STATUSES.get(t['state'], t['state'])}); only a task not started yet can be scheduled.")
    t["state"], t["scheduled_for"] = "scheduled", at
    if plan is not None:
        t["queue"] = plan
    for k in ("queued_at", "held"):
        t.pop(k, None)
    s.dirty = True


def unschedule(t):
    """Back to To do, as if never scheduled (a task that isn't scheduled is left as it is)."""
    if t["state"] != "scheduled":
        return
    t["state"] = "todo"
    for k in ("scheduled_for", "queue", "queued_at", "held"):
        t.pop(k, None)


def ensure_scheduler_quietly():
    try:
        ensure_scheduler(quiet=True)
    except Exception:
        pass


# A new worktree task's base in a repo on Azure DevOps whose remote has it, when nothing else picks one.
ADO_BASE = "develop"


def set_base(s, t, base, space=None, new=False):
    """--base: the branch a worktree task branches from and merges into (its pull request's base).
    Without it a new task takes its space's base branch (Shepherdr settings > Tasks > Base branch,
    as Shepherdr's space.base: captured when added, so a later change only touches new tasks);
    unset, develop on Azure DevOps when its remote has one (SHEP-32), else the folder's current
    branch, kept unmarked. "" goes back to the folder's."""
    if base is None:
        if not (new and t.get("mode") == "worktree"):
            return
        main = s.loc["folder"]
        own, by = local.base(main) or space_base(s, space), "space"
        if not own and ado.repo_in(main) and current_base(main) != ADO_BASE and on_remote(main, ADO_BASE):
            own, by = ADO_BASE, "ado"
        if own and own != current_base(main):
            try:
                base_ref(main, own)
            except Fail as e:
                if by == "ado":
                    return
                raise Fail(f"This space's base branch is {own} (Shepherdr settings > Tasks > Base branch), but: {e} "
                           "Change the setting, or pass --base.")
            t["base"], t["base_set"], t["base_by"] = own, True, by
        return
    t.pop("base_by", None)
    base = base.strip()
    if t.get("worktree"):
        return move_base(s, t, base)
    if not base:
        t.pop("base", None)
        t.pop("base_set", None)
        return
    if t.get("mode") != "worktree":
        raise Fail("--base is for tasks in a worktree; this one works in the folder itself.")
    main = s.loc["folder"]
    base_ref(main, base)
    if base == current_base(main):
        t.pop("base", None)
        t.pop("base_set", None)
    else:
        t["base"], t["base_set"] = base, True


def base_gone(s, t, base):
    """SHEP-106: a started task's base branch went (the remote has it no more; with no remote, the repo
    here), or it merged into base: a task here on that branch merged, or the branch is in base."""
    main, old = s.loc["folder"], t.get("base") or "main"
    has = lambda ref: git(main, "show-ref", "--verify", "--quiet", ref)[0]
    remote = remote_of(main)
    if remote in git(main, "remote")[1].split():
        ok, out, _ = git_quick(main, "ls-remote", "--heads", remote, f"refs/heads/{old}")
        if ok and not out:
            return True
    elif not has(f"refs/heads/{old}"):
        return True
    if any(u is not t and u.get("branch") == old and u.get("merged") and (u.get("base") or "main") == base
           for u in s.data.get("tasks") or []):
        return True
    return has(f"refs/heads/{old}") and git(main, "merge-base", "--is-ancestor", f"refs/heads/{old}", base)[0]


def move_base(s, t, base):
    """SHEP-106: `edit --base` on a started task, only when its base branch is gone or merged into the new
    one (a stacked task whose task below merged). Its base moves; a pull request no longer open is dropped,
    and an open one from its branch into the new base (its agent opened it) is recorded instead, so ready
    never opens a second. Returns what to run to move its branch, for the person."""
    old = t.get("base") or "main"
    if not base or base == old:
        raise Fail(f"{s.ref(t)} already has its worktree from {old}; its base can't change now.")
    main = s.loc["folder"]
    base_ref(main, base)
    if not base_gone(s, t, base):
        raise Fail(f"{s.ref(t)} already has its worktree from {old}; its base can't change now ({old} still exists "
                   f"and isn't merged into {base}).")
    up = next((u for u in s.data.get("tasks") or [] if u is not t and u.get("branch") == old), None)
    tip = branch_tip_of(s, up) if up else None
    t["base"], t["base_set"] = base, True
    t.pop("base_by", None)
    if str(t.get("attention") or "").startswith(("The pull request was closed", RESTACK_NEEDS)):
        t.pop("attention", None)
        t.pop("attention_at", None)
    notes = [f"{s.ref(t)} now merges into {base} (was {old})."]
    pr = t.get("pr")
    if pr:
        v = pr_view(t)
        if v and v.get("state") == "OPEN" and not ado.owns(pr.get("repo")):
            ok, _, err = gh("pr", "edit", str(pr["number"]), "--repo", pr["repo"], "--base", base)
            notes.append(f"Pull request #{pr['number']} now targets {base}." if ok else
                         f"Couldn't move pull request #{pr['number']} to {base} ({err}): change its base on GitHub.")
        elif v and v.get("state") == "OPEN":
            notes.append(f"Pull request #{pr['number']} is still open: change its target branch to {base} on Azure DevOps.")
        elif v and v.get("state") != "MERGED":
            t.pop("pr")
            notes.append(f"Its closed pull request #{pr['number']} is forgotten.")
    repo = github(s)
    if not t.get("pr") and repo and not ado.owns(repo):
        found = pr_for_branch(t, repo)
        if found:
            t["pr"] = {"number": found["number"], "url": found["url"], "repo": repo}
            notes.append(f"Its open pull request #{found['number']} into {base} is recorded ({found['url']}).")
        else:
            notes.append(f"Its next ready opens a pull request into {base}.")
    br, wt = t.get("branch"), t.get("worktree")
    tip = tip or t.get("start")
    if tip and br and git(main, "merge-base", "--is-ancestor", tip, br)[0] \
            and not git(main, "merge-base", "--is-ancestor", tip, base)[0]:
        notes.append(f"Its branch still carries {old}'s commits: {rebase_hint(s, t, tip, base)}.")
    elif wt:
        notes.append(f"Its branch is already on {base}.")
    s.dirty = True
    return " ".join(notes)


def set_notes(t, args):
    """--start-notes / --finish-notes: this task's own, replacing its folder's ("" goes back to the folder's)."""
    for which in ("start", "finish"):
        v = getattr(args, f"{which}_notes", None)
        if v is not None and v.strip():
            t[f"{which}_notes"] = v.strip()
        elif v is not None:
            t.pop(f"{which}_notes", None)


def cmd_show(args):
    with open_store(args, write="try") as s:
        t = s.find(args.id)
        live = [detail(k) for k in live_agents(s.key(t))]
        refresh_sessions(s, t, live)
        # Back at work since it said ready: saved at once, so the Accept card (which reads this)
        # says it's Working, not Ready.
        if busy_again(t, live):
            back_to_work(s, t, "its agent is at work again")
        v = view(s, t, live)
        if t["state"] == "queued":
            v["reason"] = queue_reason(s, t)
        v["settings"] = task_settings(s, t)
        on, rounds = review_limits(s, t)
        if on:
            v["review_rounds"] = {"used": rounds_used(t), "of": rounds, "added": int(t.get("review_rounds_added") or 0)}
        v["after_refs"] = after_refs(s, t)
        block = settings_block(s, t)
        if getattr(args, "evidence", False):
            # What the Accept card shows: commits, files, checks and the proof (proof.py).
            v["evidence"] = evidence(s, t)
    text = [line(v), f"folder: {v['folder']}"]
    if v.get("worktree"):
        text.append(f"worktree: {v['worktree']} (branch {v['branch']}, base {v.get('base')})")
    elif v.get("branch") and v.get("mode") == "worktree":
        text.append(f"branch: {v['branch']} (set for this task)")
    if v.get("base_set"):
        text.append(f"merges into: {v['base']} (" + {"space": "its space's base branch", "ado": "Herdr's default on Azure DevOps"}
                    .get(v.get("base_by"), "set for this task") + ")")
    if v.get("after_refs"):
        text.append("comes after: " + ", ".join(v["after_refs"]))
    if v.get("review_rounds"):
        r = v["review_rounds"]
        text.append(f"review rounds: {r['used']} of {r['of']} used" + (f" ({r['added']} added by the assistant)" if r["added"] else "")
                    + (" (ready refused: out of rounds)" if v.get("review_out") else ""))
    if v.get("agents_md"):
        text.append(f"for AGENTS.md: {v['agents_md']}")
    if v.get("pr"):
        text.append(f"pull request: #{v['pr']['number']} {v['pr']['url']}")
    if v.get("why") and v["status"] == "needs":
        text.append(f"needs the person: {v['why']}")
    if v.get("pull"):
        text.append(f"needs the person: {ado_flow.card(v['pull'])}\n  run: {v['pull'].get('command')}\n  (it goes once the main checkout has the merge, or: herdr-task dismiss {s.ref(t)})")
    if v.get("proof"):
        text.append(f"proof: {v['proof']['title']} ({v['proof']['id']})")
    for b in v.get("sent_back") or []:
        # SHEP-87: each time the person sent it back from its Accept card, with their note
        text.append(f"{SENT_BACK} {time.strftime('%Y-%m-%d %H:%M', time.localtime(b['at'] / 1000))}: {b['note']}"
                    + (f" (about {b['on']})" if b.get("on") else ""))
    if v.get("archived"):
        text.append(f"archived: {time.strftime('%Y-%m-%d %H:%M', time.localtime(v['archived'] / 1000))} (still kept; writing to it brings it back)")
    for k in v["live"]:
        text.append(f"agent: {k['address']} {k['status'] or ''}")
    if v.get("prompt"):
        text.append("\n" + v["prompt"].strip())
    text.append("\n" + block)
    say(args, v, "\n".join(text))


def begin(s, t, argv, space, parent=None, custom=False):
    """Starts the task's first agent. Returns its record."""
    t["state"], t["started"] = "running", now()
    # Its brief teaches `reviewed`: ready waits for a review of its final commit (review_refusal).
    t["review_gate"] = True
    for k in ("queue", "queued_at", "attention", "held", "scheduled_for"):
        t.pop(k, None)
    if t.get("mode") == "worktree" and not t.get("worktree") and not worktrees_on(s, space):
        t["mode"] = "here"
    folder_for(s, t)
    if t.get("mode") != "worktree" and s.loc["kind"] == "repo":
        # The folder's commit as it starts: still there, and nothing tracked changed, at ready means
        # it changed nothing, so there is nothing to review (review_refusal, #744).
        t["folder_start"] = git(s.loc["folder"], "rev-parse", "HEAD")[1] or None
    parent = parent_for(parent, space)
    return launch(s, t, argv, space, brief(s, t, parent, space, argv), parent=parent, **({"custom": True} if custom else {}))


# #1053: an agent just launched still shows its shell for a moment (agent_running() says no): a task
# whose agent started this recently is starting, never started a second time.
STARTING_MS = 120000


def just_started(t):
    """The agent its queue or a start launched moments ago, while it is Working: its record, or None."""
    fresh = [a for a in t.get("agents") or [] if now() - (a.get("at") or 0) < STARTING_MS]
    return fresh[-1] if t.get("state") == "running" and fresh else None


def cmd_start(args):
    with open_store(args) as s:
        t = s.find(args.id)
        live = [k for k in map(detail, live_agents(s.key(t))) if agent_running(k)] or [a for a in [just_started(t)] if a]
        if live:
            raise Fail(f"{s.ref(t)} is already running ({live[0]['address']}). Use switch or resume.")
        if t["state"] == "done":
            raise Fail(f"{s.ref(t)} is done. Reopen it first.")
        if args.here:
            t["mode"] = "here"
        elif args.worktree and worktrees_on(s):
            t["mode"] = "worktree"
        set_branch(s, t, getattr(args, "branch", None))
        q = t.get("queue") or {}
        space = bare(args.space) or bare(q.get("space")) or default_space(s.loc["folder"], parent=args.parent or q.get("parent"))
        changed = any(getattr(args, k, None) is not None for k in ("launcher", "model", "effort", "set"))
        if changed:
            set_opts(t, args, launcher=worker_pick(s, t, space).get("launcher"))
        argv = agent_argv(None, args.argv) if args.argv else worker_argv(s, t, space, args.agent) if args.agent else \
            (worker_argv(s, t, space) if changed else q.get("argv") or worker_argv(s, t, space))
        parent = args.parent or q.get("parent")
        plan = {"argv": argv, "space": space, "parent": parent, **({"custom": True} if args.argv or (not changed and not args.agent and q.get("custom")) else {})}
        at = scheduled_at(args)
        if at:
            # start --at / --in: it starts by itself then, as this start would now.
            schedule(s, t, at, plan)
            v = view(s, t)
            reason = "scheduled"
        # A queued task started again goes now; otherwise it waits its turn. A scheduled one
        # started now waits only for the queue (start --now: not even that).
        elif (reason := None if (t["state"] == "queued" or args.now) else queue_reason(s, t)):
            t["state"], t["queued_at"] = "queued", now()
            t.pop("scheduled_for", None)
            t["queue"] = plan
            s.dirty = True
            v = view(s, t)
        else:
            a = begin(s, t, argv, space, parent, **({"custom": True} if args.argv or q.get("custom") else {}))
            v = view(s, t)
    # The scheduler starts queued tasks and tells the Assistant its tasks' news.
    try:
        ensure_scheduler(quiet=True)
    except Exception:
        pass
    if reason == "scheduled":
        say(args, v, f"{s.ref(t)} is scheduled: {v['why']}. It starts by itself then.")
        return
    if reason:
        say(args, {**v, "queued": True, "reason": reason}, f"{s.ref(t)} is queued ({reason}). It starts by itself when it can.")
        return
    out = {**v, "terminal": a["address"], "space": space, "parent": a.get("parent")}
    text = f"{s.ref(t)} started: {a['address']} in {folder_desc(t, s)}"
    # Codex's sandbox can't start here (SHEP-227, #998): whoever started it hears why and the fix, once per start.
    broken = sandbox.check() if sandbox.sandboxed(argv) else None
    if broken:
        out["sandbox"] = sandbox.notice(broken)
        text += "\n\n" + out["sandbox"]
    say(args, out, text)


def folder_desc(t, s):
    return f"{t['worktree']} ({t['branch']})" if t.get("worktree") else s.loc["folder"]


def ready_words(args):
    """The ready summary in one line, refused past SUMMARY_MAX (as Shepherdr's) before anything
    changes; --details, any length, as written; --explain (the plain-words explanation the Accept card
    leads with) as written, and each --check (what the person should look at) one short line."""
    said = " ".join(str(args.summary or "").split())
    if len(said) > SUMMARY_MAX:
        raise Fail(f"That summary is {len(said)} characters: write a shorter one, {SUMMARY_MAX} at most, in plain words on "
                   f"what the person now sees or can do (no file names, flags or jargon). Put the detail in --details \"…\" "
                   f"(a few short bullets in plain words, folded in the Accept card) or in your proof, then run ready again.")
    explain = str(getattr(args, "explain", None) or "").strip()
    checks = [" ".join(str(c).split()) for c in (getattr(args, "check", None) or [])]
    return said, str(args.details or "").strip(), explain, [c for c in checks if c]


def cmd_ready(args):
    said, details, explain, checks = ready_words(args)
    with open_store(args) as s:
        t = s.find(args.id)
        me = os.environ.get("HC_TERMINAL_ID")
        if me and any(a["address"] == me for a in t["agents"]):
            refresh_sessions(s, t, [k for k in live_agents(s.key(t)) if k["address"] == me])
        if t["state"] == "done":
            raise Fail(f"{s.ref(t)} is already done.")
        wt = t.get("worktree") if t.get("mode") == "worktree" else None
        if wt and os.path.isdir(wt):
            if git(wt, "status", "--porcelain", "--untracked-files=no")[1]:
                raise Fail(f"{wt} has uncommitted changes. Commit them, then run ready again.")
            t["head"] = git(wt, "rev-parse", "HEAD")[1]
            own_work(s, t)
        refused = review_refusal(s, t, wt)
        if refused:
            # Kept (the task's line says why it waits); refused after the store is saved.
            s.dirty = True
        else:
            # A new summary brings its own details, explanation and checks (or none): an older one's would be stale.
            if said:
                t["summary"] = said
            for k, v in (("details", details), ("explain", explain), ("to_check", checks)):
                if v:
                    t[k] = v
                elif said:
                    t.pop(k, None)
            # Its proof artifact (--proof <id>, else its newest one titled "... · Proof"), linked from
            # the person's Accept card.
            proof = find_proof(s, t, getattr(args, "proof", None))
            if proof:
                t["proof"] = proof
            else:
                t.pop("proof", None)
            asked = next((x["value"] for x in task_settings(s, t) if x["label"] == "Proof"), False)
            note = " ".join(str(args.agents_md or "").split())
            if note:
                # "For AGENTS.md": what the next agent would need about setting up or testing this
                # repo; the Assistant decides whether it goes into the repo's AGENTS.md.
                t["agents_md"] = note[:300]
            for k in ("attention", "attention_at", "handed_at", "fix_requested", "progress", "retry", "review_out", "back"):
                t.pop(k, None)
            # Its agents' turns now: a later turn of theirs takes it back to work (busy_again()).
            t["ready_turns"] = ready_turns(live_agents(s.key(t)))
            # SHEP-95: in the folder itself, what it left behind now: a later turn that changes none of it (it only
            # answered a question) puts it back in Ready (tick's settle_back()).
            if t.get("mode") == "worktree":
                t.pop("here_mark", None)
            else:
                t["here_mark"] = here_mark(s, t)
            s.dirty = True
    if refused:
        raise Fail(refused)
    with open_store(args) as s:
        t = s.find(args.id)
        # Its review is the agent's own, as its brief's Settings block says (herdr-task starts no
        # reviewers). A worktree branch with nothing beyond its base (none of its own, or only its
        # base caught up with: a research or artifact-only task) still waits in Ready for the
        # person's Accept, its summary, details and artifacts on the card (SHEP-96); no pull request,
        # and Accept just marks it done and cleans up its worktree.
        if wt and t.get("start") and in_base(s, t) and not merged_here(s, t):
            t["nothing_to_merge"] = True
        else:
            t.pop("nothing_to_merge", None)
        # Its work already in its base (SHEP-59: its pull request squash-merged, or nothing left to
        # merge): done at once, never a second pull request.
        gone = already_merged(s, t) if wt and t.get("start") and not t.get("nothing_to_merge") else None
        if gone is not None:
            t["merged"] = True
            if gone:
                watch_main(s, t, (gone.get("mergeCommit") or {}).get("oid"))
                update_main(s, t)
            finish(s, t, even_if_busy=True)
            v = view(s, t)
            how = f"pull request #{gone['number']} is merged" if gone else f"its work is already in {t.get('base') or 'main'}"
            say(args, v, f"{s.ref(t)}: {how}; done.")
            return
        msg = finalize(s, t)
        # Its own background work still running (SHEP-148): the task shows Working until it ends.
        log = agent_log(t, me) if me else None
        jobs = background_jobs(log)[0] if log else {}
        if jobs and t["state"] == "ready":
            msg += (f" {len(jobs)} background job{'s' if len(jobs) > 1 else ''} of yours still run{'' if len(jobs) > 1 else 's'}: "
                    "the task shows Working until they end, then Ready. Stop any you don't need (a server, a watcher).")
        if proof:
            msg += f" Proof: {proof['title']}."
        elif asked:
            msg += (" No proof artifact found, and your Settings block asks for one: publish it (herdr-artifact), "
                    "then run ready again with --proof <its id>.")
        v = view(s, t)
    say(args, v, msg)
    if msg.startswith(f"{s.ref(t)} {READY_BUT}"):
        sys.exit(1)  # its push or pull request failed: not ready the way it meant (#795)


REVIEWED = ("report", "pass", "changes")  # a recorded review round (report: the agent's own reviewed)


def rounds_used(t):
    return sum(1 for r in t.get("reviews") or [] if r.get("result") in REVIEWED)


def review_refusal(s, t, wt):
    """Why ready is refused for review (as Shepherdr's: `ready` waits for a review of the final
    commit), or None. Only tasks whose brief taught `reviewed` (review_gate) and whose Settings
    block says Review: on. A worktree task's final commit must be one a round was recorded on; a
    task in the folder itself needs a round recorded since it started. Out of rounds, only the
    Assistant adds one (review-more): the task then waits, saying so (review_out)."""
    on, rounds = review_limits(s, t)
    if not on or not t.get("review_gate"):
        return None
    if wt and t.get("start") and in_base(s, t):
        return None  # no commits of its own: nothing to review (nothing to merge)
    if not wt and t.get("folder_start") and unchanged_folder(s, t):
        return None  # in the folder itself, and it changed nothing (#744: a run that only reads)
    revs = [r for r in t.get("reviews") or [] if r.get("result") in REVIEWED and (r.get("at") or 0) >= (t.get("started") or 0)]
    head = t.get("head") if wt else None
    if (any(r.get("head") == head for r in revs) if wt else bool(revs)):
        return None
    if wt and head and base_merges_only(s, t, wt, {r.get("head") for r in revs if r.get("head")}, head):
        return None
    ref, ht, folder = s.ref(t), own_path(), shlex.quote(s.loc["folder"])
    what = f"your final commit {head[:7]}" if head else "this task's work"
    seen = sorted({r["head"][:7] for r in revs if r.get("head")}) if wt else []
    if seen:
        what += f" (rounds are recorded on {', '.join(seen)})"
    if rounds_used(t) >= rounds:
        t["review_out"] = now()
        return (f"All {rounds} review rounds are used and {what} isn't reviewed. A fix made after the last round needs a round "
                f"of its own: say why in your chat (what the fix changed), set your status line to it, and end your turn: only "
                f"your Assistant can add a round (herdr-task review-more {ref}).")
    return (f"Review is on and {what} isn't reviewed. Have it reviewed as your brief says, fix what must be fixed, record the "
            f"round with `{ht} reviewed {ref} --folder {folder} --report \"<findings, a line>\"` (on the commit you'd say "
            f"ready at), then run ready again. {rounds - rounds_used(t)} of {rounds} rounds left.")


def unchanged_folder(s, t):
    """A task in the folder itself left it as it started: on the same commit, nothing tracked changed."""
    folder = s.loc["folder"]
    ok, head, _ = git(folder, "rev-parse", "HEAD")
    clean, changed, _ = git(folder, "status", "--porcelain", "--untracked-files=no")
    return ok and head == t["folder_start"] and clean and not changed


def base_merges_only(s, t, wt, reviewed, head):
    """#741: everything after a reviewed commit (along the branch's first parents) is clean merges
    from its base branch (here or on its remote): each merge's other parent is in the base, and its
    tree is exactly what git's own merge of its two parents gives. Nothing of its own to review; a
    merge with conflicts, or with anything changed beyond the plain merge, still needs a round."""
    main, base = s.loc["folder"], t.get("base") or "main"
    bases = [base, f"refs/remotes/{remote_of(main)}/{base}"]
    c = head
    for _ in range(100):
        if c in reviewed:
            return c != head
        ok, line, _ = git(wt, "rev-list", "--parents", "-n", "1", c)
        parts = line.split() if ok else []
        if len(parts) != 3:
            return False  # a commit of its own (or an octopus): reviewed as usual
        _, first, other = parts
        if not any(git(wt, "merge-base", "--is-ancestor", other, b)[0] for b in bases):
            return False
        ok, tree, _ = git(wt, "merge-tree", "--write-tree", first, other)
        if not ok or not tree or tree.split()[0] != git(wt, "rev-parse", f"{c}^{{tree}}")[1]:
            return False
        c = first
    return False


def cmd_reviewed(args):
    """A task's agent records one review round of its current commit (its own review: a helper agent
    it started as its hc child, as its brief says). Uses one of its Review rounds; `ready` then accepts that
    commit. Out of rounds it is refused: only the Assistant adds one (review-more)."""
    with open_store(args) as s:
        t = s.find(args.id)
        if t["state"] not in ("running", "ready"):
            raise Fail(f"{s.ref(t)} isn't being worked on ({STATUSES.get(t['state'], t['state'])}).")
        on, rounds = review_limits(s, t)
        if not on:
            raise Fail(f"Review is off for {s.ref(t)}: there is no round to record.")
        used = rounds_used(t)
        if used >= rounds:
            raise Fail(f"All {rounds} review rounds of {s.ref(t)} are used. Say why in your chat and end your turn: only your "
                       f"Assistant can add a round (herdr-task review-more {s.ref(t)}).")
        wt = t.get("worktree") if t.get("mode") == "worktree" else None
        head = None
        where = wt if wt and os.path.isdir(wt) else (s.loc["folder"] if s.loc["kind"] == "repo" else None)
        named = getattr(args, "commit", None)
        if named:
            # The commit the round reviewed (#797), fixes perhaps committed since: one on this branch.
            ok, head, _ = git(where, "rev-parse", "--verify", "--quiet", f"{named}^{{commit}}") if where else (False, "", "")
            if not ok or not head:
                raise Fail(f"--commit {named} isn't a commit here.")
            if not git(where, "merge-base", "--is-ancestor", head, "HEAD")[0]:
                raise Fail(f"--commit {named} isn't on this task's branch (HEAD or before it).")
        elif wt and os.path.isdir(wt):
            if git(wt, "status", "--porcelain", "--untracked-files=no")[1]:
                raise Fail(f"{wt} has uncommitted changes: a review is of a commit. Commit first, then review it "
                           "(or name the commit it reviewed with --commit).")
            head = git(wt, "rev-parse", "HEAD")[1]
        elif s.loc["kind"] == "repo":
            head = git(s.loc["folder"], "rev-parse", "HEAD")[1] or None
        text = " ".join(str(args.report or "").split())[:2000]
        t.setdefault("reviews", []).append({"round": used + 1, "result": "report", "text": text, "at": now(), "head": head,
                                            "by": os.environ.get("HC_TERMINAL_ID")})
        t.pop("review_out", None)
        s.dirty = True
        v = view(s, t)
    on_what = f" for commit {head[:7]}" if head else ""
    say(args, {**v, "round": used + 1, "rounds": rounds}, f"{s.ref(t)}: review round {used + 1} of {rounds} recorded{on_what}.")


def cmd_review_more(args):
    """The Assistant gives a task exactly one more review round (as Shepherdr's `task review-more`):
    only once all its rounds are used. The limit stops an agent reviewing for ever, so the task's
    own agent can never raise it. Its agent is told."""
    labels = caller_labels()
    with open_store(args) as s:
        t = s.find(args.id)
        if labels.get("herdr.task") == s.key(t) or labels.get("herdr.role") == "reviewer":
            raise Fail("A task's own agent can't add review rounds: say why in your chat and end your turn; your Assistant decides.")
        on, rounds = review_limits(s, t)
        if not on:
            raise Fail(f"Review is off for {s.ref(t)}.")
        if t["state"] == "done":
            raise Fail(f"{s.ref(t)} is already done; it needs no more review.")
        used = rounds_used(t)
        if used < rounds:
            raise Fail(f"{s.ref(t)} has used {used} of {rounds} review rounds; add one only when they are all used.")
        t["review_rounds_added"] = int(t.get("review_rounds_added") or 0) + 1
        t.pop("review_out", None)
        s.dirty = True
        live = workers(s, t)
        told = None
        if live:
            ht, folder = own_path(), shlex.quote(s.loc["folder"])
            from .news import send_or_hold
            r = send_or_hold(live[-1]["address"],
                     f"Your Assistant added one review round to {s.ref(t)}: {rounds + 1} in all. Have your final commit reviewed, "
                     f"record it with `{ht} reviewed {s.ref(t)} --folder {folder} --report \"<findings, a line>\"`, then run ready again.")
            told = live[-1]["address"] if r else None
        v = view(s, t)
    say(args, {**v, "rounds": rounds + 1, "told": told},
        f"{s.ref(t)} may now use {rounds + 1} review rounds" + (f"; told {told}." if told else "; no agent is running to tell."))


def parse_left(text):
    """Time left as an agent writes it: 5m, 90s, 1h, 1h30m, 2 (minutes); in ms."""
    t = str(text).strip().lower().replace(" ", "")
    if re.fullmatch(r"\d+(?:\.\d+)?", t):
        return int(float(t) * 60000)
    parts = re.findall(r"(\d+(?:\.\d+)?)(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)", t)
    if not parts or "".join(a + b for a, b in parts) != t:
        raise Fail(f"--left takes a time like 5m, 90s or 1h30m, not \"{text}\".")
    return int(sum(float(n) * {"h": 3600000, "m": 60000, "s": 1000}[u[0]] for n, u in parts))


def cmd_status(args):
    """A task agent says what it's doing, how far along it is and the time left, at the start, at
    each natural step and at least every 5 minutes (as Shepherdr's `shepherdr status`). Herdr guesses nothing: it shows
    what the agent said and counts the minutes down while it works."""
    text = " ".join(str(args.text or "").split())
    if not text:
        raise Fail("Say what you're doing: herdr-task status <id> \"Fixing the two failing tests\" --done 40 --left 5m")
    if args.done is not None and not 0 <= args.done <= 100:
        raise Fail("--done is a percentage, 0 to 100.")
    left = parse_left(args.left) if args.left else None
    cant = " ".join(str(getattr(args, "cant_fix", None) or "").split())
    with open_store(args) as s:
        t = s.find(args.id)
        if t["state"] not in ("running", "ready"):
            raise Fail(f"{s.ref(t)} isn't being worked on ({STATUSES.get(t['state'], t['state'])}); nothing to report.")
        shown = fit(text)
        # set: when it was said ("at" moves on while it waits, for the minutes left). A --cant-fix line is its agent
        # giving up (SHEP-96): by marks it so it never reads as the agent on it (on_it()), and the task Needs you.
        t["progress"] = {"text": shown, "at": now(), "set": now(), **({"done": args.done} if args.done is not None else {}),
                         **({"left": left} if left is not None and not cant else {}), **({"by": "cant-fix"} if cant else {})}
        if cant:
            ado_flow.cant_fix(s, t, cant)
        s.dirty = True
        v = view(s, t, [detail(k) for k in live_agents(s.key(t))])
    note = f" Cut to {LINE_MAX} characters: \"{shown}\". Keep it shorter next time." if shown != text else ""
    # Every status gives the time left, a rough guess beats none (SHEP-13): one without it asks for it.
    if left is None:
        note += " Add --left with your best guess of the time left (like 20m) to every status."
    say(args, {**v, "cut": shown != text}, f"{s.ref(t)}: {shown}" + (f" · {args.done}%" if args.done is not None else "")
        + (f" · ~{minutes(round(left / 60000))} left" if left is not None else "") + "." + note)


ALERT = "herdr.alert"


def cmd_alert(args):
    """An agent tells the person something that can't wait (as Shepherdr's `shepherdr alert`): a
    toast and a sound in every Herdr window. Never asks permission. A task's agent (or an alert
    --task names) always reaches the person; an Assistant's follows its space's Notify (Off:
    nothing). It sets the core label herdr.alert on the caller's own terminal, which every Herdr
    client sees at once, here or on another machine; Herdr shows each new one once (inbox.js)."""
    title, body = " ".join(str(args.title or "").split()), " ".join(str(args.body or "").split())
    if not title:
        raise Fail("Say what can't wait: herdr-task alert \"Deploy is down\" --body \"Checks fail on main since 12:40\"")
    if len(title) > 240 or len(body) > 4000:
        raise Fail("Keep an alert short: a title and a line or two of why.")
    me = os.environ.get("HC_TERMINAL_ID")
    if not me:
        raise Fail("Run it from an agent's own terminal (there's no HC_TERMINAL_ID here).")
    labels = caller_labels()
    ref = None
    if args.task:
        with open_store(argparse.Namespace(folder=args.folder, id=args.task), write=False) as s:
            ref = s.ref(s.find(args.task))
    elif labels.get("herdr.task"):
        # Its own task: "<slug>#<n>" -> HERD-44, from that list's prefix.
        slug, _, n = labels["herdr.task"].rpartition("#")
        try:
            with open(os.path.join(STORE, f"{slug}.json")) as f:
                pre = json.load(f).get("prefix")
        except (OSError, ValueError):
            pre = None
        ref = f"{pre}-{n}" if pre else None
    # The label holds what a toast shows (inbox.js cuts it again to fit).
    alert = {"id": secrets.token_hex(4), "at": now(), "title": title[:120], "body": body[:300],
             **({"task": ref} if ref else {}), **({"about": True} if args.task else {})}
    r = run(["hc", "label", me, f"{ALERT}={json.dumps(alert, ensure_ascii=False, separators=(',', ':'))}"])
    if r.returncode != 0:
        raise Fail((r.stderr or r.stdout).strip() or "hc label failed")
    say(args, alert, "Alert sent.")


def back_to_work(s, t, why, said=WORKING_AGAIN, auto=False):
    """A Ready task taken back to work (herdr-task fix or resume, or its agent at work again):
    Working, its status line saying so until its agent reports, and no Accept until its next
    ready. why: what took it back, for its Assistant's news ("SHEP-7 is working again: why").
    auto: only its agent's own turn took it back (a message, a background job's notice), not a
    fix asked for: Ready again when that turn changed nothing (tick's settle_back())."""
    if t["state"] != "ready":
        return False
    t["state"] = "running"
    # SHEP-96: the commit the person accepted goes too: a pull request reported late needs their next Accept.
    for k in ("ready_turns", "merge_requested", "accepting", "pr_requested", "pr_accepted_head", "pr_request_failed"):
        t.pop(k, None)
    t["back"] = {"at": now(), "why": why, **({"auto": True, "progress": t.get("progress")} if auto else {})}
    # by: Herdr's words, not its agent's (on_it() counts only an agent's own line).
    t["progress"] = {"text": fit(said), "at": now(), "set": now(), "by": "herdr"}
    s.dirty = True
    return True


READY_BUT = "is ready, but:"  # finalize() couldn't push or open its pull request


def finalize(s, t):
    """Ready: on GitHub its pull request opens; then the merge policy in Settings decides who
    merges: auto (now), checks (once its checks pass) or ask (the person). Returns what to say."""
    wt = t.get("worktree")
    local = t.get("mode") != "worktree" or not wt or t.get("nothing_to_merge")
    # SHEP-96: on Azure DevOps ready pushes nothing and opens no pull request; the person's Accept has its agent open it.
    later = not local and os.path.isdir(wt) and ado_flow.pr_on_accept(s, t)
    agent_pr = bool(t.get("pr") and ado.owns(t["pr"].get("repo")))
    repo = github(s) if not local and not later and not agent_pr and os.path.isdir(wt) else None
    failed = None
    if later:
        t["pr_on_accept"] = True
    else:
        t.pop("pr_on_accept", None)
    if repo:
        # Pushed and opened before it shows Ready: the push lets the task list go while its hooks run
        # (#1007), and a Ready task without its pull request yet could be accepted (merged here) meanwhile.
        try:
            pr = pr_open(s, t, repo, t.get("summary"))
        except Fail as e:
            failed = str(e)
    elif not local and os.path.isdir(wt) and github_unreachable(s):
        # #988: a GitHub repo gh couldn't reach just now: never on as if it had no GitHub (Accept would
        # merge it here while a pull request, its agent's, stays open there).
        failed = f"Couldn't reach GitHub to open its pull request: {github_unreachable(s)}"
    t["state"], t["ready_at"] = "ready", now()
    # An accepted Azure DevOps pull request keeps waiting to merge (auto-complete stays on there).
    waits = bool(t.get("merge_wait") and (agent_pr or (repo and ado.owns(repo))))
    # SHEP-96: accepted already, its pull request asked of its agent and not recorded yet (it said ready again, after a
    # question, say): the request stands, never a second Accept.
    asked = bool(later and t.get("pr_requested") and not t.get("pr_request_failed"))
    for k in ("attention", "merge_requested", "review", "merge_wait", "accepting", "pr_requested", "stuck_head"):
        if not (k == "merge_wait" and waits) and not (k == "pr_requested" and asked):
            t.pop(k, None)
    if not asked:
        # a failed request ends with this ready: the person's next Accept asks again
        t.pop("pr_request_failed", None)
    (t.get("pr") or {}).pop("wait", None)
    s.dirty = True
    msg = f"{s.ref(t)} is ready."
    if local:
        # Nothing to merge (in the folder itself, or no commits beyond its base): it waits in Ready
        # for the person's Accept, whatever the merge setting; no pull request.
        t.pop("auto_merge", None)
        return msg + (" Nothing to merge (no commits beyond its base)." if t.get("nothing_to_merge") else "") + \
            " The person accepts it in the Tasks panel."
    if failed:
        t["attention"] = failed
        return f"{s.ref(t)} {READY_BUT} {failed} Tell the person."
    if agent_pr:
        msg += (f" Its pull request #{t['pr']['number']} on Azure DevOps stays as it is: push new commits to it yourself "
                "(git push), never a second one.")
    if agent_pr and not t["pr"].get("by_agent") and os.path.isdir(wt):
        # Opened at ready before SHEP-96: its new commits go to it as they did (a plain push, never a second pull request).
        names = git(s.loc["folder"], "remote")[1].split()
        ok, _, err = git(wt, "push", "origin" if "origin" in names else (names[0] if names else "origin"), t["branch"])
        if not ok:
            t["attention"] = f"Couldn't push {t['branch']} to its pull request: {err}"
            return f"{s.ref(t)} {READY_BUT} {t['attention']} Tell the person."
    if agent_pr and waits:
        return msg + " " + ado_flow.WAITS
    if asked:
        return msg + (" The person accepted it already: open its pull request as you were asked (ado-push-pr), then record it "
                      "with herdr-task pr.")
    if later:
        msg += (" On Azure DevOps nothing is pushed yet: the person reviews your branch, and once they accept it you're asked "
                "to open its pull request with the ado-push-pr skill.")
    if repo:
        pr["checked"] = 0
        # Working until its checks are done and its forge knows it can merge (the tick: pr_wait()).
        pr["wait"] = PR_CHECKS_RUNNING
        msg = (f"{s.ref(t)} is ready: pull request #{pr['number']}, {pr['url']}. It shows Working until its checks "
               f"pass and {ado.forge(repo)} says it can merge; a failing check or a conflict comes back to you to fix.")
    policy = merge_policy(s, t)
    if policy in ("auto", "checks"):
        t["auto_merge"] = policy
        if t.get("pr"):
            if policy == "auto":
                err = merge_now(s, t)
                return msg + (f" Merging it waits: {err}" if err else " Merged; done.")
            return msg + " It merges by itself once its checks pass."
        if later:
            # Accepted at once: Azure DevOps' auto-complete merges it once its checks pass, as "after checks" asks.
            try:
                ado_flow.request_pr(s, t, None, by_settings=True)
                return msg + " Settings say merge it by itself: the next message asks you to open its pull request."
            except Fail as e:
                return msg + f" {e}"
        try:
            sent, started = tell(s, t, local_merge_msg(s, t), None)
            t["merge_requested"] = now()
            return msg + " Settings say merge it right away: the next message says how."
        except Fail as e:
            t["attention"] = f"Couldn't ask for the merge: {e}"
    else:
        t.pop("auto_merge", None)
    return msg + " The person accepts it in the Tasks panel, which merges it."


def cmd_review(args):
    """A reviewer's verdict: --pass (on to merging) or --changes (back to the worker). Only for
    reviewers herdr-task started before task agents ran their own review: kept so they finish."""
    if bool(args.passed) == bool(args.changes or args.changes_file):
        raise Fail("Say --pass, or --changes with what must be fixed.")
    text = args.changes or ""
    if args.changes_file:
        with open(args.changes_file) as f:
            text = f.read()
    with open_store(args) as s:
        t = s.find(args.id)
        rv = t.pop("review", None) or {}
        cfg = settings_for(s, t.get("space"))["tasks"]
        of = rv.get("of") or int(cfg.get("review_rounds") or 1)
        n = rv.get("round") or len(t.get("reviews") or []) + 1
        rec = {"round": n, "result": "pass" if args.passed else "changes", "text": (text or args.notes or "").strip(),
               "at": now(), "head": t.get("head"), "by": os.environ.get("HC_TERMINAL_ID")}
        t.setdefault("reviews", []).append(rec)
        s.dirty = True
        if args.passed:
            msg = f"{s.ref(t)}: review round {n} passed. " + finalize(s, t)
        else:
            last = n >= of
            if t["state"] == "ready":
                t["state"] = "running"
            sent, _ = tell(s, t, (f"Review round {n} of {of} for {s.ref(t)} found what must be fixed before it can merge:\n{text.strip()}\n\n"
                                     f"Fix these, commit, then run `herdr-task ready {s.ref(t)} --folder {shlex.quote(s.loc['folder'])}` again"
                                     + (" (that was the last review round)." if last else " for the next round.")), None)
            msg = f"{s.ref(t)}: findings sent to {sent}."
        v = view(s, t)
    # This reviewer is finished: it ends a moment after this command returns.
    me = os.environ.get("HC_TERMINAL_ID")
    if me and rv.get("reviewer") == me:
        guard(["hc"])
        subprocess.Popen(["sh", "-c", 'sleep 4; hc kill "$1" >/dev/null 2>&1; sleep 2; hc rm "$1" >/dev/null 2>&1', "x", me],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    say(args, v, msg)


def cmd_state(args, state):
    with open_store(args) as s:
        t = s.find(args.id)
        if state == "reopen":
            state = "running" if t.get("started") and t["state"] not in ("queued", "scheduled") else "todo"
            # #844: reopened after its pull request merged: it stays open (the tick would find that
            # pull request merged and close it again at once) until its agent says ready.
            if t["state"] == "done" and t.get("merged"):
                t["kept_open"] = True
            for k in ("reviews", "review", "auto_merge", "merged", "nothing_to_merge", "accepted_at", "accepting", "merge_queued", "merge_wait", "pull"):
                t.pop(k, None)
        if state == "done" and t.get("worktree") and merged_here(s, t):
            t["merged"] = True
            # SHEP-106: merged here by its agent (local_merge_msg()), which deletes its branch: stacked tasks move.
            restack(s, t)
        t["state"] = state
        t[{"done": "done_at", "running": "reopened_at", "todo": "reopened_at"}[state]] = now()
        if state != "done":
            unarchive(s, t)
        for k in ("merge_requested", "attention", "queue", "queued_at", "progress", "retry", "scheduled_for", "held") if state != "running" else ("attention", "scheduled_for"):
            t.pop(k, None)
        s.dirty = True
        v = view(s, t)
    say(args, v, f"{s.ref(t)} is done." if state == "done" else f"{s.ref(t)} is {state}.")


def cmd_unarchive(args):
    with open_store(args) as s:
        t = s.find(args.id)
        was = bool(t.get("archived"))
        unarchive(s, t)
        v = view(s, t)
    say(args, v, f"{s.ref(t)} is back in its list." if was else f"{s.ref(t)} isn't archived.")


def cmd_edit(args):
    with open_store(args) as s:
        t = s.find(args.id)
        old = t["title"]
        if args.title is not None:
            t["title"] = args.title.strip() or t["title"]
        if args.prompt is not None:
            t["prompt"] = args.prompt
        if args.prompt_file:
            with open(args.prompt_file) as f:
                t["prompt"] = f.read()
        pick = [t.get(k) for k in ("agent", "launcher", "model", "effort")]
        set_opts(t, args, launcher=worker_pick(s, t, t.get("space")).get("launcher"))
        if [t.get(k) for k in ("agent", "launcher", "model", "effort")] != pick:
            # The next agent started for it runs on the new choice (start_again), a queued one too.
            t["pick_at"] = now()
            q = t.get("queue") or {}
            if q.get("argv") and not q.get("custom"):
                q["argv"] = worker_argv(s, t, q.get("space"))
        moved = set_base(s, t, args.base)
        set_notes(t, args)
        if args.after is not None:
            set_after(s, t, *parse_after(s, args.after))
        at = scheduled_at(args) if (args.at or "").strip() or args.in_ is not None else None
        if at:
            schedule(s, t, at)
        elif args.at is not None:
            unschedule(t)  # --at "": back to To do
        if args.here or args.worktree:
            if t["state"] not in ("todo", "scheduled", "queued"):
                raise Fail("Where a task works can only change before it starts.")
            if args.worktree and s.loc["kind"] != "repo":
                raise Fail("Worktrees need a git repo.")
            t["mode"] = "here" if args.here else "worktree"
        if t["mode"] != "worktree" and not t.get("worktree"):
            t.pop("branch", None)
        set_branch(s, t, getattr(args, "branch", None))
        s.dirty = True
        tabs = task_tabs(s, t) if t["title"] != old else []
        v = view(s, t)
    left = name_tabs([(tab, tab_title(s, t)) for tab in tabs])
    if at:
        ensure_scheduler_quietly()
    say(args, {**v, "rename": left, **({"moved": moved} if moved else {})},
        f"{s.ref(t)} saved" + (f": {v['why']}." if v["status"] == "scheduled" else ".") + (f" {moved}" if moved else ""))


def cmd_config(args):
    with open_store(args) as s:
        cfg = s.data.setdefault("config", {})
        tabs = False
        if args.prefix is not None:
            new = args.prefix.strip().upper()
            if not re.fullmatch(r"[A-Z]{2,5}", new):
                raise Fail("A prefix is 2 to 5 letters, like HAT.")
            owner = prefixes_in_use(s.path).get(new)
            if owner:
                raise Fail(f"{new} is taken by {owner}.")
            if new != s.prefix:
                s.data["prefix"] = new
                s.dirty = tabs = True
        out = {"folder": s.loc["folder"], "prefix": s.prefix, "max_running": s.max_running(), "settings": settings_for(s),
               "worktrees": worktrees_on(s)}
    out["rename"] = retag_tabs(s) if tabs else []
    n = out["max_running"]
    where = "a worktree each" if out["worktrees"] else "in the folder itself"
    say(args, out, f"{out['folder']}: tasks {out['prefix']}-n, at most {n} at once, {where}.")


def cmd_rm(args):
    with open_store(args) as s:
        t = s.find(args.id)
        s.data["tasks"].remove(t)
        for o in s.data["tasks"]:
            if t["id"] in (o.get("after") or []):
                o["after"] = [i for i in o["after"] if i != t["id"]]
        s.dirty = True
    note = f" Its worktree {t['worktree']} is still there." if t.get("worktree") and os.path.isdir(t["worktree"]) else ""
    say(args, {"id": t["id"], "removed": True}, f"{s.ref(t)} removed.{note}")


def last_agent(t):
    return t["agents"][-1] if t["agents"] else None


def start_again(s, t, space, key=None, argv_json=None, message=None, parent=None, nudge=None, current=False):
    """Starts an agent for the task: the last agent's own session when it's the same agent and launcher
    and the session is known; else a fresh one with a handoff. `message` goes after either; `nudge`
    is a resumed session's first message when no `message` is given (a handoff needs none)."""
    unarchive(s, t)
    prev = last_agent(t)
    parent = parent_for(parent or (prev or {}).get("parent"), space)
    # Only a switch picks today's settings; recovery keeps the worker's original launch.
    keep = prev and prev.get("argv") and not current
    argv = agent_argv(None, argv_json) if argv_json else worker_argv(s, t, space, key) if key else \
        (prev["argv"] if keep else worker_argv(s, t, space))
    custom = bool(argv_json or (prev.get("custom_argv") if keep and not key else worker_pick(s, t, space, key).get("argv") == argv))
    extra = {"custom": custom}
    same = prev and agent_key(argv) == prev.get("agent")
    if same and agent_key(argv) == "claude":
        same = launcher_of(argv) == (prev.get("launcher") or launcher_of(prev.get("argv")))
    res = resume_argv(argv, prev["session"], folder_for(s, t)) if same and prev.get("session") else None
    if res:
        return launch(s, t, argv, space, message or nudge, parent=parent, resume=res, **extra), True
    text = handoff(s, t, prev, parent, argv) + (("\n\n" + message) if message else "")
    t["review_gate"] = True
    return launch(s, t, argv, space, text, parent=parent, **extra), False


# SHEP-189: what a resumed agent hears first. Its session comes back with no message, so without this
# it sat idle until someone wrote to it.
RESUME_NUDGE = ("Shepherdr resumed your session because your agent had stopped. Carry on where you left off: check "
                "what is already done with `herdr-task show`, then keep going with the task.")


def cmd_resume(args):
    with open_store(args) as s:
        t = s.find(args.id)
        live = [k for k in map(detail, live_agents(s.key(t))) if agent_running(k)] or [a for a in [just_started(t)] if a]
        if live:
            raise Fail(f"{s.ref(t)} still has an agent ({live[0]['address']}). Use switch to replace it.")
        if t["state"] in ("todo", "scheduled", "queued"):
            raise Fail(f"{s.ref(t)} hasn't started. Use start.")
        space = bare(args.space) or bare(t.get("space")) or default_space(s.loc["folder"], parent=args.parent)
        if t["state"] == "done":
            t["state"] = "running"
        gone = [k["address"] for k in live_agents(s.key(t))]  # its agents' terminals, none running an agent
        back_to_work(s, t, "resumed")
        a, resumed = start_again(s, t, space, args.agent, args.argv, parent=args.parent, message=RESUME_NUDGE)
        # #1022: the old agent's terminal, its plain shell left (with the status it last reported when
        # it died mid-turn), kept counting as the task's agent: it goes, as switch ends the one it replaces.
        for address in gone:
            if address != a["address"]:
                stop_note("resume-retire", task=s.ref(t), terminal=address, by="resume")
                run(["hc", "kill", address])
        v = view(s, t)
    say(args, {**v, "terminal": a["address"], "space": space, "parent": a.get("parent"), "resumed": resumed},
        f"{s.ref(t)} {'resumed its session' if resumed else 'started with a handoff'}: {a['address']}")


# SHEP-211: what a session resumed by switch hears first. Without it the new agent sat idle on the old one's
# interrupted turn ("Interrupted · What should Claude do instead?") and the task showed a false "needs you".
SWITCH_NUDGE = ("Shepherdr restarted your session on a new agent (the task's agent, model or settings changed), "
                "which stopped your last turn part-way. Nothing is wrong and nobody is waiting on you: carry on "
                "where you left off (check what is already done with `herdr-task show` and git), then keep going "
                "with the task.")


def end_agent(s, t, address):
    """Ends a task's agent (its terminal, shell and all); hc kill returns once it's gone."""
    stop_note("switch-kill", task=s.ref(t), terminal=address, by="switch")
    run(["hc", "kill", address])


def cmd_switch(args):
    with open_store(args) as s:
        t = s.find(args.id)
        live = [k for k in map(detail, live_agents(s.key(t))) if agent_running(k)]
        refresh_sessions(s, t, live)
        old = live[-1] if live else None
        labels = (old or {}).get("labels") or {}
        # A given --space wins: the task moves there (#837); else the old agent's own space.
        space = (bare(args.space) or bare(labels.get("herdr.task.space")) or bare(labels.get("herdr.space"))
                 or bare(t.get("space")) or default_space(s.loc["folder"], parent=args.parent))
        if t["state"] in ("todo", "scheduled", "queued", "done"):
            t["state"] = "running"
            t.setdefault("started", now())
            t.pop("queue", None)
            t.pop("scheduled_for", None)
        chosen = agent_argv(None, args.argv) if args.argv else worker_argv(s, t, space, args.agent)
        ensure_launcher(chosen)
        ended = []
        # An agent switching itself can't end first: that would end this command too.
        me = os.environ.get("HC_TERMINAL_ID")
        own = bool(old and me and old["address"].split("/")[-1] == me)
        if old and not args.keep and not own:
            # The old agent ends before the new one starts (SHEP-211): the new one may resume the same session,
            # and killing the old one after that cut the session's turn short under the new agent, which then
            # sat on "Interrupted" with nothing to do. Its worktree and session stay for the new agent.
            end_agent(s, t, old["address"])
            ended.append(old["address"])
        try:
            a, resumed = start_again(s, t, space, args.agent, args.argv, parent=args.parent, nudge=SWITCH_NUDGE, current=True)
        except Fail as e:
            if ended:
                raise Fail(f"{e} The old agent {ended[0]} already ended: its work is kept, `herdr-task resume "
                           f"{s.ref(t)}` starts it again.")
            raise
        v = view(s, t)
    if own and not args.keep:
        end_agent(s, t, old["address"])
        ended.append(old["address"])
    say(args, {**v, "terminal": a["address"], "space": space, "parent": a.get("parent"), "resumed": resumed, "ended": ended},
        f"{s.ref(t)}: {a['agent']} {a['address']} {'resumed its session' if resumed else 'took over'}" + (f", {old['address']} ended" if ended else ""))


def workers(s, t):
    """The task's agents at work, reviewers left out (hc get's records, oldest first)."""
    return [k for k in map(detail, live_agents(s.key(t)))
            if agent_running(k) and (k.get("labels") or {}).get("herdr.role") != "reviewer"]


def tell(s, t, msg, args):
    """Sends the task's worker a message, or starts one with it when none is left.
    Returns (terminal, started)."""
    unarchive(s, t)
    live = workers(s, t)
    fresh = None if live else just_started(t)
    if fresh:
        # #1053: its agent is still starting (its brief on the way): never a second one beside it.
        raise Fail(f"{s.ref(t)} started its agent moments ago ({fresh['address']}); send this again once it is up.")
    if live:
        # While the person writes to it, the message waits for them (news.py's held_pass).
        from .news import send_or_hold
        if not send_or_hold(live[-1]["address"], msg):
            raise Fail(f"hc send to {live[-1]['address']} failed")
        return live[-1]["address"], False
    space = (bare(getattr(args, "space", None)) or bare(t.get("space"))
             or default_space(s.loc["folder"], parent=getattr(args, "parent", None)))
    a, _ = start_again(s, t, space, getattr(args, "agent", None), getattr(args, "argv", None), message=msg)
    return a["address"], True


def local_merge_msg(s, t):
    main, wt, br, base = s.loc["folder"], t["worktree"], t["branch"], t.get("base") or "main"
    q = shlex.quote
    return (f"Merge task {s.ref(t)} \"{t['title']}\" now:\n"
            f"1. In {wt}: commit any remaining work, then rebase {br} onto {base} (git rebase {base}) and resolve conflicts.\n"
            f"2. Run the project's checks (tests, build, lint) and fix what fails.\n"
            f"3. Merge into {base}: git -C {q(main)} merge --ff-only {br} when {main} has {base} checked out, else git -C {q(main)} fetch . {br}:{base}. If {main} has uncommitted changes in the way, or another worktree has {base} checked out, stop and tell the person; don't stash or reset their work.\n"
            f"4. Clean up: git -C {q(main)} worktree remove {q(wt)} && git -C {q(main)} branch -d {br}\n"
            f"5. Run: herdr-task done {s.ref(t)} --folder {q(main)}")


MERGE_FAILED = "The merge didn't go through"  # a merge that failed: never in the way of the next try
CHECKS_RUNNING = "Checks are still running."
WAITS_APPROVAL = "It waits for an approving review."  # #743: not a problem, it merges once approved
IN_QUEUE = "It is in GitHub's merge queue."  # #802: merging, done once GitHub merged it


def merge_failed(t, v, err):
    t["attention"], t["attention_at"], t["merge_failed_head"] = f"{MERGE_FAILED}: {err}", now(), v.get("headRefOid")
    return t["attention"]


def merge_now(s, t, publish=False):
    """Merges the task's pull request on GitHub (squash) and tidies up here. A draft is published
    first when the person asked (publish: Accept, Merge), then merges once its checks pass. Returns
    why it couldn't, or None when it's merged (and the task done). A GitHub base branch with GitHub's
    merge queue (#742, #801, #802): the pull request joins the queue and the task stays Merging until
    GitHub merged it (the tick finishes it then, and deletes its branch there). On Azure DevOps its
    own way (ado_flow.accept(): ado_flow.WAITS while Azure DevOps merges it)."""
    n, repo = str(t["pr"]["number"]), t["pr"]["repo"]
    if ado.owns(repo):
        return ado_flow.accept(s, t, publish)
    v = pr_view(t)
    s.dirty = True
    if not v:
        return f"Couldn't reach pull request #{n} on {ado.forge(repo)}."
    note_checks(s, t, v)
    if v.get("state") != "MERGED":
        problem = pr_problem(v)
        if problem:
            t["attention"], t["attention_at"] = problem, now()
            t.pop("merge_queued", None)
            return problem
        if t.get("merge_queued"):
            return IN_QUEUE
        if v.get("isDraft"):
            if not publish:
                return "It's still a draft pull request: Accept publishes and merges it."
            ok, err = publish_pr(t)
            if not ok:
                return merge_failed(t, v, f"couldn't publish the draft: {err}")
            # Its reviewers and policies start on the published one: merged by a later tick. Its checks start
            # now (checks_since()), not at its earlier Ready: the head is unchanged, so say so here.
            t["pr"]["head_at"], t["pr"]["head_sha"] = now(), v.get("headRefOid")
            return CHECKS_RUNNING
        # #1044: no checks yet while some will come is never "none set up": it merges once they ran.
        if pr_pending(v) or checks_missing(v, checks_since(s, t, v), expected_checks(s, t, v.get("headRefOid"))) == "waiting":
            return CHECKS_RUNNING
        if needs_approval(v):
            t["pr"]["needs_approval"] = True
            return WAITS_APPROVAL
        t["pr"].pop("needs_approval", None)
        # #1045: never --delete-branch. gh deletes the branch right after its merge call whenever it
        # doesn't know the base has a merge queue (a ruleset's queue, an older gh): GitHub only queued
        # it, and a pull request whose branch goes is closed and leaves the queue. Its branch on GitHub
        # goes below, once GitHub says it merged (drop_branch()).
        ok, _, err = gh("pr", "merge", n, "--repo", repo, "--squash", "--match-head-commit", v.get("headRefOid") or "")
        # Merged, or only queued (or set to merge by itself)? Asked again; a one-off GitHub error can
        # also come after the merge went through.
        again = pr_view(t)
        if (again or {}).get("state") == "MERGED":
            v = again
        elif ok:
            # Open after gh said yes: GitHub's merge queue has it (merges once the queue's checks pass).
            t["merge_queued"] = now()
            t.pop("attention", None)
            t["pr"]["checked"] = 0
            return IN_QUEUE
        elif not ok:
            merge_failed(t, v, err)
            # The next tick reads the pull request at once (merged by hand meanwhile: done).
            t["pr"]["checked"] = 0
            return t["attention"]
    watch_main(s, t, ((v.get("mergeCommit") or {}).get("oid")) if v.get("state") == "MERGED" else None)
    update_main(s, t)
    # Its branch on GitHub goes now that it merged (the repo may have deleted it already: fine).
    drop_branch(s, t)
    t["merged"] = True
    finish(s, t, even_if_busy=True)
    return None


def own_open_pr(s, t):
    """#988: a task with no pull request on record, in a GitHub repo: the open one for its branch (its
    agent opened it, ready never knew) is recorded on the task, so it merges there, never here behind
    it. Refused (nothing merged) when GitHub can't be asked, or when that pull request isn't at the
    branch's newest commit here (merging it would leave work out). None when there is none. On Azure
    DevOps the same, asked of Azure DevOps (ado.listed())."""
    repo = github(s)
    if repo and ado.owns(repo):
        try:
            found = next(iter(ado.listed(repo, t, "active")), None)
        except ado.AdoError as e:
            raise Fail(f"Couldn't ask Azure DevOps whether {s.ref(t)} has a pull request ({e}); nothing merged. Try again.")
        if not found:
            return None
        if found.get("headRefOid") != branch_tip(s, t):
            raise Fail(f"{s.ref(t)} has pull request #{found['number']} open on Azure DevOps, but not at its branch's newest "
                       f"commit here; nothing merged. Its agent pushes it (herdr-task ready), then try again.")
        t["pr"] = {"number": found["number"], "url": found["url"], "repo": repo}
        s.dirty = True
        return t["pr"]
    if not repo:
        why = github_unreachable(s)
        if why:
            raise Fail(f"Couldn't ask GitHub whether {s.ref(t)} has a pull request ({why}); nothing merged. Try again.")
        return None
    found = pr_for_branch(t, repo)
    if not found:
        return None
    if found.get("headRefOid") != branch_tip(s, t):
        raise Fail(f"{s.ref(t)} has pull request #{found['number']} open on GitHub, but not at its branch's newest commit "
                   f"here; nothing merged. Its agent pushes it (herdr-task ready), then try again.")
    t["pr"] = {"number": found["number"], "url": found["url"], "repo": repo}
    s.dirty = True
    return t["pr"]


def cmd_merge(args):
    error = None
    with open_store(args) as s:
        t = s.find(args.id)
        if t.get("mode") != "worktree" or not t.get("worktree"):
            raise Fail(f"{s.ref(t)} works in the folder itself; there is nothing to merge.")
        sent, started, how = None, False, "agent"
        if ado_flow.pr_on_accept(s, t) and not merged_here(s, t) and not in_base(s, t):
            # SHEP-96: Azure DevOps: its agent opens the pull request, as Accept has it; never merged here. Only once it said
            # ready, as Accept.
            if t["state"] != "ready" or t.get("pr_requested") and not t.get("attention"):
                raise Fail(f"{s.ref(t)} isn't Ready ({t['state']}): on Azure DevOps its pull request is opened once it says ready "
                           "and is accepted.")
            if busy_again(t, mid_turn_agents(live_agents(s.key(t)), detail)):
                raise Fail(f"{s.ref(t)} is working again: its agent took up more work after it said ready. Merge it once it says "
                           "ready again.")
            how = "opening"
            try:
                sent, started = ado_flow.request_pr(s, t, args)
            except Fail as e:
                error = str(e)
        elif t.get("pr") or own_open_pr(s, t):
            # On GitHub or Azure DevOps: Herdr merges the pull request itself, then tidies up here.
            how = "github"
            error = merge_now(s, t, publish=True)
            if error == IN_QUEUE:
                how, error = "queue", None
            elif error == ado_flow.WAITS:
                how, error = "waiting", None
            elif error == CHECKS_RUNNING:
                error += " Merge again when they pass."
            elif error == WAITS_APPROVAL:
                error += " Merge again once it's approved."
        else:
            t["merge_requested"] = now()
            s.dirty = True
            sent, started = tell(s, t, local_merge_msg(s, t), args)
        v = view(s, t)
    if error:
        say(args, {**v, "error": error}, None) if args.json else print(f"herdr-task: {error}", file=sys.stderr)
        sys.exit(1)
    text = f"{s.ref(t)}: pull request #{t['pr']['number']} merged; done." if how == "github" else \
        f"{s.ref(t)}: pull request #{t['pr']['number']} is in GitHub's merge queue; done once GitHub merges it." if how == "queue" else \
        f"{s.ref(t)}: waiting to merge: {v.get('why') or 'Azure DevOps completes it'} (auto-complete is on)." if how == "waiting" else \
        f"{s.ref(t)}: {sent} opens its pull request on Azure DevOps." if how == "opening" else \
        f"{s.ref(t)}: merge asked of {sent}" + (" (a new agent)" if started else "")
    say(args, {**v, "terminal": sent, "new_agent": started, "merged": how == "github", "queued": how == "queue",
               "waiting": how == "waiting"}, text)


def branch_tip(s, t):
    """The task branch's last commit here (else the one it said ready at), or None."""
    ok, tip, _ = git(s.loc["folder"], "rev-parse", "--verify", "--quiet", f"refs/heads/{t.get('branch')}")
    return (tip if ok and tip else None) or t.get("head") or None


def in_base(s, t):
    """Its branch holds nothing its base branch doesn't, here or on its remote: no commits of its
    own, or it only caught up with its base (`git merge --ff-only main` or `git rebase origin/main`
    while the local main is behind: SHEP-23, #737). Nothing to merge, and never merged."""
    tip, main, base = branch_tip(s, t), s.loc["folder"], t.get("base") or "main"
    return bool(tip) and (tip == t.get("start") or any(
        git(main, "merge-base", "--is-ancestor", tip, ref)[0] for ref in (base, f"refs/remotes/{remote_of(main)}/{base}")))


def ff_merge(s, t):
    """Lands a task's branch in its base branch here when that is a fast-forward (the base is
    checked out in the main folder and the branch already holds it: exactly the tested work, no
    new combination). Returns whether it did; git refuses to touch uncommitted files."""
    main, br, base = s.loc["folder"], t.get("branch"), t.get("base") or "main"
    ok, cur, _ = git(main, "symbolic-ref", "--short", "HEAD")
    if not (br and git(main, "merge-base", "--is-ancestor", base, br)[0]):
        return False
    if ok and cur == base:
        return git(main, "merge", "--ff-only", br)[0]
    # A base not checked out here (a task's own --base): its branch moves forward to the task's
    # (git refuses unless it's a fast-forward, or when another worktree has it checked out).
    return git(main, "fetch", ".", f"{br}:{base}")[0]


# A background Accept that couldn't finish (SHEP-64): Needs you with why; the person's next Accept tries again.
ACCEPT_FAILED = "Accept didn't finish"


def cmd_accept(args):
    """The person's Accept on a Ready task (the one thing they do in the Tasks panel): Done at
    once when there is nothing to merge, else merged first, as the merge settings say how: a pull
    request is squash-merged on GitHub (or merges once its checks pass); a local branch is
    fast-forwarded when it can be, else its agent merges it (rebase, checks) and marks it done.
    --background (the cards') answers at once and does all that in a detached herdr-task."""
    if getattr(args, "background", False):
        return accept_in_background(args)
    worker = getattr(args, "worker", False)
    if not worker:
        accept_precheck(args)
    try:
        s, t, how, error, sent, started, v = accept_run(args, worker)
    except Exception as e:
        if not worker:
            raise
        # Nobody reads a worker's output: what went wrong is on the task, where the person is told.
        accept_failed(args, str(e))
        return
    if worker:
        if error:
            accept_failed(args, error, only_if_quiet=True)
        return
    if error:
        say(args, {**v, "error": error}, None) if args.json else print(f"herdr-task: {error}", file=sys.stderr)
        sys.exit(1)
    text = {"done": f"{s.ref(t)} accepted: done.",
            "merged": f"{s.ref(t)} accepted: merged into {t.get('base') or 'main'}; done.",
            "github": f"{s.ref(t)} accepted: pull request #{(t.get('pr') or {}).get('number')} merged; done.",
            "checks": f"{s.ref(t)} accepted: it merges once its checks pass.",
            "approval": f"{s.ref(t)} accepted: it merges once it's approved.",
            "queue": f"{s.ref(t)} accepted: pull request #{(t.get('pr') or {}).get('number')} is in GitHub's merge queue; done once GitHub merges it.",
            "waiting": f"{s.ref(t)} accepted: waiting to merge: {v.get('why') or 'Azure DevOps completes it'} (auto-complete is on).",
            "opening": f"{s.ref(t)} accepted: {sent} opens its pull request on Azure DevOps" + (" (its agent started again)" if started else "") + ".",
            "agent": f"{s.ref(t)} accepted: merge asked of {sent}" + (" (a new agent)" if started else "")}[how]
    say(args, {**v, "accepted": how, "terminal": sent, "new_agent": started}, text)


def accept_in_background(args):
    """SHEP-64: Accept for a card that can't wait (the window's herdr.exec ends a call after 30 s, and Azure DevOps takes
    longer). The checks of a foreground Accept, then the task reads Accepting… and a detached herdr-task does the
    merge (accept_run(), --worker) while this answers at once. A failure there is the task's Needs you (accept_failed()).
    Asked again while it runs, nothing starts twice."""
    accept_precheck(args)
    with open_store(args) as s:
        t = s.find(args.id)
        if t["state"] != "ready":
            raise Fail(f"{s.ref(t)} isn't ready ({t['state']}); only a Ready task can be accepted.")
        again = accepting(t)
        if not again:
            # What an earlier try left (accept_run() clears it too) must not read Needs you while this one runs.
            for k in ("attention", "merge_failed_head"):
                t.pop(k, None)
            t["accepting"] = now()
            s.dirty = True
        folder, ref = s.loc["folder"], str(t["id"])
        v = view(s, t)
    if not again:
        subprocess.Popen([sys.executable, ENTRY, "accept", ref, "--folder", folder, "--worker"], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    say(args, {**v, "accepted": "background"}, f"{s.ref(t)} accepted: finishing in the background.")


def accept_failed(args, why, only_if_quiet=False):
    """A background Accept that didn't finish: the task Needs you, with why (only_if_quiet: unless merge_now() already said
    why, as for a failing check). Its next Accept tries again; the tick leaves this one."""
    with open_store(args) as s:
        t = s.find(args.id)
        t.pop("accepting", None)
        if t["state"] == "ready" and not t.get("merged") and not (only_if_quiet and t.get("attention")):
            t["attention"], t["attention_at"] = f"{ACCEPT_FAILED}: {' '.join(str(why).split())[:300]}", now()
        s.dirty = True


def accept_precheck(args):
    """What stands in the way of an Accept, before it merges anything (Fail says what)."""
    back = False
    with open_store(args) as s:
        t = s.find(args.id)
        if t["state"] != "ready":
            raise Fail(f"{s.ref(t)} isn't ready ({t['state']}); only a Ready task can be accepted.")
        # Its agent at work again since it said ready: never accepted half done. Working again
        # (saved), and refused after the store is.
        if busy_again(t, [detail(k) for k in live_agents(s.key(t))]):
            back = back_to_work(s, t, "its agent is at work again", auto=True)
        # One its agent opened itself, which ready couldn't open again ("already exists"): adopted.
        elif (not t.get("pr") and "already exists" in (t.get("attention") or "")
              and (repo := github(s)) and pr_adopt(t, repo)):
            t.pop("attention", None)
            s.dirty = True
        # A pull request's problems are read fresh (merge_now()): one fixed since, or a merge that
        # failed once, doesn't stand in the way. Without one, only a failed try doesn't.
        elif t.get("attention") and not t.get("pr") and not t["attention"].startswith(("Couldn't ask for the merge", MERGE_FAILED, ACCEPT_FAILED, ado_flow.OPEN_FAILED, ado_flow.BEHIND_HERE)):
            raise Fail(f"{s.ref(t)} needs attention first: {t['attention']}")
    if back:
        raise Fail(f"{s.ref(t)} is working again: its agent took up more work after it said ready. Accept it once it says ready again.")


def accept_run(args, worker=False):
    """The merge itself: (store, task, how, error, sent, started, view). worker: the detached one of an Accept that
    answered at once; what it saves ends the task's Accepting…. A killed one saves nothing: the task stays Accepting…
    until ACCEPTING_MS pass, and a pull request that merged meanwhile is finished by the tick (idempotent)."""
    error, how, sent, started = None, "done", None, False
    with open_store(args) as s:
        t = s.find(args.id)
        if t["state"] != "ready":
            raise Fail(f"{s.ref(t)} isn't ready ({t['state']}); only a Ready task can be accepted.")
        if accepting(t) and not worker:
            raise Fail(f"{s.ref(t)} is already being accepted.")
        t.pop("accepting", None)
        for k in ("attention", "merge_failed_head"):
            t.pop(k, None)
        wt = t.get("worktree") if t.get("mode") == "worktree" else None
        t["accepted_at"] = now()
        s.dirty = True
        if not wt:
            # Worked in the folder itself: nothing to merge.
            finish(s, t)
        elif ado_flow.pr_on_accept(s, t) and not merged_here(s, t) and not in_base(s, t):
            # SHEP-96: Azure DevOps: its agent opens the pull request (ado-push-pr, auto-complete on; the skill finds one
            # already open), never merged here. Before any Azure DevOps call: its agent's sign-in may work where Herdr's doesn't.
            how = "opening"
            try:
                sent, started = ado_flow.request_pr(s, t, args)
            except Fail as e:
                error = str(e)
        elif t.get("pr") or own_open_pr(s, t):
            how = "github"
            error = merge_now(s, t, publish=True)
            if error == IN_QUEUE:
                how, error = "queue", None
            elif error == ado_flow.WAITS:
                # Azure DevOps: auto-complete is on, and it merges there (Waiting to merge).
                how, error = "waiting", None
            elif error in (CHECKS_RUNNING, WAITS_APPROVAL):
                # Accepted: it merges by itself once they pass, or once it's approved (Merging).
                t["auto_merge"], how, error = "checks", "checks" if error == CHECKS_RUNNING else "approval", None
        elif merged_here(s, t) or in_base(s, t):
            # Its own work already in the base branch, or none of its own: nothing to merge.
            t["merged"] = merged_here(s, t)
            if not t["merged"]:
                t["nothing_to_merge"] = True
            finish(s, t, even_if_busy=True)
        elif ff_merge(s, t):
            how = "merged"
            t["merged"] = True
            finish(s, t, even_if_busy=True)
        else:
            how = "agent"
            t["merge_requested"] = now()
            sent, started = tell(s, t, local_merge_msg(s, t), args)
        v = view(s, t)
    return s, t, how, error, sent, started, v


SENT_BACK = "Sent back"


def send_back_refusal(s, t):
    """Why a task can't be sent back now, or None. Only a Ready task the person could accept: not while Accept
    runs, nor once its pull request is merging on its forge (GitHub's merge queue, Azure DevOps's auto-complete),
    which would merge it under its agent; a task already merged is done."""
    if t["state"] != "ready":
        return f"{s.ref(t)} isn't Ready (it's {t['state']}): only a Ready task can be sent back. Tell its agent instead."
    if accepting(t):
        return f"{s.ref(t)} is being accepted right now."
    if t.get("merged"):
        return f"{s.ref(t)} already merged."
    if t.get("merge_queued"):
        return f"{s.ref(t)} is in GitHub's merge queue and may merge any moment: take it out there first."
    if t.get("merge_wait"):
        return f"{s.ref(t)} is set to complete on Azure DevOps: cancel its auto-complete there first."
    if t.get("pr_requested") and not t.get("pr") and not t.get("attention"):
        return f"{s.ref(t)} was accepted and its agent is opening its pull request: tell its agent instead."
    return None


def cmd_send_back(args):
    """The Accept card's Send back (SHEP-87): a Ready task back to Working with the person's note for its agent
    (resumed first when it ended), recorded on the task (sent_back). Its pull request stays open; nothing merges it
    meanwhile (no auto merge until its next ready, whose finalize() sets the merge policy again)."""
    note = (args.note or "").strip()
    if not note:
        raise Fail("Say what should change: --note \"...\".")
    with open_store(args) as s:
        t = s.find(args.id)
        why = send_back_refusal(s, t)
        if why:
            raise Fail(why)
        main = s.loc["folder"]
        proof = (t.get("proof") or {}).get("id")
        on = (args.on or "").strip()
        tag = f'<hc from="person" kind="send-back" task="{s.ref(t)}"' + (f' on="{on.replace(chr(34), "”")}"' if on else "") + ">"
        msg = (f"{tag}\n{note}\n</hc>\n\n"
               f"The person sent {s.ref(t)} back from its Accept card instead of accepting it" + (f" (about {on})" if on else "") + ". "
               f"Fix what they asked, run the checks and commit; then update your proof with "
               f"`herdr-artifact update {proof or '<proof id>'} <dir> --note \"<what this version answers>\"` and run "
               f"`herdr-task ready {t['id']} --folder {shlex.quote(main)}` again.")
        t["handed_at"] = now()
        sent, started = tell(s, t, msg, args)
        back_to_work(s, t, f"sent back: {note}", fit(f"{SENT_BACK}: {note}"))
        for k in ("auto_merge",):
            t.pop(k, None)
        (t.get("pr") or {}).pop("wait", None)
        t.setdefault("sent_back", []).append({"at": now(), "note": note[:4000], **({"on": on[:300]} if on else {}),
                                              "to": sent, **({"new_agent": True} if started else {})})
        s.dirty = True
        v = view(s, t)
    say(args, {**v, "terminal": sent, "new_agent": started},
        f"{s.ref(t)}: sent back to {sent}" + (" (its agent started again)" if started else "") + ".")


def cmd_fix(args):
    with open_store(args) as s:
        t = s.find(args.id)
        if t.get("mode") != "worktree" or not t.get("worktree"):
            raise Fail(f"{s.ref(t)} works in the folder itself; tell its agent what to fix.")
        problem = args.reason or t.get("attention") or "The pull request can't merge yet."
        main, wt, br, base = s.loc["folder"], t["worktree"], t["branch"], t.get("base") or "main"
        agent_pr = bool(t.get("pr") and ado.owns(t["pr"].get("repo")) and t["pr"].get("by_agent"))
        accepted = bool(t.get("pr") and ado.owns(t["pr"].get("repo")) and t.get("merge_wait"))
        if accepted or agent_pr:
            msg = (f"Task {s.ref(t)} \"{t['title']}\" can't merge yet: {problem}\n"
                   f"Fix it in {wt}: for conflicts, merge {base} into {br}; for failing checks, find out why and fix them. Run "
                   f"the checks, commit and push to its pull request (`git push`; never force-push)"
                   + ("; don't run ready: it completes by itself once its checks pass." if accepted else
                      f", then run `herdr-task ready {t['id']} --folder {shlex.quote(main)}` for the person's Accept."))
        else:
            on_ado = bool(t.get("pr") and ado.owns(t["pr"].get("repo")))
            how = f"merge {base} into {br}" if on_ado else f"rebase {br} onto {base}"
            msg = (f"Task {s.ref(t)} \"{t['title']}\" can't merge yet: {problem}\n"
                   f"Fix it in {wt}: for conflicts, {how}; for failing checks, find out why and fix them. "
                   f"Run the checks, commit, then run `herdr-task ready {t['id']} --folder {shlex.quote(main)}` to push the fix.")
        # Handed the problem: someone is on it while its agent starts (on_it()).
        t["fix_requested"] = t["handed_at"] = now()
        s.dirty = True
        sent, started = tell(s, t, msg, args)
        if accepted:
            # SHEP-96: Azure DevOps merges it once its push passes: Waiting to merge, never Working (no ready follows).
            for k in ("attention", "attention_at", "stuck_head"):
                t.pop(k, None)
        else:
            back_to_work(s, t, f"asked to fix: {problem}", f"Fixing: {problem}")
        v = view(s, t)
    say(args, {**v, "terminal": sent, "new_agent": started},
        f"{s.ref(t)}: asked {sent} to fix it" + (" (a new agent)" if started else ""))
