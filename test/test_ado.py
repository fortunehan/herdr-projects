"""herdr-task on Azure DevOps (herdr_task/ado.py): a repo whose origin is on Azure DevOps gets the
pull request flow GitHub's do. Throwaway git repos (origin's fetch URL on dev.azure.com, its push URL
a local bare repo) and a fake transport answering Azure DevOps' REST calls: no network, hc or gh."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import argparse
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mods", "tasks", "bin"))
sys.dont_write_bytecode = True

import herdr_task.ado as ado  # noqa: E402
import herdr_task.agents as agents  # noqa: E402
import herdr_task.base as base  # noqa: E402
import herdr_task.commands as commands  # noqa: E402
import herdr_task.ghnews as ghnews  # noqa: E402
import herdr_task.github as github  # noqa: E402

REPO = "ado:contoso/My Proj/web"
API = "https://dev.azure.com/contoso/My%20Proj/_apis/"
GIT_ENV = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/dev/null"}


class Store:
    def __init__(self, tasks, folder="/f"):
        self.data, self.loc, self.dirty = {"tasks": tasks}, {"folder": folder, "kind": "repo", "name": "f"}, False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def find(self, ref):
        return next(t for t in self.data["tasks"] if t["id"] == int(str(ref).split("-")[-1]))

    def ref(self, t):
        return f"SHEP-{t['id']}"

    def key(self, t):
        return f"f#{t['id']}"


class Fake:
    """Azure DevOps' answers by (method, path below _apis/); every request kept."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, repo, method, url, body, raw):
        path = url.split("/_apis/", 1)[1].split("?")[0]
        self.calls.append((method, path, url, body))
        for (m, pattern), answer in self.routes.items():
            if m == method and re.fullmatch(pattern, path):
                return answer(url, body) if callable(answer) else answer
        raise ado.AdoError("http", f"HTTP 404: {method} {path}")

    def sent(self, method, pattern):
        return [c for c in self.calls if c[0] == method and re.fullmatch(pattern, c[1])]


def pr(n=7, status="active", head="abc", **extra):
    return {"pullRequestId": n, "status": status, "title": "SHEP-1 Login", "sourceRefName": "refs/heads/task/1-login",
            "targetRefName": "refs/heads/main", "mergeStatus": "succeeded", "lastMergeSourceCommit": {"commitId": head},
            "repository": {"name": "web", "project": {"id": "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab", "name": "My Proj"}},
            "reviewers": [], **extra}


def evaluation(status, type_id=ado.BUILD_POLICY, name="Build policy", blocking=True, **ctx):
    return {"status": status, "configuration": {"isEnabled": True, "isBlocking": blocking, "type": {"id": type_id, "displayName": name},
                                                "settings": {}}, "context": ctx}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        for name, value in (("STATE", os.path.join(self.tmp, "state.json")), ("CONFIG", os.path.join(self.tmp, "ado.json")),
                            ("BACKGROUND", False), ("_me", {})):
            p = mock.patch.object(ado, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.dict(os.environ, GIT_ENV)
        p.start()
        self.addCleanup(p.stop)

    def fake(self, routes):
        f = Fake(routes)
        p = mock.patch.object(ado, "_request", f)
        p.start()
        self.addCleanup(p.stop)
        return f


class Remotes(Base):
    def test_the_forms_azure_devops_hands_out(self):
        for url in ("https://dev.azure.com/contoso/My%20Proj/_git/web", "https://contoso@dev.azure.com/contoso/My%20Proj/_git/web/",
                    "git@ssh.dev.azure.com:v3/contoso/My%20Proj/web", "ssh://git@ssh.dev.azure.com/v3/contoso/My%20Proj/web",
                    "https://contoso.visualstudio.com/DefaultCollection/My%20Proj/_git/web",
                    "contoso@vs-ssh.visualstudio.com:v3/contoso/My%20Proj/web"):
            self.assertEqual(ado.parse_remote(url), ("contoso", "My Proj", "web"), url)
        for url in ("https://github.com/o/r.git", "git@github.com:o/r.git", "https://dev.azure.com/contoso/p/_git/a%2Fb", ""):
            self.assertIsNone(ado.parse_remote(url), url)

    def test_github_names_the_repo_on_azure_devops_without_gh(self):
        main = os.path.join(self.tmp, "repo")
        subprocess.run(["git", "init", "-q", "-b", "main", main], check=True)
        subprocess.run(["git", "-C", main, "remote", "add", "origin", "https://dev.azure.com/contoso/My%20Proj/_git/web"], check=True)
        with mock.patch.object(github.shutil, "which", lambda name: None):
            self.assertEqual(github.github(Store([], main)), REPO)
        self.assertEqual(ado.pr_url(REPO, 7), "https://dev.azure.com/contoso/My%20Proj/_git/web/pullrequest/7")


class Viewing(Base):
    def routes(self, d, evaluations=(), statuses=()):
        return {("GET", r"git/repositories/web/pullrequests/7"): d,
                ("GET", r"policy/evaluations"): {"value": list(evaluations)},
                ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": list(statuses)}}

    def test_an_open_one_reads_as_gh_with_its_blocking_policies_statuses_and_votes(self):
        f = self.fake(self.routes(pr(reviewers=[{"displayName": "Ann", "vote": -5}, {"displayName": "Bo", "vote": 10}]), [
            evaluation("rejected", buildDefinitionName="web-ci", buildId=88),
            evaluation("queued", type_id="fd2167ab-b0be-447a-8ec8-39368250530e", name="Required reviewers"),
            evaluation("rejected", name="optional build", blocking=False),
            evaluation("notApplicable", name="Work item linking"),
        ], [
            {"id": 1, "state": "failed", "context": {"genre": "sonar", "name": "gate"}},
            {"id": 2, "state": "succeeded", "context": {"genre": "sonar", "name": "gate"}},
            {"id": 3, "state": "error", "context": {"name": "lint"}, "targetUrl": "https://ci/lint"},
        ]))
        v = github.pr_view({"pr": {"number": 7, "repo": REPO}})
        self.assertEqual((v["state"], v["mergeable"], v["headRefOid"], v["mergeCommit"]), ("OPEN", "MERGEABLE", "abc", None))
        checks = {c["name"]: (c["status"], c["conclusion"], c.get("detailsUrl")) for c in v["statusCheckRollup"]}
        self.assertEqual(checks, {
            "web-ci": ("COMPLETED", "FAILURE", "https://dev.azure.com/contoso/My%20Proj/_build/results?buildId=88"),
            "sonar/gate": ("COMPLETED", "SUCCESS", None),
            "lint": ("COMPLETED", "FAILURE", "https://ci/lint"),
            "Review by Ann: waiting for the author": ("COMPLETED", "FAILURE", ado.pr_url(REPO, 7)),
        })
        self.assertIn("artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2F0f1e2d3c-aaaa-bbbb-cccc-1234567890ab%2F7",
                      f.sent("GET", r"policy/evaluations")[0][2])
        self.assertEqual(github.pr_problem(v), "Checks failing: web-ci, lint, Review by Ann: waiting for the author.")
        # a reviewer policy still to be met: an approval waited for, as GitHub's required review (SHEP-175, #743)
        self.assertEqual(v["reviewDecision"], "REVIEW_REQUIRED")
        self.assertTrue(github.needs_approval(v))
        self.assertFalse(github.pr_pending(v))
        # the Pull request view still lists it among the checks
        full = ado.view(REPO, 7, full=True)
        self.assertIn(("Required reviewers", "QUEUED"), [(c["name"], c["status"]) for c in full["statusCheckRollup"]])
        self.assertNotIn("reviewDecision", full)
        self.assertEqual(ghnews.run_id(checks["web-ci"][2]), "88")

    def test_a_completed_one_is_merged_with_its_merge_commit_and_no_checks_read(self):
        f = self.fake(self.routes(pr(status="completed", lastMergeCommit={"commitId": "f00"}, mergeStatus="succeeded")))
        v = github.pr_view({"pr": {"number": 7, "repo": REPO}})
        self.assertEqual((v["state"], v["mergeCommit"], v["statusCheckRollup"]), ("MERGED", {"oid": "f00"}, []))
        self.assertEqual(len(f.calls), 1)

    def test_conflicts_and_abandoned(self):
        self.fake(self.routes(pr(mergeStatus="conflicts")))
        self.assertEqual(github.pr_problem(github.pr_view({"pr": {"number": 7, "repo": REPO}})), "It conflicts with the base branch.")
        self.fake(self.routes(pr(status="abandoned")))
        self.assertEqual(github.pr_problem(github.pr_view({"pr": {"number": 7, "repo": REPO}})), "The pull request was closed.")

    def test_refused_credentials_need_the_person_and_clear_once_it_answers(self):
        t = {"pr": {"number": 7, "repo": REPO}}
        with mock.patch.object(ado, "_request", lambda *a: (_ for _ in ()).throw(ado.AdoError("auth", "the credentials were refused (HTTP 401)"))):
            self.assertIsNone(github.pr_view(t))
        self.assertTrue(t["attention"].startswith("Azure DevOps: the credentials were refused"))
        self.fake(self.routes(pr()))
        self.assertIsNotNone(github.pr_view(t))
        self.assertNotIn("attention", t)

    def test_the_views_get_gh_pr_view_json(self):
        self.fake({**self.routes(pr()),
                   ("GET", r"git/repositories/web/pullRequests/7/iterations"): {"value": [{"id": 1}, {"id": 2}]},
                   ("GET", r"git/repositories/web/pullRequests/7/iterations/2/changes"): {
                       "changeEntries": [{"item": {"path": "/a"}}, {"item": {"path": "/b"}}, {"item": {"path": "/d", "isFolder": True}}]}})
        fields = "number,title,state,isDraft,url,headRefName,baseRefName,additions,deletions,changedFiles,statusCheckRollup"
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ado.cmd_pr_view(argparse.Namespace(number="7", repo=REPO, fields=fields))
        v = json.loads(out.getvalue())
        self.assertEqual(list(v), fields.split(","))
        self.assertEqual((v["headRefName"], v["baseRefName"], v["changedFiles"], v["url"]),
                         ("task/1-login", "main", 2, "https://dev.azure.com/contoso/My%20Proj/_git/web/pullrequest/7"))


class Opening(Base):
    """ready: the branch is pushed (git's remote: here a local bare repo) and its pull request opened."""

    def setUp(self):
        super().setUp()
        self.main, self.wt, self.bare = (os.path.join(self.tmp, x) for x in ("repo", "wt", "bare.git"))
        git = lambda *a: subprocess.run(["git", *a], check=True, capture_output=True, text=True).stdout.strip()
        git("init", "-q", "--bare", self.bare)
        git("init", "-q", "-b", "main", self.main)
        for k, v in (("user.name", "T"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            git("-C", self.main, "config", k, v)
        git("-C", self.main, "remote", "add", "origin", "https://dev.azure.com/contoso/My%20Proj/_git/web")
        git("-C", self.main, "remote", "set-url", "--push", "origin", self.bare)
        git("-C", self.main, "commit", "-q", "--allow-empty", "-m", "base")
        self.branch = "feature/ADO-16951176-1-login"
        git("-C", self.main, "worktree", "add", "-q", "-b", self.branch, self.wt)
        git("-C", self.wt, "commit", "-q", "--allow-empty", "-m", "login")
        self.tip = git("-C", self.wt, "rev-parse", "HEAD")
        self.task = {"id": 1, "title": "Login", "prompt": "Add login.", "worktree": self.wt, "branch": self.branch, "base": "main"}
        self.store = Store([self.task], self.main)
        self.pushed = lambda: git("-C", self.bare, "rev-parse", f"refs/heads/{self.branch}")

    def test_it_pushes_and_opens_one_linked_to_its_work_item(self):
        f = self.fake({("GET", r"git/repositories/web/pullrequests"): {"value": []},
                       ("POST", r"git/repositories/web/pullrequests"): {"pullRequestId": 41}})
        got = github.pr_open(self.store, self.task, github.github(self.store), "Login works.")
        self.assertEqual(self.pushed(), self.tip)
        self.assertEqual(got, {"number": 41, "url": ado.pr_url(REPO, 41), "repo": REPO})
        body = f.sent("POST", r"git/repositories/web/pullrequests")[0][3]
        self.assertEqual((body["sourceRefName"], body["targetRefName"], body["title"], body["workItemRefs"]),
                         (f"refs/heads/{self.branch}", "refs/heads/main", "SHEP-1 Login", [{"id": "16951176"}]))
        self.assertIn("## Summary\n\nLogin works.", body["description"])
        lists = [c[2] for c in f.sent("GET", r"git/repositories/web/pullrequests")]
        self.assertTrue(all("searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2FADO-16951176-1-login" in u for u in lists))

    def test_the_tasks_own_wid_wins_and_a_long_description_is_cut(self):
        self.task.update(wid="123", prompt="x" * 5000)
        f = self.fake({("GET", r"git/repositories/web/pullrequests"): {"value": []},
                       ("POST", r"git/repositories/web/pullrequests"): {"pullRequestId": 41}})
        github.pr_open(self.store, self.task, REPO)
        body = f.sent("POST", r"git/repositories/web/pullrequests")[0][3]
        self.assertEqual((body["workItemRefs"], len(body["description"])), ([{"id": "123"}], ado.DESCRIPTION_MAX))

    def test_it_adopts_the_open_one_at_its_tip_and_comments_its_summary_closed(self):
        open_ = pr(n=39, head=self.tip, sourceRefName=f"refs/heads/{self.branch}")
        f = self.fake({("GET", r"git/repositories/web/pullrequests"): lambda url, b: {"value": [open_] if "status=active" in url else []},
                       ("POST", r"git/repositories/web/pullRequests/39/threads"): {}})
        self.assertEqual(github.pr_open(self.store, self.task, REPO, "Login works.")["number"], 39)
        self.assertEqual(f.sent("POST", r"git/repositories/web/pullrequests"), [])
        thread = f.sent("POST", r"git/repositories/web/pullRequests/39/threads")[0][3]
        self.assertEqual((thread["status"], thread["comments"][0]["content"]), ("closed", "Login works."))

    def test_never_a_forks_or_one_at_another_tip(self):
        for other in ({"forkSource": {"repository": {}}}, {"lastMergeSourceCommit": {"commitId": "f00"}},
                      {"repository": {"name": "api", "project": {"name": "My Proj"}}}):
            self.task.pop("pr", None)
            self.fake({("GET", r"git/repositories/web/pullrequests"): {"value": [{**pr(n=39, head=self.tip), **other}]}})
            self.assertIsNone(github.pr_adopt(self.task, REPO), other)

    def test_never_a_second_one_after_a_merged_one(self):
        merged = pr(n=30, status="completed", head="old")
        self.fake({("GET", r"git/repositories/web/pullrequests"): lambda url, b: {"value": [merged] if "status=completed" in url else []}})
        with self.assertRaises(commands.Fail) as e:
            github.pr_open(self.store, self.task, REPO)
        self.assertIn("!30", str(e.exception))


class Merging(Base):
    """Accept / Merge / a merge policy: completed on Azure DevOps at the head its checks passed on."""

    def setUp(self):
        super().setUp()
        self.task = {"id": 1, "title": "Login", "state": "ready", "mode": "worktree", "worktree": "/w", "branch": "task/1-login",
                     "base": "main", "pr": {"number": 7, "url": ado.pr_url(REPO, 7), "repo": REPO}}
        self.store = Store([self.task])
        done = lambda s, t, even_if_busy=False: t.update(state="done")
        for name, value in (("finish", done), ("watch_main", lambda *a: None), ("update_main", lambda *a: None)):
            p = mock.patch.object(commands, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(ado.time, "sleep", lambda s: None)
        p.start()
        self.addCleanup(p.stop)

    def test_it_completes_the_tested_head_and_the_task_is_done(self):
        seen = []

        def view(url, body):
            seen.append(1)
            return pr(status="completed" if len(seen) > 1 else "active", lastMergeCommit={"commitId": "f00"})
        f = self.fake({("GET", r"git/repositories/web/pullrequests/7"): view, ("PATCH", r"git/repositories/web/pullrequests/7"): {},
                       ("GET", r"policy/evaluations"): {"value": [evaluation("approved", buildDefinitionName="web-ci")]},
                       ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        self.assertIsNone(commands.merge_now(self.store, self.task))
        self.assertEqual((self.task["state"], self.task["merged"]), ("done", True))
        body = f.sent("PATCH", r"git/repositories/web/pullrequests/7")[0][3]
        self.assertEqual((body["status"], body["lastMergeSourceCommit"], body["completionOptions"]["mergeStrategy"],
                          body["completionOptions"]["deleteSourceBranch"]), ("completed", {"commitId": "abc"}, "squash", True))

    def test_the_repos_own_merge_strategy(self):
        with open(ado.CONFIG, "w") as fh:
            json.dump({"merge": "rebase", "repos": {"contoso/My Proj/web": {"merge": "noFastForward"}}}, fh)
        f = self.fake({("GET", r"git/repositories/web/pullrequests/7"): pr(status="completed"), ("PATCH", r"git/repositories/web/pullrequests/7"): {}})
        self.assertEqual(ado.merge(self.task, {"headRefOid": "abc"})[0], True)
        self.assertEqual(f.sent("PATCH", r".*")[0][3]["completionOptions"]["mergeStrategy"], "noFastForward")

    def test_a_reviewer_still_to_approve_keeps_it_merging(self):
        f = self.fake({("GET", r"git/repositories/web/pullrequests/7"): pr(),
                       ("GET", r"policy/evaluations"): {"value": [evaluation("queued", type_id="x", name="Minimum number of reviewers")]},
                       ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        with mock.patch.object(commands, "open_store", lambda args, write=True: self.store), \
                mock.patch.object(commands, "busy_again", lambda *a: False), mock.patch.object(commands, "live_agents", lambda k: []), \
                mock.patch.object(commands, "view", lambda s, t, live=None: dict(t)), mock.patch.object(commands, "say", lambda *a: None):
            commands.cmd_accept(argparse.Namespace(id="SHEP-1", json=True, folder=None))
        self.assertEqual((self.task["state"], self.task["auto_merge"]), ("ready", "checks"))
        self.assertEqual(f.sent("PATCH", r".*"), [])

    def test_a_refused_completion_is_said(self):
        self.fake({("GET", r"git/repositories/web/pullrequests/7"): pr(mergeStatus="conflicts", mergeFailureMessage="conflict in a.txt"),
                   ("PATCH", r"git/repositories/web/pullrequests/7"): {}})
        self.assertEqual(ado.merge(self.task, {"headRefOid": "abc"}), (False, "", "Azure DevOps couldn't complete it: conflict in a.txt"))

    def accept(self):
        said = []
        with mock.patch.object(commands, "open_store", lambda args, write=True: self.store), \
                mock.patch.object(commands, "busy_again", lambda *a: False), mock.patch.object(commands, "live_agents", lambda k: []), \
                mock.patch.object(commands, "view", lambda s, t, live=None: dict(t)), \
                mock.patch.object(commands, "say", lambda args, data, text: said.append((data, text))):
            commands.cmd_accept(argparse.Namespace(id="SHEP-1", json=True, folder=None))
        return said[-1]

    ME = "6f1e2d3c-1111-2222-3333-1234567890ab"

    def waiting_on_a_reviewer(self, patch):
        """Azure DevOps with a reviewer policy still queued; patch answers the PATCH."""
        return self.fake({("GET", r"connectionData"): {"authenticatedUser": {"id": self.ME, "providerDisplayName": "Herdr Bot"}},
                          ("GET", r"git/repositories/web/pullrequests/7"): pr(),
                          ("PATCH", r"git/repositories/web/pullrequests/7"): patch,
                          ("GET", r"policy/evaluations"): {"value": [evaluation("queued", type_id="x", name="Minimum number of reviewers")]},
                          ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})

    def test_accept_waiting_on_a_reviewer_turns_on_auto_complete_as_herdrs_account(self):
        with open(ado.CONFIG, "w") as fh:
            json.dump({"repos": {"contoso/My Proj/web": {"merge": "noFastForward", "transition_work_items": True}}}, fh)
        f = self.waiting_on_a_reviewer(lambda url, body: pr(autoCompleteSetBy={"id": self.ME, "displayName": "Herdr Bot"}))
        data, text = self.accept()
        self.assertEqual([c[3] for c in f.sent("PATCH", r".*")], [{
            "autoCompleteSetBy": {"id": self.ME},
            "completionOptions": {"mergeStrategy": "noFastForward", "deleteSourceBranch": True, "transitionWorkItems": True,
                                  "mergeCommitMessage": "Merged PR 7: SHEP-1 Login"}}])
        # Herdr's own merge stays as a backup, and the follow-up here.
        self.assertEqual((self.task["state"], self.task["auto_merge"], bool(self.task.get("ado_auto_complete"))), ("ready", "checks", True))
        self.assertEqual((data["accepted"], data["auto_complete"]), ("approval", True))
        self.assertIn("Azure DevOps completes it once it's approved", text)
        # SHEP-26: its checks done, only its reviewers left: the person's again, saying so.
        self.assertEqual(agents.task_status(self.task, []), ("ready", None, "Waiting on reviewers in Azure DevOps"))
        # Accept again: auto-complete stays on, the task stays as it is.
        data, _ = self.accept()
        self.assertEqual(len(f.sent("PATCH", r".*")), 2)
        self.assertEqual((self.task["state"], self.task["auto_merge"], data["auto_complete"]), ("ready", "checks", True))

    def test_accept_that_merges_at_once_sets_no_auto_complete(self):
        seen = []

        def view(url, body):
            seen.append(1)
            return pr(status="completed" if len(seen) > 1 else "active", lastMergeCommit={"commitId": "f00"})
        f = self.fake({("GET", r"connectionData"): {"authenticatedUser": {"id": self.ME}},
                       ("GET", r"git/repositories/web/pullrequests/7"): view, ("PATCH", r"git/repositories/web/pullrequests/7"): {},
                       ("GET", r"policy/evaluations"): {"value": [evaluation("approved", buildDefinitionName="web-ci")]},
                       ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        data, _ = self.accept()
        self.assertEqual((self.task["state"], data["accepted"]), ("done", "github"))
        bodies = [c[3] for c in f.sent("PATCH", r".*")]
        self.assertEqual([b["status"] for b in bodies], ["completed"])
        self.assertFalse(any("autoCompleteSetBy" in b for b in bodies) or f.sent("GET", r"connectionData") or "auto_complete" in data)

    def test_a_refused_auto_complete_keeps_herdrs_own_merge_and_says_so(self):
        def refuse(url, body):
            raise ado.AdoError("http", "HTTP 403: You need the Contribute to pull requests permission")
        f = self.waiting_on_a_reviewer(refuse)
        data, text = self.accept()
        self.assertEqual(len(f.sent("PATCH", r".*")), 1)
        self.assertEqual((self.task["state"], self.task["auto_merge"], self.task.get("ado_auto_complete"), self.task.get("attention")),
                         ("ready", "checks", None, None))
        self.assertEqual((data["accepted"], data["auto_complete"]), ("approval", False))
        self.assertIn("Contribute to pull requests", data["auto_complete_error"])
        self.assertIn("it merges once it's approved. Azure DevOps auto-complete couldn't be set", text)
        self.assertEqual(agents.task_status(self.task, [])[2], "Merges once it's approved")

    def test_a_failed_completion_says_azure_devops_not_github(self):
        self.fake({("GET", r"git/repositories/web/pullrequests/7"): pr(mergeStatus="rejectedByPolicy", mergeFailureMessage="policies not met"),
                   ("PATCH", r"git/repositories/web/pullrequests/7"): {},
                   ("GET", r"policy/evaluations"): {"value": []}, ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        self.assertEqual(commands.merge_now(self.store, self.task),
                         "The merge didn't go through: Azure DevOps couldn't complete it: policies not met")
        self.assertEqual(self.task["merge_failed_head"], "abc")

    def test_accept_publishes_a_draft_and_it_merges_once_its_checks_pass(self):
        views = [pr(isDraft=True)]
        f = self.fake({("GET", r"git/repositories/web/pullrequests/7"): lambda url, b: views[0],
                       ("PATCH", r"git/repositories/web/pullrequests/7"): lambda url, body: views.__setitem__(0, pr(isDraft=body.get("isDraft", True))) or {},
                       ("GET", r"policy/evaluations"): {"value": []}, ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        self.accept()
        self.assertEqual([c[3] for c in f.sent("PATCH", r".*")], [{"isDraft": False}])  # published, not completed
        self.assertEqual((self.task["state"], self.task["auto_merge"]), ("ready", "checks"))
        self.assertFalse(views[0]["isDraft"])

    def test_a_merge_policy_never_publishes_a_draft(self):
        f = self.fake({("GET", r"git/repositories/web/pullrequests/7"): pr(isDraft=True),
                       ("GET", r"policy/evaluations"): {"value": []}, ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        self.assertIn("draft", commands.merge_now(self.store, self.task))
        self.assertEqual(f.sent("PATCH", r".*"), [])


class MergedInAzureDevOps(Base):
    """SHEP-4: a pull request someone completes in Azure DevOps makes the task done and brings main
    here up to date, as Herdr's own merge does. A throwaway repo whose origin is a local bare one."""

    def setUp(self):
        super().setUp()
        import herdr_task.tick as tick
        self.tick = tick
        git = self.git = lambda *a: subprocess.run(["git", *a], check=True, capture_output=True, text=True).stdout.strip()
        self.main, bare, other = (os.path.join(self.tmp, x) for x in ("repo", "bare.git", "other"))
        git("init", "-q", "--bare", "-b", "main", bare)
        git("init", "-q", "-b", "main", self.main)
        git("clone", "-q", bare, other)
        for repo in (self.main, other):
            for k, v in (("user.name", "T"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
                git("-C", repo, "config", k, v)
        git("-C", self.main, "remote", "add", "origin", bare)
        git("-C", self.main, "commit", "-q", "--allow-empty", "-m", "base")
        git("-C", self.main, "push", "-q", "origin", "main")
        git("-C", other, "pull", "-q", "origin", "main")
        git("-C", other, "commit", "-q", "--allow-empty", "-m", "Merged PR 7: SHEP-1 Login")
        git("-C", other, "push", "-q", "origin", "main")
        self.merged = git("-C", other, "rev-parse", "HEAD")
        self.task = {"id": 1, "title": "Login", "state": "ready", "mode": "worktree", "worktree": "/w", "branch": "task/1-login",
                     "base": "main", "pr": {"number": 7, "url": ado.pr_url(REPO, 7), "repo": REPO, "checked": 0}}
        self.store = Store([self.task], self.main)
        done = lambda s, t, even_if_busy=False: t.update(state="done")
        for name, value in (("finish", done), ("live_agents", lambda k: []), ("watch_main", lambda *a: None)):
            p = mock.patch.object(tick, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_completed_by_someone_else_main_catches_up(self):
        self.fake({("GET", r"git/repositories/web/pullrequests/7"): pr(status="completed", lastMergeCommit={"commitId": self.merged})})
        report = {"attention": [], "done": []}
        self.tick.facts(self.store, self.task, report)
        self.assertEqual((self.task["state"], self.task["merged"], report["done"]), ("done", True, [1]))
        self.assertEqual(self.git("-C", self.main, "rev-parse", "main"), self.merged)

    def ready_wait(self, d, evaluations):
        self.fake({("GET", r"git/repositories/web/pullrequests/7"): d, ("GET", r"policy/evaluations"): {"value": evaluations},
                   ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []},
                   ("GET", r"pullRequests/7/threads"): {"value": []}})
        self.task.update(ready_at=0)
        self.task["pr"].update(checked=0, wait="Checks running")
        with mock.patch.object(self.tick, "pr_news", lambda *a: None):
            self.tick.facts(self.store, self.task, {"attention": [], "done": []})
        return self.task["pr"].get("wait"), agents.task_status(self.task, [])[0]

    def test_waiting_for_a_reviewer_is_ready_for_the_persons_accept(self):
        # SHEP-175 on Azure DevOps: builds done, a reviewer policy still to be met: Ready (Accept turns on auto-complete),
        # never Working on "Checks running" until someone approves.
        wait, status = self.ready_wait(pr(), [evaluation("approved", buildDefinitionName="web-ci"),
                                              evaluation("queued", type_id="fa4e907d-c16b-4a4c-9dfa-4906e5d171dd", name="Minimum number of reviewers")])
        self.assertEqual((wait, status), (None, "ready"))
        self.assertTrue(self.task["pr"]["needs_approval"])
        self.assertEqual(agents.task_status(self.task, [])[2], "Waiting on reviewers in Azure DevOps")  # SHEP-26
        # a build still running: Working
        wait, status = self.ready_wait(pr(), [evaluation("running", buildDefinitionName="web-ci")])
        self.assertEqual((wait, status), ("Checks running", "working"))

    def test_accepted_with_auto_complete_and_only_reviewers_left_is_ready(self):
        # SHEP-26: Accept turned on auto-complete; its build passed, only the reviewer policies are left: Ready.
        self.task.update(auto_merge="checks", ado_auto_complete=1)
        reviewers = [evaluation("queued", type_id="fa4e907d-c16b-4a4c-9dfa-4906e5d171dd", name="Minimum number of reviewers"),
                     evaluation("queued", type_id="fd2167ab-b0be-447a-8ec8-39368250530e", name="Required reviewers")]
        wait, status = self.ready_wait(pr(autoCompleteSetBy={"id": "x"}), [evaluation("approved", buildDefinitionName="web-ci"), *reviewers])
        self.assertEqual((wait, status), (None, "ready"))
        self.assertEqual(agents.task_status(self.task, [])[2], "Waiting on reviewers in Azure DevOps")
        self.assertFalse(self.task["_pr_fresh"])  # Herdr's own merge doesn't go first
        # its build still running: Working, saying so
        wait, status = self.ready_wait(pr(), [evaluation("running", buildDefinitionName="web-ci"), *reviewers])
        self.assertEqual((wait, agents.task_status(self.task, [])), ("Checks running", ("working", None, "Checks running")))
        # its build failed: Needs you, as before
        self.ready_wait(pr(), [evaluation("rejected", buildDefinitionName="web-ci"), *reviewers])
        self.task["attention_at"] = 0
        self.assertEqual(agents.task_status(self.task, [])[:2], ("needs", "attention"))
        self.assertIn("web-ci", self.task["attention"])
        # approved, completing by itself any moment: Working
        self.task.pop("attention")
        wait, status = self.ready_wait(pr(), [evaluation("approved", buildDefinitionName="web-ci")])
        self.assertEqual((wait, agents.task_status(self.task, [])), (None, ("working", None, "Completes in Azure DevOps")))

    def test_a_reviewer_rejecting_after_ready_reaches_the_task(self):
        # SHEP-26: Ready on its reviewers, then one rejects: a problem Herdr found, as other pull request news.
        self.task.update(auto_merge="checks", ado_auto_complete=1)
        reviewers = [evaluation("queued", type_id="fd2167ab-b0be-447a-8ec8-39368250530e", name="Required reviewers")]
        self.ready_wait(pr(), [evaluation("approved", buildDefinitionName="web-ci"), *reviewers])
        self.assertEqual(agents.task_status(self.task, [])[0], "ready")
        wait, _ = self.ready_wait(pr(reviewers=[{"displayName": "Ann", "vote": -10}]),
                                  [evaluation("approved", buildDefinitionName="web-ci"), *reviewers])
        self.assertEqual(wait, "Back to its agent to fix")
        self.assertIn("Review by Ann: rejected", self.task["attention"])

    def test_a_github_pull_request_waiting_on_a_review_is_unchanged(self):
        t = {"state": "ready", "auto_merge": "checks", "pr": {"number": 3, "repo": "o/r", "needs_approval": True}}
        self.assertEqual(agents.task_status(t, []), ("working", None, "Merges once it's approved"))
        self.assertEqual(agents.task_status({"state": "ready", "pr": {"number": 3, "repo": "o/r", "needs_approval": True}}, []),
                         ("ready", None, None))

    def test_a_draft_waiting_on_a_validation_is_ready_for_the_accept_that_publishes_it(self):
        # Azure DevOps runs no build validation on a draft: its queued build must not keep it Working before Accept.
        wait, status = self.ready_wait(pr(isDraft=True), [evaluation("queued", buildDefinitionName="web-ci")])
        self.assertEqual((wait, status), (None, "ready"))
        self.assertFalse(self.task["_pr_fresh"])  # still never merged by itself

    def test_a_merge_azure_devops_still_works_out_says_azure_devops(self):
        wait, _ = self.ready_wait(pr(mergeStatus="queued"), [])
        self.assertEqual(wait, "Waiting for Azure DevOps")


class News(Base):
    def test_comments_and_votes_as_gh_reviews_without_azure_devops_own(self):
        self.fake({("GET", r"git/repositories/web/pullRequests/7/threads"): {"value": [
            {"id": 1, "comments": [{"id": 1, "commentType": "system", "content": "Ann pushed", "publishedDate": "2026-11-07T10:00:00Z"}]},
            {"id": 2, "properties": {"CodeReviewThreadType": {"$value": "VoteUpdate"}, "CodeReviewVoteResult": {"$value": "-5"}},
             "comments": [{"id": 1, "commentType": "system", "author": {"displayName": "Ann"}, "publishedDate": "2026-11-07T10:01:00.1234567Z"}]},
            {"id": 3, "properties": {"CodeReviewThreadType": {"$value": "VoteUpdate"}, "CodeReviewVoteResult": {"$value": "10"}},
             "comments": [{"id": 1, "commentType": "system", "publishedDate": "2026-11-07T10:02:00Z"}]},
            {"id": 4, "threadContext": {"filePath": "/src/a.ts", "rightFileStart": {"line": 12}}, "comments": [
                {"id": 1, "commentType": "text", "author": {"displayName": "Bo"}, "content": "Use the helper.", "publishedDate": "2026-11-07T10:03:00Z"},
                {"id": 2, "commentType": "text", "author": {"displayName": "Bo"}, "content": "gone", "isDeleted": True, "publishedDate": "2026-11-07T10:04:00Z"}]},
            {"id": 5, "isDeleted": True, "comments": [{"id": 1, "commentType": "text", "content": "x", "publishedDate": "2026-11-07T10:05:00Z"}]},
        ]}})
        got = ado.pr_comments(REPO, 7)
        self.assertEqual([(c["id"], c["who"], c["body"], c.get("state"), c.get("where")) for c in got],
                         [("r2", "Ann", "", "CHANGES_REQUESTED", None), ("c4.1", "Bo", "Use the helper.", None, "src/a.ts:12")])
        self.assertEqual(got[0]["at"], 1794045660000)
        self.assertEqual(ghnews.pr_comments(REPO, 7), got)

    def test_the_end_of_a_failed_builds_log(self):
        self.fake({("GET", r"build/builds/88/timeline"): {"records": [
            {"type": "Job", "result": "failed", "log": {"id": 2}}, {"type": "Task", "result": "failed", "log": {"id": 12}, "startTime": "2026-11-07T10:05:00Z"},
            {"type": "Task", "result": "failed", "log": {"id": 9}, "startTime": "2026-11-07T10:04:00Z"},
            {"type": "Task", "result": "succeeded", "log": {"id": 3}}]},
            ("GET", r"build/builds/88/logs/9"): "\x1b[31mnpm ERR! test failed\x1b[0m\n"})
        self.assertEqual(ghnews.log_tail(REPO, "88"), "npm ERR! test failed\n")
        self.fake({("GET", r"build/builds/89/timeline"): {"records": [
            {"type": "Job", "result": "failed", "issues": [{"message": "The job was rejected by an approver."}]}]}})
        self.assertEqual(ghnews.log_tail(REPO, "89"), "The job was rejected by an approver.")

    def test_main_going_red_is_news_for_the_assistant(self):
        history = [{"commitId": c, "comment": f"commit {c}\nbody"} for c in ("c3", "c2", "c1")]
        self.fake({("GET", r"git/repositories/web/commits"): {"value": history},
                   ("GET", r"git/repositories/web/"): {"id": "89119017-37e6-49c5-a132-b20dc89e0248"},
                   ("GET", r"build/builds"): {"value": [
                       {"id": 90, "sourceVersion": "c3", "status": "completed", "result": "failed", "definition": {"name": "web-ci"},
                        "repository": {"name": "web"}, "_links": {"web": {"href": "https://ci/90"}}},
                       {"id": 91, "sourceVersion": "c3", "status": "completed", "result": "succeeded", "definition": {"name": "api-ci"},
                        "repository": {"name": "api"}},
                       {"id": 80, "sourceVersion": "c1", "status": "completed", "result": "succeeded", "definition": {"name": "web-ci"},
                        "repository": {"name": "web"}}]},
                   ("GET", r"build/builds/90/timeline"): {"records": []}})
        w, report = {"repo": REPO, "space": "sp1", "merged": [{"ref": "SHEP-1", "title": "Login", "pr": 7, "sha": "c3"}]}, {}
        ghnews.main_check(Store([]), "main", w, report)
        text = w["notice"]["text"]
        self.assertIn("main went red after merges: web-ci (https://ci/90) at commit c3.", text)
        self.assertIn("Merged since main was last green (c1): commit c2; commit c3.", text)
        self.assertNotIn("api-ci", text)
        self.assertIn("repositoryId=89119017-37e6-49c5-a132-b20dc89e0248", self.calls_to(r"build/builds")[0])

    def calls_to(self, pattern):
        return [c[2] for c in ado._request.calls if c[0] == "GET" and re.fullmatch(pattern, c[1])]


class Transport(Base):
    """Credentials, the proxy, and what each failure says; a failing Azure DevOps backs the scheduler off."""

    def answer(self, status=200, body=b"{}", error=None):
        class Opener:
            def open(self, req, timeout=None):
                Opener.req = req
                if error:
                    raise error
                if status >= 400:
                    raise urllib.error.HTTPError(req.full_url, status, "x", {}, io.BytesIO(body))
                return contextlib.nullcontext(type("R", (), {"status": status, "read": lambda self: body})())
        p = mock.patch.object(ado, "opener", lambda repo: Opener())
        p.start()
        self.addCleanup(p.stop)
        return Opener

    def env(self, **values):
        p = mock.patch.dict(os.environ, values)
        p.start()
        self.addCleanup(p.stop)

    def test_the_pat_goes_in_basic_auth(self):
        self.env(AZURE_DEVOPS_PAT="secret")
        o = self.answer(body=b'{"value": []}')
        self.assertEqual(ado.call(REPO, "GET", ado.git_api(REPO, "pullrequests")), {"value": []})
        self.assertEqual(o.req.get_header("Authorization"), "Basic OnNlY3JldA==")

    def test_without_a_pat_gits_own_credentials_are_used_and_asked_again_once_refused(self):
        self.env(AZURE_DEVOPS_PAT="")
        asked = []
        with mock.patch.object(ado, "git_credential", lambda repo: asked.append(repo) or ("me", "tok")), mock.patch.dict(ado._creds, clear=True):
            self.answer(status=401)
            with self.assertRaises(ado.AdoError) as e:
                ado.call(REPO, "GET", ado.git_api(REPO, "pullrequests"))
        self.assertEqual((e.exception.kind, len(asked)), ("auth", 2))
        self.assertIn("git credential fill", str(e.exception))

    def test_403_names_the_proxy_and_a_sign_in_page_is_refused_credentials(self):
        self.env(AZURE_DEVOPS_PAT="secret")
        with open(ado.CONFIG, "w") as fh:
            json.dump({"proxy": "http://user:pw@127.0.0.1:7890"}, fh)
        self.answer(status=403)
        with self.assertRaises(ado.AdoError) as e:
            ado.call(REPO, "GET", ado.git_api(REPO, "pullrequests"))
        self.assertEqual(e.exception.kind, "forbidden")
        self.assertIn("through proxy http://127.0.0.1:7890", str(e.exception))
        self.answer(body=b"<html>sign in</html>")
        with self.assertRaises(ado.AdoError) as e:
            ado.call(REPO, "GET", ado.git_api(REPO, "pullrequests"))
        self.assertEqual(e.exception.kind, "auth")

    def test_the_proxy_git_uses_for_dev_azure_com(self):
        with mock.patch.object(base, "git", lambda cwd, *a: (True, "http://127.0.0.1:7890", "") if "--get-urlmatch" in a else (False, "", "")):
            self.assertEqual(ado.proxy(REPO), ("http://127.0.0.1:7890", "git config"))
        with open(ado.CONFIG, "w") as fh:
            json.dump({"proxy": ""}, fh)
        self.assertEqual(ado.proxy(REPO), (None, ado.CONFIG))

    def test_two_timeouts_back_the_scheduler_off_and_an_answer_ends_it(self):
        self.env(AZURE_DEVOPS_PAT="secret")
        self.answer(error=urllib.error.URLError(TimeoutError()))
        for _ in range(2):
            with self.assertRaises(ado.AdoError) as e:
                ado.call(REPO, "GET", ado.git_api(REPO, "pullrequests"))
            self.assertEqual(e.exception.kind, "timeout")
        self.assertGreater(ado.state()["until"], ado.now() + 60000)
        with mock.patch.object(ado, "BACKGROUND", True):
            with self.assertRaises(ado.AdoError) as e:
                ado.call(REPO, "GET", ado.git_api(REPO, "pullrequests"))
            self.assertEqual(e.exception.kind, "skipped")
        self.answer(body=b"{}")
        ado.call(REPO, "GET", ado.git_api(REPO, "pullrequests"))  # a person's command still asks
        self.assertEqual(ado.state().get("fails"), None)


if __name__ == "__main__":
    unittest.main()
