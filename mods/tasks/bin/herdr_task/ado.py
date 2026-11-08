"""Azure DevOps: the pull requests of a repo whose origin is on Azure DevOps, in gh's shapes, so the
rest of herdr-task (tick, proof, merge policies, news) treats them as GitHub's.

A repo on Azure DevOps is "ado:<org>/<project>/<repo>" wherever a GitHub one is "owner/name"
(github(), a task's pr["repo"]). Its REST API (7.1) is reached with Python's own urllib, through
the proxy git uses for dev.azure.com (or ~/.herdr/ado.json's), with the first credentials found:
AZURE_DEVOPS_PAT, ado.json's "pat", or git's own (git credential fill, as git push uses).

~/.herdr/ado.json (all optional): {"proxy": "http://127.0.0.1:7890", "pat": "...", "ca_file": "~/certs.pem",
"timeout": 10, "merge": "squash", "repos": {"<org>/<project>/<repo>": {"merge": "noFastForward"}}}. merge is
the completion's mergeStrategy: squash, noFastForward, rebase or rebaseMerge. ca_file: the certificates a
proxy that re-signs TLS needs (else git's http.sslCAInfo, else REQUESTS_CA_BUNDLE, else Python's own).

Every answer is text someone else chose: only known fields are read."""

import base64
import datetime
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from .base import Fail, git, HOME, now, proxy_for, STORE


PREFIX = "ado:"
CONFIG = os.environ.get("HERDR_TASK_ADO") or os.path.join(HOME, ".herdr", "ado.json")
STATE = os.path.join(STORE, ".ado.json")
API = "7.1"
TIMEOUT = 10
DESCRIPTION_MAX = 4000
BUILD_POLICY = "0609b952-1397-4640-95ec-e00a01b2c241"
NOTE = "Azure DevOps: "
# Only the scheduler's passes wait out a failing Azure DevOps (backoff); a person's command always asks.
BACKGROUND = sys.argv[1:2] in (["scheduler"], ["tick"])


class AdoError(Exception):
    """kind: auth (no or refused credentials), forbidden (403: the network policy, usually a missing
    proxy), timeout, network, http (any other refusal) or skipped (backing off)."""

    def __init__(self, kind, text):
        super().__init__(text)
        self.kind = kind


# ---- which repo -------------------------------------------------------------------------------

def _name_ok(name):
    return bool(name) and name not in (".", "..") and not re.search(r"[\x00-\x1f\x7f/\\?#]", name)


REMOTES = (
    r"(?:ssh://)?[^@/\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3/([^/]+)/([^/]+)/([^/]+?)/?",
    r"https://(?:[^@/\s]+@)?dev\.azure\.com/([^/]+)/([^/]+)/_git/([^/?#]+?)/?",
    r"https://(?:[^@/\s]+@)?([^./@\s]+)\.visualstudio\.com/(?:DefaultCollection/)?([^/]+)/_git/([^/?#]+?)/?",
)


def parse_remote(url):
    """(org, project, repo) of an Azure DevOps remote URL (https on dev.azure.com or visualstudio.com,
    or ssh v3), percent-decoded; None for any other."""
    url = (url or "").strip()
    for pattern in REMOTES:
        m = re.fullmatch(pattern, url, re.I)
        if m:
            names = tuple(urllib.parse.unquote(x) for x in m.groups())
            return names if all(_name_ok(n) for n in names) else None
    return None


def repo_in(folder):
    """The repo's id ("ado:org/project/repo") when its origin (else its first remote) is on Azure
    DevOps, else None."""
    names = git(folder, "remote")[1].split()
    if not names:
        return None
    ok, url, _ = git(folder, "remote", "get-url", "origin" if "origin" in names else names[0])
    found = parse_remote(url) if ok else None
    return PREFIX + "/".join(found) if found else None


def repo_of(s):
    """github()'s answer for a folder on Azure DevOps, else None."""
    return repo_in(s.loc["folder"]) if s.loc["kind"] == "repo" else None


def owns(repo):
    return isinstance(repo, str) and repo.startswith(PREFIX)


def parts(repo):
    org, project, name = repo[len(PREFIX):].split("/", 2)
    return org, project, name


def _q(text):
    return urllib.parse.quote(text, safe="")


def web(repo):
    org, project, name = parts(repo)
    return f"https://dev.azure.com/{_q(org)}/{_q(project)}/_git/{_q(name)}"


def pr_url(repo, n):
    return f"{web(repo)}/pullrequest/{n}"


def api(repo, path, version=API, **query):
    org, project, _ = parts(repo)
    return f"https://dev.azure.com/{_q(org)}/{_q(project)}/_apis/{path}?" + urllib.parse.urlencode({**query, "api-version": version})


def git_api(repo, path, **query):
    return api(repo, f"git/repositories/{_q(parts(repo)[2])}/{path}", **query)


# ---- settings and state -----------------------------------------------------------------------

def config():
    try:
        with open(CONFIG) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def repo_config(repo):
    repos = config().get("repos")
    own = repos.get(repo[len(PREFIX):]) if isinstance(repos, dict) else None
    return {**config(), **(own if isinstance(own, dict) else {})}


def state():
    try:
        with open(STATE) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def save_state(d):
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = f"{STATE}.{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(d, f)
        os.replace(tmp, STATE)
    except OSError:
        pass


def outcome(error=None):
    """Keeps how the last request went: a timeout or network failure twice in a row backs the
    scheduler off 2, 4, 8, then 16 minutes; any answer ends that."""
    st = state()
    if error is None:
        if st.get("fails") or st.get("error"):
            save_state({"ok": now()})
        return
    if error.kind in ("timeout", "network"):
        fails = (st.get("fails") or 0) + 1
        st.update(fails=fails, until=now() + min(16, 2 ** (fails - 1)) * 60000 if fails >= 2 else 0)
    else:
        st.update(fails=0, until=0)  # it answered, if only to refuse
    st.update(error=str(error), kind=error.kind, at=now())
    save_state(st)


# ---- credentials and proxy --------------------------------------------------------------------

_creds = {}


def _basic(user, password):
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def git_credential(repo):
    """(username, password) git keeps for the repo (its credential helper, e.g. Git Credential
    Manager), never asking anyone; None when it has none."""
    org, project, name = parts(repo)
    ask = f"protocol=https\nhost=dev.azure.com\npath={org}/{project}/_git/{name}\n\n"
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never", "GIT_ASKPASS": "", "SSH_ASKPASS": ""}
    try:
        r = subprocess.run(["git", "credential", "fill"], input=ask, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, env=env, cwd=HOME, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    got = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line) if r.returncode == 0 else {}
    return (got.get("username") or "", got["password"]) if got.get("password") else None


def credentials(repo, fresh=False):
    """(Authorization header, where it came from), or (None, None)."""
    pat = (os.environ.get("AZURE_DEVOPS_PAT") or "").strip()
    if pat:
        return _basic("", pat), "AZURE_DEVOPS_PAT"
    pat = str(config().get("pat") or "").strip()
    if pat:
        return _basic("", pat), CONFIG
    key = parts(repo)[0].lower()
    if fresh or key not in _creds:
        _creds[key] = git_credential(repo)
    return (_basic(*_creds[key]), "git credential fill") if _creds[key] else (None, None)


def proxy(repo):
    """(proxy URL or None, where it came from): ado.json's "proxy" ("" for none), else the one git
    uses for the org (git config http.<url>.proxy, http.proxy), else the environment's."""
    c = config()
    if "proxy" in c:
        return (str(c["proxy"]).strip() or None), CONFIG
    return proxy_for(f"https://dev.azure.com/{_q(parts(repo)[0])}/")


def redact(url):
    return re.sub(r"//[^@/]*@", "//", url or "")


def ca_file():
    """(certificates file or None, where it came from)."""
    if config().get("ca_file"):
        return os.path.expanduser(str(config()["ca_file"])), CONFIG
    ok, out, _ = git(HOME, "config", "--get-urlmatch", "http.sslCAInfo", "https://dev.azure.com/")
    if ok and out.strip():
        return os.path.expanduser(out.strip()), "git config"
    env = os.environ.get("REQUESTS_CA_BUNDLE")
    return (env, "REQUESTS_CA_BUNDLE") if env else (None, None)


def opener(repo):
    p, _ = proxy(repo)
    ca, _ = ca_file()
    tls = ssl.create_default_context(cafile=ca if ca and os.path.isfile(ca) else None)
    return urllib.request.build_opener(urllib.request.ProxyHandler({"http": p, "https": p} if p else {}),
                                       urllib.request.HTTPSHandler(context=tls), NoRedirect())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is Azure DevOps sending the request to its sign-in page: refused credentials."""

    def redirect_request(self, *a, **k):
        return None


# ---- requests ---------------------------------------------------------------------------------

def call(repo, method, url, body=None, raw=False):
    """One request: its JSON answer (raw: its text). Raises AdoError."""
    if method == "GET" and BACKGROUND and (state().get("until") or 0) > now():
        st = state()
        raise AdoError("skipped", f"skipped until {time.strftime('%H:%M', time.localtime(st['until'] / 1000))} after "
                                  f"{st.get('fails')} failed requests ({st.get('error')})")
    try:
        answer = _request(repo, method, url, body, raw)
    except AdoError as e:
        outcome(e)
        raise
    outcome()
    return answer


def _request(repo, method, url, body, raw):
    timeout = config().get("timeout") or TIMEOUT
    for attempt in (0, 1):
        auth, source = credentials(repo, fresh=attempt == 1)
        if not auth:
            raise AdoError("auth", "no credentials: set AZURE_DEVOPS_PAT, put a \"pat\" in ~/.herdr/ado.json, "
                                   "or sign in once with git (git push) so git credential fill has one")
        headers = {"Authorization": auth, "Accept": "text/plain" if raw else "application/json"}
        data = None
        if body is not None:
            data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with opener(repo).open(req, timeout=timeout) as r:
                status, text = r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status, text = e.code, (e.read() or b"").decode("utf-8", "replace")
            e.close()
        except (socket.timeout, TimeoutError):
            raise AdoError("timeout", f"no answer within {timeout} seconds (a 2FA sign-in waiting, or the proxy)")
        except urllib.error.URLError as e:
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                raise AdoError("timeout", f"no answer within {timeout} seconds (a 2FA sign-in waiting, or the proxy)")
            raise AdoError("network", f"couldn't connect: {e.reason}")
        except OSError as e:
            raise AdoError("network", f"couldn't connect: {e}")
        if status in (203, 301, 302, 303, 307, 401):
            if attempt == 0 and source == "git credential fill":
                continue  # an expired token: git's helper is asked once more
            raise AdoError("auth", f"the credentials from {source} were refused (HTTP {status})")
        if status == 403:
            p, _ = proxy(repo)
            raise AdoError("forbidden", "HTTP 403 " + (f"through proxy {redact(p)}" if p else "without a proxy")
                           + ": Azure DevOps refuses requests from outside its allowed network; set \"proxy\" in "
                             "~/.herdr/ado.json or git config http.https://dev.azure.com/.proxy")
        if status >= 400:
            try:
                message = json.loads(text).get("message")
            except (ValueError, AttributeError):
                message = None
            raise AdoError("http", f"HTTP {status}" + (f": {str(message)[:300]}" if message else ""))
        if raw:
            return text
        try:
            return json.loads(text) if text.strip() else {}
        except ValueError:
            raise AdoError("auth", "the answer isn't JSON (a sign-in page): the credentials were refused")
    raise AdoError("auth", "the credentials were refused")


def note(task, e):
    """A task whose pull request can't be read for want of credentials or the proxy says so (Needs
    you); timeouts only back off."""
    if e.kind in ("auth", "forbidden"):
        text = NOTE + str(e)
        if task.get("attention") != text:
            task["attention"], task["attention_at"] = text, now()


def unnote(task):
    if str(task.get("attention") or "").startswith(NOTE):
        task.pop("attention")


# ---- reading a pull request as gh does --------------------------------------------------------

STATES = {"active": "OPEN", "completed": "MERGED", "abandoned": "CLOSED"}
MERGEABLE = {"conflicts": "CONFLICTING", "succeeded": "MERGEABLE", "rejectedByPolicy": "MERGEABLE"}
EVALUATION = {"approved": ("COMPLETED", "SUCCESS"), "rejected": ("COMPLETED", "FAILURE"), "broken": ("COMPLETED", "FAILURE"),
              "running": ("IN_PROGRESS", ""), "queued": ("QUEUED", "")}
STATUS = {"succeeded": ("COMPLETED", "SUCCESS"), "failed": ("COMPLETED", "FAILURE"), "error": ("COMPLETED", "FAILURE"),
          "pending": ("IN_PROGRESS", ""), "notSet": ("QUEUED", "")}


def branch(ref):
    return re.sub(r"^refs/heads/", "", ref or "")


def check(name, status, conclusion, url=None):
    return {"__typename": "CheckRun", "name": str(name)[:200], "status": status, "conclusion": conclusion,
            **({"detailsUrl": url} if url else {})}


def build_url(repo, build_id):
    org, project, _ = parts(repo)
    return f"https://dev.azure.com/{_q(org)}/{_q(project)}/_build/results?buildId={int(build_id)}"


def checks_of(repo, d):
    """A pull request's checks in gh's statusCheckRollup shape: its blocking policies (builds by
    their name; reviewers, work items, comments by the policy's), its latest status per context, and
    a reviewer's "waiting for the author" or "rejected" vote as a failing one."""
    n = d["pullRequestId"]
    project_id = ((d.get("repository") or {}).get("project") or {}).get("id") or ""
    out = []
    if re.fullmatch(r"[0-9a-fA-F-]+", project_id):
        artifact = f"vstfs:///CodeReview/CodeReviewId/{project_id}/{n}"
        for e in call(repo, "GET", api(repo, "policy/evaluations", version=f"{API}-preview", artifactId=artifact)).get("value") or []:
            cfg = e.get("configuration") or {}
            if cfg.get("isEnabled") is False or cfg.get("isBlocking") is False or e.get("status") not in EVALUATION:
                continue
            kind, settings, ctx = cfg.get("type") or {}, cfg.get("settings") or {}, e.get("context") or {}
            build = str(kind.get("id") or "").lower() == BUILD_POLICY
            name = (settings.get("displayName") or ctx.get("buildDefinitionName") if build else None) or kind.get("displayName") or "Policy"
            if build and ctx.get("isExpired"):
                name += " (expired: queue it again)"
            url = build_url(repo, ctx["buildId"]) if build and str(ctx.get("buildId") or "").isdigit() else None
            out.append(check(name, *EVALUATION[e["status"]], url))
    latest = {}
    for st in call(repo, "GET", git_api(repo, f"pullRequests/{n}/statuses")).get("value") or []:
        ctx = st.get("context") or {}
        name = "/".join(x for x in (ctx.get("genre"), ctx.get("name")) if x) or "status"
        if name not in latest or (st.get("id") or 0) >= (latest[name].get("id") or 0):
            latest[name] = st
    for name, st in sorted(latest.items()):
        if st.get("state") in STATUS:
            out.append(check(name, *STATUS[st["state"]], st.get("targetUrl")))
    for r in d.get("reviewers") or []:
        vote = r.get("vote") or 0
        if vote <= -5:
            who = r.get("displayName") or "a reviewer"
            out.append(check(f"Review by {who}: " + ("rejected" if vote <= -10 else "waiting for the author"), "COMPLETED", "FAILURE", pr_url(repo, n)))
    return out


def files_of(repo, n):
    """How many files the pull request's latest iteration changes, or 0."""
    try:
        its = call(repo, "GET", git_api(repo, f"pullRequests/{n}/iterations")).get("value") or []
        if not its:
            return 0
        last = max(i.get("id") or 0 for i in its)
        changes = call(repo, "GET", git_api(repo, f"pullRequests/{n}/iterations/{last}/changes", **{"$top": 2000})).get("changeEntries") or []
    except AdoError:
        return 0
    return sum(1 for c in changes if not (c.get("item") or {}).get("isFolder"))


def shape(repo, d, checks, files=0):
    """gh pr view's JSON for an Azure DevOps pull request."""
    state = STATES.get(d.get("status"), "OPEN")
    merge = (d.get("lastMergeCommit") or {}).get("commitId")
    return {"number": d.get("pullRequestId"), "title": d.get("title") or "", "url": pr_url(repo, d.get("pullRequestId")),
            "state": state, "isDraft": bool(d.get("isDraft")), "mergeable": MERGEABLE.get(d.get("mergeStatus"), "UNKNOWN"),
            "headRefName": branch(d.get("sourceRefName")), "baseRefName": branch(d.get("targetRefName")),
            "headRefOid": (d.get("lastMergeSourceCommit") or {}).get("commitId") or "",
            "mergeCommit": {"oid": merge} if state == "MERGED" and merge else None,
            "statusCheckRollup": checks, "additions": 0, "deletions": 0, "changedFiles": files}


def view(repo, n, full=False):
    """Pull request n as gh pr view --json shows it (full: its checks and files whatever its state,
    for the Pull request views). Raises AdoError."""
    d = call(repo, "GET", git_api(repo, f"pullrequests/{int(n)}"))
    open_ = d.get("status") == "active"
    return shape(repo, d, checks_of(repo, d) if open_ or full else [], files_of(repo, n) if full else 0)


def pr_view(task):
    """github.pr_view for a task's pull request on Azure DevOps: gh's shape, or None."""
    pr = task["pr"]
    try:
        v = view(pr["repo"], pr["number"])
    except AdoError as e:
        note(task, e)
        return None
    unnote(task)
    return v


def listed(repo, task, status):
    """The repo's own pull requests (no fork's) from the task's branch into its base, in gh pr
    list's shape, newest first."""
    rows = call(repo, "GET", git_api(repo, "pullrequests", **{
        "searchCriteria.sourceRefName": f"refs/heads/{task['branch']}",
        "searchCriteria.targetRefName": f"refs/heads/{task.get('base') or 'main'}",
        "searchCriteria.status": status, "$top": 100})).get("value") or []
    _, project, name = parts(repo)
    out = []
    for d in rows:
        r = d.get("repository") or {}
        if d.get("forkSource") or str(r.get("name") or "").lower() != name.lower() \
                or str((r.get("project") or {}).get("name") or "").lower() != project.lower():
            continue
        v = shape(repo, d, [])
        out.append({**v, "isCrossRepository": False})
    return out


def pr_adopt(task, repo):
    """github.pr_adopt on Azure DevOps: the open pull request for the task's branch, into its base, at
    its tip here, recorded on the task; None when there is none."""
    ok, tip, _ = git(task["worktree"], "rev-parse", task["branch"])
    try:
        found = next((p for p in listed(repo, task, "active") if ok and tip and p["headRefOid"] == tip), None)
    except AdoError:
        found = None
    if found:
        task["pr"] = {"number": found["number"], "url": found["url"], "repo": repo}
    return task.get("pr") if found else None


def pr_merged(task, repo):
    """github.pr_merged on Azure DevOps: the completed pull request for the task's branch, or None."""
    try:
        return next(iter(listed(repo, task, "completed")), None)
    except AdoError:
        return None


# ---- opening and merging ----------------------------------------------------------------------

def wids(task):
    """The work items its pull request links: the task's own (--wid), else ADO-<id> in its branch's
    name, else git config branch.<branch>.ado-workitem."""
    if str(task.get("wid") or "").isdigit():
        return [str(task["wid"])]
    m = re.search(r"(?:^|[/_-])ADO-(\d+)(?:$|[/_-])", task.get("branch") or "", re.I)
    if m:
        return [m.group(1)]
    ok, out, _ = git(task["worktree"], "config", "--get", f"branch.{task['branch']}.ado-workitem")
    return [out.strip()] if ok and out.strip().isdigit() else []


def comment(repo, n, text):
    """The task's summary on its pull request, closed: never one more comment to resolve before it can merge."""
    if text and text.strip():
        call(repo, "POST", git_api(repo, f"pullRequests/{n}/threads"),
             {"comments": [{"parentCommentId": 0, "content": text.strip(), "commentType": 1}], "status": "closed"})


def pr_open(s, task, repo, summary=None):
    """github.pr_open on Azure DevOps: pushes the task's branch (git's own remote and proxy) and opens
    its pull request, linked to its work item, or keeps the open one."""
    wt, br, main = task["worktree"], task["branch"], s.loc["folder"]
    names = git(main, "remote")[1].split()
    remote = "origin" if "origin" in names else (names[0] if names else "origin")
    ok, _, err = git(wt, "push", "--force-with-lease", "-u", remote, br)
    if not ok:
        raise Fail(f"Couldn't push {br}: {err}")
    pr = task.get("pr") or {}
    try:
        if pr.get("number"):
            d = call(repo, "GET", git_api(repo, f"pullrequests/{int(pr['number'])}"))
            if d.get("status") == "active":
                comment(repo, pr["number"], summary)
                return pr
        if pr_adopt(task, repo):
            comment(repo, task["pr"]["number"], summary)
            return task["pr"]
        done = pr_merged(task, repo)
        if done:
            raise Fail(f"Pull request !{done['number']} for {br} is already merged, and {br} has commits since. "
                       f"Put them on a new branch (a new task) rather than a second pull request.")
        body = (task.get("prompt") or "").strip() or task["title"]
        if summary:
            body += "\n\n## Summary\n\n" + summary.strip()
        if (task.get("details") or "").strip():
            body += "\n\n## Details\n\n" + task["details"].strip()
        if len(body) > DESCRIPTION_MAX:
            body = body[:DESCRIPTION_MAX - 1] + "…"
        d = call(repo, "POST", git_api(repo, "pullrequests"), {
            "sourceRefName": f"refs/heads/{br}", "targetRefName": f"refs/heads/{task.get('base') or 'main'}",
            "title": f"{s.ref(task)} {task['title']}"[:400], "description": body,
            "workItemRefs": [{"id": w} for w in wids(task)]})
    except AdoError as e:
        raise Fail(f"Couldn't open a pull request on Azure DevOps: {e}")
    n = d.get("pullRequestId")
    if not n:
        raise Fail("Couldn't open a pull request on Azure DevOps: it answered without one.")
    task["pr"] = {"number": int(n), "url": pr_url(repo, n), "repo": repo}
    return task["pr"]


MERGE_WAIT = 12  # seconds a completion is watched before the tick takes over


def merge(task, v):
    """Completes the task's pull request at the head its checks passed on (lastMergeSourceCommit:
    never a commit pushed since), with the repo's merge strategy (default squash), deleting its
    branch there. Returns (ok, "", why not), as gh pr merge."""
    repo, n = task["pr"]["repo"], int(task["pr"]["number"])
    cfg = repo_config(repo)
    try:
        call(repo, "PATCH", git_api(repo, f"pullrequests/{n}"), {
            "status": "completed", "lastMergeSourceCommit": {"commitId": v.get("headRefOid") or ""},
            "completionOptions": {"mergeStrategy": cfg.get("merge") or "squash", "deleteSourceBranch": True,
                                  "transitionWorkItems": bool(cfg.get("transition_work_items"))}})
        # Azure DevOps completes it in the background: watched a moment, then the tick's next look.
        until = time.time() + MERGE_WAIT
        while True:
            d = call(repo, "GET", git_api(repo, f"pullrequests/{n}"))
            if d.get("status") == "completed":
                return True, "", ""
            if d.get("mergeStatus") in ("conflicts", "failure", "rejectedByPolicy"):
                return False, "", f"Azure DevOps couldn't complete it: {d.get('mergeFailureMessage') or d.get('mergeStatus')}"
            if time.time() > until:
                return False, "", "Azure DevOps is still completing it; the next check marks it done once it has."
            time.sleep(2)
    except AdoError as e:
        return False, "", f"Azure DevOps: {e}"


# ---- news: comments, failed builds, the base branch -------------------------------------------

def when(text):
    """Azure DevOps' 2026-11-03T10:00:00.1234567Z as ms, or None."""
    m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)", str(text or ""))
    if not m:
        return None
    return int(datetime.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)


def pr_comments(repo, n):
    """ghnews.pr_comments on Azure DevOps: its comments with words, oldest first, and each vote of
    "waiting for the author" or "rejected" as a review asking for changes; None when it didn't answer.
    Threads Azure DevOps writes itself (pushes, policies, other votes) are left out."""
    try:
        threads = call(repo, "GET", git_api(repo, f"pullRequests/{int(n)}/threads")).get("value") or []
    except AdoError:
        return None
    out = []
    for th in threads:
        if not isinstance(th, dict) or th.get("isDeleted") or th.get("id") is None:
            continue
        props = th.get("properties") or {}
        cs = [c for c in th.get("comments") or [] if isinstance(c, dict) and not c.get("isDeleted")]
        url = f"{pr_url(repo, n)}?discussionId={th['id']}"
        if (props.get("CodeReviewThreadType") or {}).get("$value") == "VoteUpdate":
            vote = str((props.get("CodeReviewVoteResult") or {}).get("$value") or "")
            at = when((cs[0] if cs else {}).get("publishedDate") or th.get("publishedDate"))
            if vote in ("-5", "-10") and at is not None:
                who = ((cs[0] if cs else {}).get("author") or {}).get("displayName") or "a reviewer"
                out.append({"id": f"r{th['id']}", "at": at, "who": who[:64], "body": "", "url": url, "state": "CHANGES_REQUESTED"})
            continue
        if not cs or str(cs[0].get("commentType") or "").lower() == "system":
            continue
        ctx = th.get("threadContext") or {}
        line = (ctx.get("rightFileStart") or ctx.get("leftFileStart") or {}).get("line")
        where = (str(ctx["filePath"]).lstrip("/") + (f":{line}" if line else "")) if ctx.get("filePath") else None
        for c in cs:
            at = when(c.get("publishedDate"))
            if at is None or str(c.get("commentType") or "").lower() == "system":
                continue
            out.append({"id": f"c{th['id']}.{c.get('id')}", "at": at, "who": ((c.get("author") or {}).get("displayName") or "someone")[:64],
                        "body": (c.get("content") or "").strip(), "url": url, **({"where": where} if where else {})})
    return sorted(out, key=lambda c: (c["at"], c["id"]))


def build_log(repo, build):
    """gh run view --log-failed for a build: (ok, the log of its last failed step, error)."""
    try:
        records = call(repo, "GET", api(repo, f"build/builds/{int(build)}/timeline")).get("records") or []
        failed = [r for r in records if isinstance(r, dict) and r.get("result") == "failed"]
        steps = sorted((r for r in failed if r.get("type") == "Task" and (r.get("log") or {}).get("id")), key=lambda r: r.get("startTime") or "")
        if steps:  # the first step that failed: what the others failed after
            return True, call(repo, "GET", api(repo, f"build/builds/{int(build)}/logs/{int(steps[0]['log']['id'])}"), raw=True), ""
        issues = [str(i.get("message")) for r in failed for i in r.get("issues") or [] if isinstance(i, dict) and i.get("message")]
        return (True, "\n".join(issues), "") if issues else (False, "", "no failed step with a log")
    except (AdoError, ValueError) as e:
        return False, "", str(e)


def commits(repo, version, kind="branch", top=50):
    rows = call(repo, "GET", git_api(repo, "commits", **{"searchCriteria.itemVersion.version": version,
                                                         "searchCriteria.itemVersion.versionType": kind,
                                                         "searchCriteria.$top": top})).get("value") or []
    return [r for r in rows if isinstance(r, dict) and r.get("commitId")]


def main_commits(repo, base):
    """The base branch's newest commits, newest first, as gh api .../commits --jq 'map(.sha)'."""
    try:
        return True, json.dumps([r["commitId"] for r in commits(repo, base)]), ""
    except AdoError as e:
        return False, "", str(e)


_ids = {}


def repo_id(repo):
    """The repo's id, which build queries filter by (they refuse its name)."""
    if repo not in _ids:
        _ids[repo] = call(repo, "GET", git_api(repo, "")).get("id")
    return _ids[repo]


RESULTS = {"succeeded": "success", "partiallySucceeded": "neutral", "failed": "failure", "canceled": "cancelled"}


def main_runs(repo, base):
    """The base branch's CI builds (pushes only), as gh run list --json headSha,status,conclusion,url,
    workflowName,databaseId."""
    _, _, name = parts(repo)
    try:
        builds = call(repo, "GET", api(repo, "build/builds", branchName=f"refs/heads/{base}", reasonFilter="individualCI,batchedCI",
                                       repositoryId=repo_id(repo), repositoryType="TfsGit", queryOrder="queueTimeDescending",
                                       **{"$top": 100})).get("value") or []
    except AdoError as e:
        return False, "", str(e)
    runs = [{"headSha": b.get("sourceVersion"), "status": "completed" if b.get("status") == "completed" else "in_progress",
             "conclusion": RESULTS.get(b.get("result"), ""), "url": ((b.get("_links") or {}).get("web") or {}).get("href") or build_url(repo, b.get("id") or 0),
             "workflowName": (b.get("definition") or {}).get("name") or "a build", "databaseId": b.get("id")}
            for b in builds if str((b.get("repository") or {}).get("name") or "").lower() == name.lower()]
    return True, json.dumps(runs), ""


def commits_since(repo, green, sha):
    """The first lines of the commits after green up to sha, oldest first (at most 20), as gh api
    .../compare/green...sha does."""
    try:
        rows = commits(repo, sha, "commit", 100)
    except AdoError as e:
        return False, "", str(e)
    lines = []
    for r in rows:
        if r["commitId"] == green:
            break
        lines.append(str(r.get("comment") or "").split("\n")[0])
    return True, json.dumps(lines[::-1][-20:]), ""


# ---- herdr-task ado ---------------------------------------------------------------------------

def cmd_check(args):
    """herdr-task ado check: the folder's repo, the credentials and proxy it uses, and a request."""
    folder = os.path.realpath(os.path.expanduser(args.folder or os.getcwd()))
    repo = repo_in(folder) if os.path.isdir(folder) else None
    if not repo:
        raise Fail(f"{folder}'s origin isn't on Azure DevOps.")
    _, source = credentials(repo)
    p, psource = proxy(repo)
    ca, casource = ca_file()
    out = {"repo": repo, "credentials": source, "proxy": redact(p) if p else None, "proxy_from": psource, "ca_file": ca, "ca_from": casource}
    try:
        org = parts(repo)[0]
        user = (call(repo, "GET", f"https://dev.azure.com/{_q(org)}/_apis/connectionData?api-version={API}-preview")
                .get("authenticatedUser") or {})
        call(repo, "GET", git_api(repo, "pullrequests", **{"$top": 1}))
        out.update(ok=True, user=user.get("providerDisplayName") or user.get("id"))
    except AdoError as e:
        out.update(ok=False, error=str(e), kind=e.kind)
    if args.json:
        print(json.dumps(out))
    else:
        print(f"{repo}\n  credentials: {source or 'none'}\n  proxy: {out['proxy'] or 'none'}" + (f" ({psource})" if psource else "")
              + f"\n  certificates: {ca or 'Python default'}" + (f" ({casource})" if casource else ""))
        print(f"  signed in as {out['user']}" if out.get("ok") else f"  failed: {out['error']}")
    if not out.get("ok"):
        sys.exit(1)


def cmd_pr_view(args):
    """herdr-task ado pr view <n> --repo ado:... --json <fields>: as gh pr view, for the Pull request views."""
    if not owns(args.repo):
        raise Fail(f"{args.repo} isn't an Azure DevOps repo (ado:<org>/<project>/<repo>).")
    try:
        v = view(args.repo, int(args.number), full=True)
    except (AdoError, ValueError) as e:
        raise Fail(f"Azure DevOps didn't answer: {e}")
    fields = [f for f in (args.fields or "").split(",") if f] or list(v)
    print(json.dumps({f: v.get(f) for f in fields}))


def add_cli(sub):
    a = sub.add_parser("ado", help="Azure DevOps: check the connection (check), a pull request as gh shows one (pr view)").add_subparsers(dest="ado")
    c = a.add_parser("check", help="the folder's Azure DevOps repo, the credentials and proxy used, and one request")
    c.add_argument("--folder")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_check)
    c = a.add_parser("pr").add_subparsers(dest="ado_pr").add_parser("view", help="a pull request as gh pr view --json shows one")
    c.add_argument("number")
    c.add_argument("--repo", required=True)
    c.add_argument("--json", dest="fields", default="")
    c.set_defaults(fn=cmd_pr_view)
