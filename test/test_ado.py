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
import herdr_task.ado_flow as ado_flow  # noqa: E402
import herdr_task.agents as agents  # noqa: E402
import herdr_task.base as base  # noqa: E402
import herdr_task.commands as commands  # noqa: E402
import herdr_task.ghnews as ghnews  # noqa: E402
import herdr_task.github as github  # noqa: E402
import herdr_task.output as output  # noqa: E402

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


REVIEWERS = [evaluation("queued", type_id="fa4e907d-c16b-4a4c-9dfa-4906e5d171dd", name="Minimum number of reviewers")]
BUILT = [evaluation("approved", buildDefinitionName="web-ci")]
ME = "6f1e2d3c-1111-2222-3333-1234567890ab"


class Accepting(Base):
    """SHEP-34: Accept (Merge, a merge policy) on Azure DevOps: completed at once when Azure DevOps allows it, else
    auto-complete on and the task Waiting to merge (ado_flow.py)."""

    def setUp(self):
        super().setUp()
        self.task = {"id": 1, "title": "Login", "state": "ready", "mode": "worktree", "worktree": "/w", "branch": "task/1-login",
                     "base": "main", "pr": {"number": 7, "url": ado.pr_url(REPO, 7), "repo": REPO}}
        self.store = Store([self.task])
        self.pulled = []
        done = lambda s, t, even_if_busy=False: t.update(state="done")
        for name, value in (("finish", done), ("watch_main", lambda *a: None), ("pull_main", lambda s, t, v=None: self.pulled.append(v))):
            p = mock.patch.object(ado_flow, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(ado.time, "sleep", lambda s: None)
        p.start()
        self.addCleanup(p.stop)

    def azure(self, views, patch=None, evaluations=BUILT):
        """Azure DevOps answering views (each GET of the pull request takes the next, the last one stays) and patch the PATCHes."""
        views = list(views)
        get = lambda url, body: views.pop(0) if len(views) > 1 else views[0]
        return self.fake({("GET", r"connectionData"): {"authenticatedUser": {"id": ME, "providerDisplayName": "Herdr Bot"}},
                          ("GET", r"git/repositories/web/pullrequests/7"): get,
                          ("PATCH", r"git/repositories/web/pullrequests/7"): patch or {},
                          ("GET", r"policy/evaluations"): {"value": list(evaluations)},
                          ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})

    def accept(self, code=0):
        said = []
        with mock.patch.object(commands, "open_store", lambda args, write=True: self.store), \
                mock.patch.object(commands, "busy_again", lambda *a: False), mock.patch.object(commands, "live_agents", lambda k: []), \
                mock.patch.object(commands, "view", lambda s, t, live=None: {**t, "why": agents.task_status(t, [])[2]}), \
                mock.patch.object(commands, "say", lambda args, data, text: said.append((data, text))), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            try:
                commands.cmd_accept(argparse.Namespace(id="SHEP-1", json=False, folder=None))
            except SystemExit as e:
                self.assertEqual(e.code, code)
                return None, err.getvalue()
        self.assertEqual(code, 0)
        return said[-1]

    @staticmethod
    def auto_complete_kept(url, body):
        return pr(autoCompleteSetBy={"id": ME}) if "autoCompleteSetBy" in body else {}

    def test_allowed_now_it_completes_the_tested_head_and_the_task_is_done(self):
        f = self.azure([pr(), pr(status="completed", lastMergeCommit={"commitId": "f00"})])
        data, text = self.accept()
        self.assertEqual((self.task["state"], self.task["merged"], data["accepted"]), ("done", True, "github"))
        self.assertNotIn("merge_wait", self.task)
        bodies = [c[3] for c in f.sent("PATCH", r".*")]
        self.assertEqual([(b["status"], b["lastMergeSourceCommit"], b["completionOptions"]["mergeStrategy"], b["completionOptions"]["deleteSourceBranch"])
                          for b in bodies], [("completed", {"commitId": "abc"}, "squash", True)])
        self.assertFalse(f.sent("GET", r"connectionData"))  # no auto-complete
        self.assertEqual(self.pulled[0]["mergeCommit"], {"oid": "f00"})  # the main checkout pulls

    def test_the_repos_own_merge_strategy(self):
        with open(ado.CONFIG, "w") as fh:
            json.dump({"merge": "rebase", "repos": {"contoso/My Proj/web": {"merge": "noFastForward"}}}, fh)
        f = self.fake({("GET", r"git/repositories/web/pullrequests/7"): pr(status="completed"), ("PATCH", r"git/repositories/web/pullrequests/7"): {}})
        self.assertEqual(ado.complete(self.task, {"headRefOid": "abc"}), ("merged", ""))
        self.assertEqual(f.sent("PATCH", r".*")[0][3]["completionOptions"]["mergeStrategy"], "noFastForward")

    def test_approval_needed_turns_on_auto_complete_and_it_waits_to_merge(self):
        with open(ado.CONFIG, "w") as fh:
            json.dump({"repos": {"contoso/My Proj/web": {"merge": "noFastForward", "transition_work_items": True}}}, fh)
        f = self.azure([pr()], self.auto_complete_kept, BUILT + REVIEWERS)
        # before Accept: the person's (SHEP-26, unchanged)
        self.task["pr"]["needs_approval"] = True
        self.assertEqual(agents.task_status(self.task, []), ("ready", None, "Waiting on reviewers in Azure DevOps"))
        data, text = self.accept()
        self.assertEqual([c[3] for c in f.sent("PATCH", r".*")], [{
            "autoCompleteSetBy": {"id": ME},
            "completionOptions": {"mergeStrategy": "noFastForward", "deleteSourceBranch": True, "transitionWorkItems": True,
                                  "mergeCommitMessage": "Merged PR 7: SHEP-1 Login"}}])  # never a completion
        self.assertEqual((self.task["state"], data["accepted"], "auto_merge" in self.task), ("ready", "waiting", False))
        self.assertTrue(self.task["merge_wait"])
        self.assertEqual(agents.task_status(self.task, []), ("merging", None, "Waiting on reviewers in Azure DevOps"))
        self.assertEqual(agents.STATUSES["merging"], "Waiting to merge")
        self.assertEqual(text, "SHEP-1 accepted: waiting to merge: Waiting on reviewers in Azure DevOps (auto-complete is on).")
        # Accept again: auto-complete set again, still waiting
        data, _ = self.accept()
        self.assertEqual((len(f.sent("PATCH", r".*")), data["accepted"]), (2, "waiting"))

    def test_a_refused_completion_falls_back_to_auto_complete(self):
        def patch(url, body):
            if body.get("status") == "completed":
                raise ado.AdoError("http", "HTTP 403: You need the Bypass policies permission")
            return self.auto_complete_kept(url, body)
        f = self.azure([pr()], patch)
        data, _ = self.accept()
        self.assertEqual([("status" in c[3], "autoCompleteSetBy" in c[3]) for c in f.sent("PATCH", r".*")], [(True, False), (False, True)])
        self.assertEqual((self.task["state"], data["accepted"]), ("ready", "waiting"))
        self.assertEqual(agents.task_status(self.task, []), ("merging", None, "Azure DevOps is completing it"))
        # a policy refusing it (rejectedByPolicy) too
        self.task.pop("merge_wait")
        self.azure([pr(), pr(mergeStatus="rejectedByPolicy", mergeFailureMessage="policies not met")], self.auto_complete_kept)
        self.assertEqual(commands.merge_now(self.store, self.task, publish=True), ado_flow.WAITS)

    def test_auto_complete_that_cant_be_turned_on_needs_you_and_accept_retries(self):
        def refuse(url, body):
            raise ado.AdoError("http", "HTTP 403: You need the Contribute to pull requests permission")
        self.azure([pr()], refuse, BUILT + REVIEWERS)
        _, err = self.accept(code=1)
        self.assertIn("Couldn't turn on auto-complete in Azure DevOps: HTTP 403: You need the Contribute", err)
        self.assertNotIn("merge_wait", self.task)
        self.task["attention_at"] = 0
        status, needs, why = agents.task_status(self.task, [])
        self.assertEqual((status, needs), ("needs", "attention"))
        self.assertTrue(why.startswith("Couldn't turn on auto-complete in Azure DevOps: "))
        self.assertTrue(why.startswith(ado_flow.ACCEPT_AGAIN))
        # Accept again, now allowed: waiting
        self.azure([pr()], self.auto_complete_kept, BUILT + REVIEWERS)
        data, _ = self.accept()
        self.assertEqual((data["accepted"], self.task.get("attention")), ("waiting", None))
        # Azure DevOps answering without keeping it
        self.task.pop("merge_wait")
        self.azure([pr()], {}, BUILT + REVIEWERS)
        self.assertEqual(commands.merge_now(self.store, self.task, publish=True),
                         "Couldn't turn on auto-complete in Azure DevOps: Azure DevOps didn't keep it")

    def test_a_problem_on_accept_needs_you_and_stops_waiting(self):
        self.task["merge_wait"] = 1
        self.azure([pr(mergeStatus="conflicts")])
        self.assertEqual(commands.merge_now(self.store, self.task, publish=True), "It conflicts with the base branch.")
        self.assertNotIn("merge_wait", self.task)

    def test_accept_publishes_a_draft_and_it_waits_to_merge(self):
        views = [pr(isDraft=True)]

        def patch(url, body):
            if "isDraft" in body:
                views[0] = pr(isDraft=body["isDraft"])
                return {}
            return self.auto_complete_kept(url, body)
        f = self.fake({("GET", r"connectionData"): {"authenticatedUser": {"id": ME}},
                       ("GET", r"git/repositories/web/pullrequests/7"): lambda url, b: views[0],
                       ("PATCH", r"git/repositories/web/pullrequests/7"): patch,
                       ("GET", r"policy/evaluations"): {"value": []}, ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        data, _ = self.accept()
        self.assertEqual([list(c[3])[0] for c in f.sent("PATCH", r".*")], ["isDraft", "autoCompleteSetBy"])  # published, never completed
        self.assertEqual((self.task["state"], data["accepted"]), ("ready", "waiting"))
        self.assertFalse(views[0]["isDraft"])

    def test_a_merge_policy_never_publishes_a_draft(self):
        f = self.fake({("GET", r"git/repositories/web/pullrequests/7"): pr(isDraft=True),
                       ("GET", r"policy/evaluations"): {"value": []}, ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        self.assertIn("draft", commands.merge_now(self.store, self.task))
        self.assertEqual(f.sent("PATCH", r".*"), [])

    def test_merge_waits_to_merge_too(self):
        self.azure([pr()], self.auto_complete_kept, BUILT + REVIEWERS)
        said = []
        with mock.patch.object(commands, "open_store", lambda args, write=True: self.store), \
                mock.patch.object(commands, "view", lambda s, t, live=None: {**t, "why": agents.task_status(t, [])[2]}), \
                mock.patch.object(commands, "say", lambda args, data, text: said.append((data, text))):
            commands.cmd_merge(argparse.Namespace(id="SHEP-1", json=False, folder=None))
        self.assertTrue(said[-1][0]["waiting"])
        self.assertIn("waiting to merge", said[-1][1])


class WaitingToMerge(Base):
    """SHEP-34: the tick's look at a task Waiting to merge, and what follows Azure DevOps' merge: the main checkout's
    fast-forward-only pull. Throwaway repos: main (origin a local bare repo) and another clone that makes the merge."""

    def setUp(self):
        super().setUp()
        import herdr_task.tick as tick
        self.tick = tick
        git = self.git = lambda *a: subprocess.run(["git", *a], check=True, capture_output=True, text=True).stdout.strip()
        self.main, self.bare, self.other = (os.path.join(self.tmp, x) for x in ("repo", "bare.git", "other"))
        git("init", "-q", "--bare", "-b", "main", self.bare)
        git("init", "-q", "-b", "main", self.main)
        git("clone", "-q", self.bare, self.other)
        for repo in (self.main, self.other):
            for k, v in (("user.name", "T"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
                git("-C", repo, "config", k, v)
        git("-C", self.main, "remote", "add", "origin", self.bare)
        for name in ("a.txt", "b.txt"):
            with open(os.path.join(self.main, name), "w") as fh:
                fh.write("one\n")
        git("-C", self.main, "add", ".")
        git("-C", self.main, "commit", "-q", "-m", "base")
        git("-C", self.main, "push", "-q", "origin", "main")
        self.task = {"id": 1, "title": "Login", "state": "ready", "mode": "worktree", "worktree": "/w", "branch": "task/1-login",
                     "base": "main", "merge_wait": 1, "ready_at": 0, "pr": {"number": 7, "url": ado.pr_url(REPO, 7), "repo": REPO, "checked": 0}}
        self.store = Store([self.task], self.main)
        done = lambda s, t, even_if_busy=False: t.update(state="done")
        for mod, name, value in ((ado_flow, "finish", done), (ado_flow, "watch_main", lambda *a: None), (self.tick, "live_agents", lambda k: []),
                                 (self.tick, "pr_news", lambda *a: None)):
            p = mock.patch.object(mod, name, value)
            p.start()
            self.addCleanup(p.stop)

    def merge_there(self, branch="main", text="two\n"):
        """Azure DevOps' merge: a commit on branch at origin changing a.txt; its sha."""
        self.git("-C", self.other, "fetch", "-q", "origin")
        self.git("-C", self.other, "checkout", "-q", "-B", branch, f"origin/{branch}")
        with open(os.path.join(self.other, "a.txt"), "w") as fh:
            fh.write(text)
        self.git("-C", self.other, "commit", "-q", "-am", "Merged PR 7: SHEP-1 Login")
        self.git("-C", self.other, "push", "-q", "origin", branch)
        return self.git("-C", self.other, "rev-parse", "HEAD")

    def look(self, d, evaluations=(), report=None):
        """One tick's look at the task's pull request (d: Azure DevOps' answer); its status after."""
        f = self.fake({("GET", r"git/repositories/web/pullrequests/7"): d, ("GET", r"policy/evaluations"): {"value": list(evaluations)},
                       ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        self.task["pr"]["checked"] = 0
        self.tick.facts(self.store, self.task, report if report is not None else {"attention": [], "done": []})
        self.assertEqual(f.sent("PATCH", r".*"), [])  # Herdr never completes it itself
        return agents.task_status({**self.task, "attention_at": 0}, [])

    def merged(self, sha, base="main"):
        return pr(status="completed", lastMergeCommit={"commitId": sha}, targetRefName=f"refs/heads/{base}")

    def read(self, name):
        with open(os.path.join(self.main, name)) as fh:
            return fh.read()

    def test_what_it_waits_on_and_never_completed_by_herdr(self):
        auto = {"autoCompleteSetBy": {"id": ME}}
        self.assertEqual(self.look(pr(**auto), BUILT + REVIEWERS), ("merging", None, "Waiting on reviewers in Azure DevOps"))
        self.assertEqual(self.look(pr(**auto), [evaluation("running", buildDefinitionName="web-ci")] + REVIEWERS),
                         ("merging", None, "Checks running"))
        self.assertEqual(self.look(pr(**auto), BUILT), ("merging", None, "Azure DevOps is completing it"))
        self.assertEqual(self.look(pr(mergeStatus="queued", **auto), BUILT), ("merging", None, "Azure DevOps is completing it"))
        # the tick's whole pass: no completion either, even with everything passed
        self.task["pr"]["checked"] = 0
        f = self.fake({("GET", r"git/repositories/web/pullrequests/7"): pr(**auto), ("GET", r"policy/evaluations"): {"value": BUILT},
                       ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        with mock.patch.object(self.tick, "back_pass", lambda *a: None):
            self.tick.tick_store(self.store, {"attention": [], "done": [], "started": []})
        self.assertEqual((f.sent("PATCH", r".*"), self.task["state"]), ([], "ready"))

    def test_problems_while_waiting_need_you_and_its_ready_again_is_the_persons(self):
        auto = {"autoCompleteSetBy": {"id": ME}}
        for d, ev, said in ((pr(reviewers=[{"displayName": "Ann", "vote": -10}], **auto), BUILT, "Review by Ann: rejected"),
                            (pr(reviewers=[{"displayName": "Ann", "vote": -5}], **auto), BUILT, "Review by Ann: waiting for the author"),
                            (pr(**auto), [evaluation("rejected", buildDefinitionName="web-ci")], "Checks failing: web-ci"),
                            (pr(mergeStatus="conflicts", **auto), BUILT, "It conflicts with the base branch."),
                            (pr(status="abandoned"), [], "The pull request was closed.")):
            self.task.pop("attention", None)
            status, needs, why = self.look(d, ev)
            self.assertEqual((status, needs), ("needs", "attention"), said)
            self.assertIn(said, why)
        # handed to its agent, which says ready again: Ready, for the person's Accept again
        with mock.patch.object(commands, "github", lambda s: None):
            commands.finalize(self.store, self.task)
        self.assertEqual(agents.task_status(self.task, [])[0], "ready")

    def test_auto_complete_turned_off_in_azure_devops_needs_you(self):
        report = {"attention": [], "done": []}
        status, needs, why = self.look(pr(), BUILT + REVIEWERS, report)
        self.assertEqual((status, needs, why, report["attention"]), ("needs", "attention", "Auto-complete was turned off in Azure DevOps", [1]))
        self.assertTrue(why.startswith(ado_flow.ACCEPT_AGAIN))
        # it stays until Accept turns it on again (not cleared by the next look)
        self.assertEqual(self.look(pr(), BUILT + REVIEWERS)[2], "Auto-complete was turned off in Azure DevOps")

    def test_merged_in_azure_devops_it_is_done_and_main_pulls_past_unrelated_changes(self):
        sha = self.merge_there()
        with open(os.path.join(self.main, "b.txt"), "w") as fh:
            fh.write("mine\n")
        report = {"attention": [], "done": []}
        self.look(self.merged(sha), report=report)
        self.assertEqual((self.task["state"], self.task["merged"], report["done"], "merge_wait" in self.task), ("done", True, [1], False))
        self.assertEqual(self.git("-C", self.main, "rev-parse", "HEAD"), sha)
        self.assertEqual((self.read("a.txt"), self.read("b.txt")), ("two\n", "mine\n"))
        self.assertNotIn("pull", self.task)

    def test_a_pull_that_fails_leaves_main_untouched_the_task_done_and_a_card(self):
        sha = self.merge_there()
        before = self.git("-C", self.main, "rev-parse", "HEAD")
        with open(os.path.join(self.main, "a.txt"), "w") as fh:
            fh.write("mine\n")
        self.look(self.merged(sha))
        self.assertEqual(self.task["state"], "done")
        self.assertEqual((self.git("-C", self.main, "rev-parse", "HEAD"), self.read("a.txt")), (before, "mine\n"))
        self.assertFalse(os.path.exists(os.path.join(self.main, ".git", "MERGE_HEAD")))
        self.assertEqual(self.git("-C", self.main, "status", "--porcelain"), "M a.txt")
        p = self.task["pull"]
        self.assertEqual((p["branch"], p["sha"]), ("main", sha))
        self.assertIn("would be overwritten by merge", p["why"])
        self.assertEqual(p["command"], f"git -C {self.main} pull --ff-only origin main")
        self.assertTrue(ado_flow.card(p).startswith("The main checkout couldn't pull main: "))
        # still there while main lacks the merge; gone once the person pulled
        self.assertFalse(ado_flow.pull_pass(self.store, self.task))
        self.git("-C", self.main, "checkout", "--", "a.txt")
        self.git("-C", self.main, "pull", "-q", "--ff-only", "origin", "main")
        self.assertTrue(ado_flow.pull_pass(self.store, self.task))
        self.assertNotIn("pull", self.task)

    def test_diverged_local_commits_a_card_and_dismiss(self):
        sha = self.merge_there()
        self.git("-C", self.main, "commit", "-q", "--allow-empty", "-m", "local")
        local = self.git("-C", self.main, "rev-parse", "HEAD")
        self.look(self.merged(sha))
        self.assertEqual((self.task["state"], self.git("-C", self.main, "rev-parse", "HEAD")), ("done", local))
        self.assertIn("fast-forward", self.task["pull"]["why"])
        # herdr-task list says it; dismiss takes it away
        self.assertIn("Needs you: The main checkout couldn't pull main", output.line({**self.task, "ref": "SHEP-1", "status": "done", "status_text": "Done"}))
        said = []
        with mock.patch.object(commands, "open_store", lambda args, write=True: self.store), \
                mock.patch.object(commands, "view", lambda s, t, live=None: dict(t)), \
                mock.patch.object(commands, "say", lambda args, data, text: said.append((data, text))):
            ado_flow.cmd_dismiss(argparse.Namespace(id="SHEP-1", json=True, folder=None))
        self.assertEqual((said[-1][0]["dismissed"], "pull" in self.task), (True, False))

    def test_merged_into_a_branch_not_checked_out_moves_it_silently(self):
        self.git("-C", self.main, "branch", "release")
        self.git("-C", self.main, "push", "-q", "origin", "release")
        sha = self.merge_there("release")
        self.task["base"] = "release"
        self.look(self.merged(sha, "release"))
        self.assertEqual((self.task["state"], self.git("-C", self.main, "rev-parse", "release")), ("done", sha))
        # diverged there: left as it is, nothing said
        self.task.update(state="ready", merge_wait=1)
        self.git("-C", self.main, "branch", "-f", "release", self.git("-C", self.main, "commit-tree", "-m", "x", "HEAD^{tree}"))
        mine = self.git("-C", self.main, "rev-parse", "release")
        sha = self.merge_there("release", "three\n")
        self.look(self.merged(sha, "release"))
        self.assertEqual((self.task["state"], self.git("-C", self.main, "rev-parse", "release"), "pull" in self.task), ("done", mine, False))

    def test_a_merge_policy_accepts_for_the_person(self):
        # Settings' merge policy (and an Accept made before SHEP-34: auto_merge on Azure DevOps): auto-complete, waiting
        self.task.pop("merge_wait")
        self.task.update(auto_merge="checks")
        f = self.fake({("GET", r"connectionData"): {"authenticatedUser": {"id": ME}},
                       ("GET", r"git/repositories/web/pullrequests/7"): pr(),
                       ("PATCH", r"git/repositories/web/pullrequests/7"): lambda url, body: pr(autoCompleteSetBy={"id": ME}),
                       ("GET", r"policy/evaluations"): {"value": BUILT + REVIEWERS},
                       ("GET", r"git/repositories/web/pullRequests/7/statuses"): {"value": []}})
        with mock.patch.object(self.tick, "back_pass", lambda *a: None):
            self.tick.tick_store(self.store, {"attention": [], "done": [], "started": []})
        self.assertEqual([list(c[3])[0] for c in f.sent("PATCH", r".*")], ["autoCompleteSetBy"])
        self.assertEqual((agents.task_status(self.task, [])[0], "auto_merge" in self.task), ("merging", False))

    def test_entering_it_is_no_news(self):
        import herdr_task.news as news
        with mock.patch.object(news, "view", lambda s, t, live: {"status": "merging", "needs": None, "why": "Checks running"}):
            self.assertIsNone(news.news_state(self.store, self.task, [])[1])

    def test_the_rule_is_cores(self):
        """The cases core/tasks.test.js checks place() on (core/merge-wait.cases.json)."""
        with open(os.path.join(ROOT, "core", "merge-wait.cases.json")) as f:
            g = json.load(f)
        with mock.patch.object(agents, "now", lambda: g["now"]):
            for c in g["cases"]:
                self.assertEqual(agents.task_status(c["task"], []), (c["expect"]["status"], c["expect"]["needs"], c["expect"]["why"]), c["name"])

    def test_a_github_pull_request_waiting_on_a_review_is_unchanged(self):
        t = {"state": "ready", "auto_merge": "checks", "pr": {"number": 3, "repo": "o/r", "needs_approval": True}}
        self.assertEqual(agents.task_status(t, []), ("working", None, "Merges once it's approved"))
        self.assertEqual(agents.task_status({"state": "ready", "pr": {"number": 3, "repo": "o/r", "needs_approval": True}}, []),
                         ("ready", None, None))

    def ready_wait(self, d, evaluations):
        self.task.pop("merge_wait", None)
        self.task["pr"].update(wait="Checks running")
        status = self.look(d, evaluations)[0]
        return self.task["pr"].get("wait"), status

    def test_before_accept_waiting_for_a_reviewer_is_ready_for_the_persons_accept(self):
        # SHEP-175 on Azure DevOps: builds done, a reviewer policy still to be met: Ready (Accept turns on auto-complete)
        wait, status = self.ready_wait(pr(), BUILT + REVIEWERS)
        self.assertEqual((wait, status), (None, "ready"))
        self.assertEqual(agents.task_status(self.task, [])[2], "Waiting on reviewers in Azure DevOps")  # SHEP-26
        wait, status = self.ready_wait(pr(), [evaluation("running", buildDefinitionName="web-ci")])
        self.assertEqual((wait, status), ("Checks running", "working"))

    def test_a_draft_waiting_on_a_validation_is_ready_for_the_accept_that_publishes_it(self):
        wait, status = self.ready_wait(pr(isDraft=True), [evaluation("queued", buildDefinitionName="web-ci")])
        self.assertEqual((wait, status), (None, "ready"))

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
