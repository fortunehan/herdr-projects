//! Pull request follow-up. Everything read from a forge is attacker-chosen
//! text: only a fixed set of fields is kept, names are sanitised, and comment
//! bodies are never copied anywhere.
//!
//! Callers go through the forge-neutral functions here; each one picks the
//! forge from the thread's `origin`. An `origin` on no followed forge gets
//! GitHub's handling, which never follows it: nothing is found by branch and
//! a pull request named for it is ignored.

pub mod ado;
pub mod github;

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::paths::Env;
use crate::runner::Runner;

const NAME_LIMIT: usize = 80;

/// The service that hosts a repository's pull requests, told apart by the
/// repository's `origin`.
#[derive(Debug, Clone, PartialEq)]
pub enum Forge {
    GitHub(github::Remote),
    AzureDevOps(ado::Remote),
}

impl Forge {
    /// The forge of an `origin` remote URL; `None` when no followed forge
    /// hosts it.
    pub fn of(origin: &str) -> Option<Forge> {
        github::parse_remote(origin).map(Forge::GitHub).or_else(|| ado::parse_remote(origin).map(Forge::AzureDevOps))
    }

    /// Whether `origin` is on Azure DevOps.
    pub fn is_azure_devops(origin: &str) -> bool {
        matches!(Forge::of(origin), Some(Forge::AzureDevOps(_)))
    }
}

/// How one thread reaches its forge during one pass. Azure DevOps requests
/// after a failed one are skipped; `gh` calls are not.
pub struct Client<'a> {
    pub runner: &'a dyn Runner,
    ado: ado::Client<'a>,
}

impl<'a> Client<'a> {
    pub fn new(runner: &'a dyn Runner, env: &Env) -> Self {
        Client { runner, ado: ado::Client::new(runner, env) }
    }
}

/// The trimmed `PR:` value of a report's first line.
fn pr_value(report: &str) -> Option<&str> {
    Some(report.lines().next()?.strip_prefix("PR:")?.trim())
}

/// The `PR:` value of a report's first line, checked against the thread's
/// `origin` and in its canonical form. `Err` carries a note for the inbox item
/// when a `PR:` line is present but not acceptable.
pub fn pr_line(report: &str, origin: &str) -> Result<Option<String>, String> {
    match Forge::of(origin) {
        Some(Forge::GitHub(_)) | None => github::pr_line(report),
        Some(Forge::AzureDevOps(remote)) => ado::pr_line(report, &remote),
    }
}

/// How a pull request is named to the user, without the `PR ` prefix: `#N`
/// for GitHub, `!N` for Azure DevOps. `None` for a URL that is no followed
/// pull request.
pub fn reference(url: &str) -> Option<String> {
    if github::valid_pr_url(url) {
        return Some(format!("#{}", url.rsplit('/').next().unwrap_or_default()));
    }
    ado::parse_pr_url(url).map(|(_, id)| format!("!{id}"))
}

/// The PR reference with the full URL, `PR #4 (https://…/pull/4)`, so the
/// coordinator can link it without assembling a URL; the bare URL when it is
/// no followed pull request.
pub fn named(url: &str) -> String {
    match reference(url) {
        Some(reference) => format!("PR {reference} ({url})"),
        None => url.to_string(),
    }
}

/// Why a pull request could not be viewed.
#[derive(Debug)]
pub enum ViewError {
    /// The forge could not be asked; this counts toward its outage.
    Unreachable(anyhow::Error),
    /// The forge answered with something that is not a pull request.
    BadOutput(anyhow::Error),
}

/// The pull request at `url` as a thread on `branch` of `origin` sees it: a
/// summary, or ignored when it is not the thread's. On Azure DevOps only its
/// repository is checked, not its source branch (see `ado::reduce`).
pub fn view(client: &Client, url: &str, origin: &str, branch: &str) -> Result<Checked, ViewError> {
    match Forge::of(origin) {
        Some(Forge::GitHub(_)) | None => {
            let json = github::view(client.runner, url, origin).map_err(ViewError::Unreachable)?;
            github::reduce(&json, branch, origin).map_err(ViewError::BadOutput)
        }
        Some(Forge::AzureDevOps(remote)) => {
            let Some((_, id)) = ado::parse_pr_url(url).filter(|(named, _)| named.same(&remote)) else {
                return Ok(Checked::Ignored("it is not a pull request of the thread's `origin`".into()));
            };
            ado::view(&client.ado, &remote, id)
        }
    }
}

/// The URL of the pull request whose head is `branch` of `origin`, for a
/// thread whose report names none: open first, then merged, then closed,
/// newest first. `None` without asking when no followed forge hosts `origin`.
pub fn find_by_branch(client: &Client, origin: &str, branch: &str) -> Result<Option<String>> {
    match Forge::of(origin) {
        Some(Forge::GitHub(_)) => github::find_by_branch(client.runner, origin, branch),
        Some(Forge::AzureDevOps(remote)) => ado::find_by_branch(&client.ado, &remote, branch),
        None => Ok(None),
    }
}

/// The account whose identity `own_id` returns for `origin`: the GitHub host,
/// or the Azure DevOps organisation. Threads on one account share it.
pub fn account(origin: &str) -> String {
    match Forge::of(origin) {
        Some(Forge::AzureDevOps(remote)) => format!("ado:{}", remote.org.to_lowercase()),
        Some(Forge::GitHub(_)) | None => format!("github:{}", github::host_of(origin)),
    }
}

/// Who the threads act as on `origin`'s forge: comments by it are the
/// threads' own replies.
pub fn own_id(client: &Client, origin: &str) -> Option<String> {
    match Forge::of(origin) {
        Some(Forge::GitHub(_)) | None => github::own_login(client.runner, origin),
        Some(Forge::AzureDevOps(remote)) => client.ado.own_user(&remote.org).ok(),
    }
}

/// Pull requests a report names, per repository, other than `except` (the
/// thread's tracked one). Numbers of issues come along too; only those
/// `own_open_numbers` lists count.
pub fn named_in_report(report: &str, origin: &str, except: &str) -> BTreeMap<String, BTreeSet<u32>> {
    match Forge::of(origin) {
        Some(Forge::GitHub(_)) | None => github::report_refs(report, origin, except),
        Some(Forge::AzureDevOps(remote)) => ado::report_refs(report, &remote, except),
    }
}

/// Numbers of the open pull requests in `repo`, a key of `named_in_report`,
/// that the threads' own account opened, asked through `origin`'s forge.
pub fn own_open_numbers(client: &Client, origin: &str, repo: &str) -> Result<BTreeSet<u32>> {
    match Forge::of(origin) {
        Some(Forge::GitHub(_)) | None => github::open_own_numbers(client.runner, repo, &github::host_of(origin)),
        Some(Forge::AzureDevOps(_)) => {
            let remote = ado::parse_remote(repo).ok_or_else(|| anyhow!("not an Azure DevOps repository"))?;
            ado::own_open_numbers(&client.ado, &remote)
        }
    }
}

/// Check names and logins are attacker-chosen: cut to 80 characters and
/// stripped of control characters and newlines before they are written.
pub fn sanitize(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).take(NAME_LIMIT).collect::<String>().trim().to_string()
}

/// What is kept of a pull request. No bodies, no titles.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Summary {
    pub state: String,
    pub review_decision: String,
    pub failing_checks: Vec<String>,
    pub comment_count: usize,
    pub commenters: Vec<String>,
    /// Comments and reviews (inline ones included) per author login.
    pub activity: BTreeMap<String, usize>,
    /// The pull request's head commit, so a merged branch is deleted only
    /// when the local tip is what was merged.
    pub head_oid: String,
}

#[derive(Debug, PartialEq)]
pub enum Checked {
    Summary(Summary),
    /// The pull request is not this thread's; the reason goes in one inbox item.
    Ignored(String),
}

/// One line describing what changed between two summaries; fields only.
pub fn describe_change(old: Option<&Summary>, new: &Summary) -> String {
    let mut parts = vec![format!("state {}", new.state)];
    if !new.review_decision.is_empty() {
        parts.push(format!("review {}", new.review_decision));
    }
    if !new.failing_checks.is_empty() {
        parts.push(format!("failing checks: {}", new.failing_checks.join(", ")));
    }
    parts.push(format!("{} comment(s)", new.comment_count));
    let known: &[String] = old.map(|o| o.commenters.as_slice()).unwrap_or(&[]);
    let fresh: Vec<&str> = new.commenters.iter().filter(|c| !known.contains(c)).map(String::as_str).collect();
    if !fresh.is_empty() {
        parts.push(format!("new commenters: {}", fresh.join(", ")));
    }
    parts.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_cut_to_80_characters() {
        assert_eq!(sanitize(&"x".repeat(200)).len(), 80);
        assert_eq!(sanitize("a\r\nb\tc"), "abc");
    }

    #[test]
    fn change_descriptions_name_only_new_commenters() {
        let old = Summary { commenters: vec!["alice".into()], comment_count: 1, state: "OPEN".into(), ..Summary::default() };
        let new = Summary { commenters: vec!["alice".into(), "bob".into()], comment_count: 2, state: "OPEN".into(), ..Summary::default() };
        let text = describe_change(Some(&old), &new);
        assert!(text.contains("new commenters: bob"), "{text}");
        assert!(!text.contains("alice"));
        assert!(text.contains("2 comment(s)"));
    }

    #[test]
    fn the_forge_comes_from_the_origin() {
        let github = |host: &str| Some(Forge::GitHub(github::Remote { host: host.into(), repo: "owner/repo".into() }));
        assert_eq!(Forge::of("git@github.com:Owner/Repo.git"), github("github.com"));
        assert_eq!(Forge::of("http://github.localhost/Owner/Repo.git"), github("github.localhost"));
        let ado = Some(Forge::AzureDevOps(ado::Remote { org: "org".into(), project: "project".into(), repo: "repo".into() }));
        assert_eq!(Forge::of("https://dev.azure.com/org/project/_git/repo"), ado);
        assert!(Forge::is_azure_devops("git@ssh.dev.azure.com:v3/org/project/repo"));
        for other in ["https://gitlab.com/o/r", ""] {
            assert_eq!(Forge::of(other), None, "{other}");
        }
    }

    #[test]
    fn a_pull_request_is_referenced_by_its_forge() {
        assert_eq!(reference("https://github.com/o/r/pull/4").as_deref(), Some("#4"));
        assert_eq!(reference("https://dev.azure.com/org/p/_git/r/pullrequest/42").as_deref(), Some("!42"));
        assert_eq!(reference(""), None);
        assert_eq!(reference("https://github.com/o/r/issues/4"), None);
        assert_eq!(named("https://github.com/o/r/pull/4"), "PR #4 (https://github.com/o/r/pull/4)");
    }

    #[test]
    fn an_origin_on_no_forge_finds_nothing_by_branch_and_asks_nobody() {
        use crate::runner::fake::FakeRunner;
        let runner = FakeRunner::new();
        let home = tempfile::tempdir().unwrap();
        let client = Client::new(&runner, &Env::for_test(home.path(), &[]));
        assert_eq!(find_by_branch(&client, "https://gitlab.com/o/r", "b").unwrap(), None);
        assert!(runner.calls.borrow().is_empty());
    }

    #[test]
    fn an_azure_devops_pull_request_of_another_repository_is_ignored_unasked() {
        use crate::runner::fake::FakeRunner;
        let runner = FakeRunner::new();
        let home = tempfile::tempdir().unwrap();
        let client = Client::new(&runner, &Env::for_test(home.path(), &[(ado::PAT_VAR, "pat")]));
        let origin = "https://dev.azure.com/org/p/_git/app";
        for url in ["https://dev.azure.com/org/p/_git/other/pullrequest/4", "https://github.com/o/r/pull/4", ""] {
            assert!(matches!(view(&client, url, origin, "b"), Ok(Checked::Ignored(_))), "{url}");
        }
        assert!(runner.calls.borrow().is_empty());
    }
}
