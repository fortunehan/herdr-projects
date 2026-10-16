//! The mainline of a repository: the line new work starts from and analysis
//! reads, found by rule (ADR 0007) unless PROJECT.md overrides it.
//!
//! 1. `--base` wins; then a repository's `mainline` override, which skips
//!    the rest and the cache.
//! 2. An origin not on Azure DevOps: candidate `origin/main`.
//! 3. An Azure DevOps origin: `origin/main` when its README (from `origin/main`,
//!    else `origin/HEAD`) mentions `trunk-`, otherwise `origin/develop`; a
//!    missing `origin/develop` falls back to `origin/main`.
//! 4. Candidate missing on origin, or no origin: local `main`.
//! 5. A local `X` that contains `origin/X` and is ahead wins; diverged keeps
//!    `origin/X`, with a warning.
//! 6. None of these: `origin/HEAD`, else the current branch, with a warning.
//!
//! Only the rule of steps 2 and 3 (`main` or `develop`) is cached, per
//! repository, with the origin URL it was found for; the rest is evaluated at
//! every use. The facts come from one shell script read from standard input,
//! run by `sh` here and through ssh on another machine.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::paths::Ctx;
use crate::project::{self, Project};
use crate::remote;
use crate::runner::{Cmd, Runner};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const FACTS_TIMEOUT: Duration = Duration::from_secs(20);
/// Marks the facts script on a command line, for the scripted fake runner.
pub const FACTS_MARK: &str = "hp-mainline-facts";
const CACHE_FILE: &str = ".mainline.json";

/// The branch steps 2 and 3 choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Rule {
    Main,
    Develop,
}

impl Rule {
    fn branch(self) -> &'static str {
        match self {
            Rule::Main => "main",
            Rule::Develop => "develop",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readme {
    /// It mentions `trunk-`.
    Trunk,
    Plain,
    Missing,
}

/// A ref the script looked at: its commit and, when the checkout has a
/// commit, how far the checkout is from it (behind, ahead).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RefFacts {
    pub commit: String,
    pub gap: Option<(u32, u32)>,
}

/// What git says about a repository, read in one go.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts {
    pub origin: String,
    /// Whether the fetch just made worked; `None` when none was made.
    pub fetch_ok: Option<bool>,
    /// Seconds since the epoch of the last fetch (`FETCH_HEAD`).
    pub fetched_at: Option<i64>,
    /// The checkout's commit and branch (empty when detached).
    pub head: String,
    pub branch: String,
    /// `origin/HEAD`'s target, as `origin/<name>`.
    pub origin_head: String,
    /// By full ref name: `refs/heads/main`, `refs/remotes/origin/develop`, ...
    pub refs: BTreeMap<String, RefFacts>,
    /// Local `X` against `origin/X`: (commits only on origin, only local).
    pub pairs: BTreeMap<String, (u32, u32)>,
    /// The commit `--base` names, when one was asked for.
    pub base: Option<String>,
    /// The override's full ref name and facts, when it was asked for and found.
    pub pin: Option<(String, RefFacts)>,
    /// Lines `git status --porcelain` printed, when asked for.
    pub dirty: Option<usize>,
    pub readme: Option<Readme>,
}

impl Facts {
    fn commit(&self, full: &str) -> Option<&RefFacts> {
        self.refs.get(full)
    }
}

/// The ref a thread starts from or reads, and its commit.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mainline {
    /// `origin/main`, `main`, `origin/master`, a branch, or a commit.
    pub reference: String,
    pub commit: String,
    /// Named by `--base`, not found by rule.
    pub given: bool,
    /// The repository's mainline override in PROJECT.md.
    pub pinned: bool,
    pub warnings: Vec<String>,
    /// How far the checkout is from it (behind, ahead).
    pub gap: Option<(u32, u32)>,
}

/// A repository found by its path, here or on another machine.
pub struct Location<'a> {
    pub path: &'a str,
    /// Empty for this machine.
    pub machine: &'a str,
    /// The ssh target of `machine`.
    pub target: Option<&'a str>,
}

#[derive(Default)]
pub struct Options<'a> {
    pub fetch: bool,
    /// Count uncommitted changes in the checkout.
    pub status: bool,
    /// Detect the rule again instead of using the cache.
    pub refresh: bool,
    pub base: Option<&'a str>,
    /// The repository's mainline override (`mainline` in `[[repos]]`).
    pub pinned: Option<&'a str>,
}

pub struct Found {
    pub facts: Facts,
    pub mainline: Mainline,
}

impl Found {
    /// `fetched 2026-10-12 14:03`, `not fetched yet`, or "" with no origin.
    pub fn fetched(&self) -> String {
        fetched_label(&self.facts)
    }

    /// Notes for a brief: a failed fetch, then the warnings.
    pub fn notes(&self) -> Vec<String> {
        let mut notes = Vec::new();
        if self.facts.fetch_ok == Some(false) {
            notes.push("The fetch from origin failed: the mainline is as of the last fetch.".to_string());
        }
        notes.extend(self.mainline.warnings.iter().map(|w| format!("Warning: {w}")));
        notes
    }
}

fn fetched_label(facts: &Facts) -> String {
    if facts.origin.is_empty() {
        return String::new();
    }
    match facts.fetched_at.and_then(|s| jiff::Timestamp::from_second(s).ok()) {
        Some(at) => format!("fetched {}", at.to_zoned(jiff::tz::TimeZone::system()).strftime("%Y-%m-%d %H:%M")),
        None => "not fetched yet".into(),
    }
}

pub fn short(commit: &str) -> &str {
    commit.get(..7).unwrap_or(commit)
}

/// The facts script. `fetch`, `readme` and `status` switch its optional
/// parts on; `base` is resolved when not empty.
fn script(repo: &str, fetch: bool, readme: bool, status: bool, base: &str, pin: &str) -> String {
    let on = |b: bool| if b { "1" } else { "0" };
    format!(
        r#"cd {repo} || exit 3
git rev-parse --git-dir >/dev/null 2>&1 || exit 3
n=origin
o=$(git remote get-url "$n" 2>/dev/null)
printf 'origin\t%s\n' "$o"
if [ {fetch} = 1 ] && [ -n "$o" ]; then
  if git fetch "$n" >/dev/null 2>&1; then printf 'fetch\tok\n'; else printf 'fetch\tfailed\n'; fi
fi
f=$(git rev-parse --git-path FETCH_HEAD)
if [ -f "$f" ]; then printf 'fetched\t%s\n' "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")"; fi
h=$(git rev-parse --verify --quiet HEAD)
printf 'head\t%s\t%s\n' "$h" "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"
printf 'origin-head\t%s\n' "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
for r in refs/heads/main refs/heads/develop refs/remotes/origin/main refs/remotes/origin/develop refs/remotes/origin/HEAD; do
  s=$(git rev-parse --verify --quiet "$r^{{commit}}") || continue
  g=
  if [ -n "$h" ]; then g=$(git rev-list --left-right --count "$s...$h"); fi
  printf 'ref\t%s\t%s\t%s\n' "$r" "$s" "$g"
done
for b in main develop; do
  l=$(git rev-parse --verify --quiet "refs/heads/$b^{{commit}}") || continue
  u=$(git rev-parse --verify --quiet "refs/remotes/origin/$b^{{commit}}") || continue
  printf 'pair\t%s\t%s\n' "$b" "$(git rev-list --left-right --count "$u...$l")"
done
p={pin}
if [ -n "$p" ]; then
  for r in "refs/heads/$p" "refs/remotes/$p" "refs/remotes/origin/$p"; do
    s=$(git rev-parse --verify --quiet "$r^{{commit}}") || continue
    g=
    if [ -n "$h" ]; then g=$(git rev-list --left-right --count "$s...$h"); fi
    printf 'pin\t%s\t%s\t%s\n' "$r" "$s" "$g"
    break
  done
fi
b={base}
if [ -n "$b" ]; then printf 'base\t%s\n' "$(git rev-parse --verify --quiet --end-of-options "$b^{{commit}}")"; fi
if [ {status} = 1 ]; then printf 'dirty\t%s\n' "$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"; fi
if [ {readme} = 1 ] && [ -n "$o" ]; then
  m=none
  for r in refs/remotes/origin/main refs/remotes/origin/HEAD; do
    git rev-parse --verify --quiet "$r^{{commit}}" >/dev/null || continue
    x=$(git ls-tree --name-only "$r" | grep -i -x 'readme\.md' | head -n 1)
    if [ -z "$x" ]; then continue; fi
    if git show "$r:$x" | grep -q -i 'trunk-'; then m=trunk; else m=plain; fi
    break
  done
  printf 'readme\t%s\n' "$m"
fi
exit 0
"#,
        repo = remote::quote(repo),
        base = remote::quote(base),
        pin = remote::quote(pin),
        fetch = on(fetch),
        status = on(status),
        readme = on(readme),
    )
}

fn count(text: &str) -> u32 {
    text.trim().parse().unwrap_or(0)
}

fn gap(fields: &[&str]) -> Option<(u32, u32)> {
    match fields {
        [behind, ahead, ..] if !behind.is_empty() => Some((count(behind), count(ahead))),
        _ => None,
    }
}

pub fn parse(text: &str) -> Facts {
    let mut facts = Facts::default();
    for line in text.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["origin", url] => facts.origin = url.trim().to_string(),
            ["fetch", state] => facts.fetch_ok = Some(*state == "ok"),
            ["fetched", at] => facts.fetched_at = at.trim().parse().ok(),
            ["head", commit, branch] => {
                facts.head = commit.trim().to_string();
                facts.branch = branch.trim().to_string();
            }
            ["origin-head", name] => facts.origin_head = name.trim().to_string(),
            ["ref", name, commit, rest @ ..] => {
                facts.refs.insert(name.to_string(), RefFacts { commit: commit.trim().to_string(), gap: gap(rest) });
            }
            ["pair", branch, rest @ ..] => {
                if let Some(pair) = gap(rest) {
                    facts.pairs.insert(branch.to_string(), pair);
                }
            }
            ["pin", name, commit, rest @ ..] => facts.pin = Some((name.to_string(), RefFacts { commit: commit.trim().to_string(), gap: gap(rest) })),
            ["base", commit] => facts.base = Some(commit.trim().to_string()),
            ["dirty", lines] => facts.dirty = lines.trim().parse().ok(),
            ["readme", found] => {
                facts.readme = Some(match *found {
                    "trunk" => Readme::Trunk,
                    "plain" => Readme::Plain,
                    _ => Readme::Missing,
                })
            }
            _ => {}
        }
    }
    facts
}

fn gather(runner: &dyn Runner, at: &Location, fetch: bool, readme: bool, status: bool, base: &str, pin: &str) -> Result<Facts> {
    let script = script(at.path, fetch, readme, status, base, pin);
    let out = match at.target {
        None => runner.run(&Cmd::new("sh", FACTS_TIMEOUT).args(["-s", "--", FACTS_MARK]).stdin(script))?,
        Some(target) => {
            let timeout = if fetch { remote::SSH_START_TIMEOUT } else { remote::SSH_TIMEOUT };
            remote::ssh(runner, target, &format!("sh -s -- {FACTS_MARK}"), Some(&script), timeout)?
        }
    };
    if !out.success() {
        let place = if at.machine.is_empty() { String::new() } else { format!(" on {}", at.machine) };
        bail!("{}{place} is not a usable git repository: {}", at.path, out.error_text());
    }
    Ok(parse(&out.stdout))
}

/// Steps 2 and 3: the rule, and a warning when the README was missing.
pub fn rule_of(facts: &Facts) -> (Rule, Option<String>) {
    if facts.origin.is_empty() || !crate::pr::Forge::is_azure_devops(&facts.origin) {
        return (Rule::Main, None);
    }
    match facts.readme {
        Some(Readme::Trunk) => (Rule::Main, None),
        Some(Readme::Plain) => (Rule::Develop, None),
        Some(Readme::Missing) | None => (Rule::Develop, Some("no README.md on origin/main or origin/HEAD to tell trunk-based from develop; taking develop".into())),
    }
}

/// Steps 3 (the develop fallback) to 6, from the cached or detected rule.
pub fn resolve(facts: &Facts, rule: Rule) -> Result<Mainline> {
    let mut warnings = Vec::new();
    let found = |reference: &str, full: &str, warnings: Vec<String>| {
        let at = facts.commit(full).cloned().unwrap_or_default();
        Mainline { reference: reference.to_string(), commit: at.commit, gap: at.gap, warnings, ..Default::default() }
    };
    if !facts.origin.is_empty() {
        let mut branch = rule.branch();
        if branch == "develop" && facts.commit("refs/remotes/origin/develop").is_none() {
            warnings.push("origin/develop does not exist; falling back to main".into());
            branch = "main";
        }
        let remote = format!("refs/remotes/origin/{branch}");
        if facts.commit(&remote).is_some() {
            match facts.pairs.get(branch) {
                Some(&(0, ahead)) if ahead > 0 => return Ok(found(branch, &format!("refs/heads/{branch}"), warnings)),
                Some(&(behind, ahead)) if behind > 0 && ahead > 0 => warnings.push(format!(
                    "local `{branch}` and origin/{branch} have diverged ({ahead} commits only local, {behind} only on origin); taking origin/{branch}"
                )),
                _ => {}
            }
            return Ok(found(&format!("origin/{branch}"), &remote, warnings));
        }
    }
    if facts.commit("refs/heads/main").is_some() {
        return Ok(found("main", "refs/heads/main", warnings));
    }
    let missing = if facts.origin.is_empty() { "no origin and no local main".to_string() } else { format!("no origin/{} and no local main", rule.branch()) };
    if facts.commit("refs/remotes/origin/HEAD").is_some() {
        let name = if facts.origin_head.is_empty() { "origin/HEAD" } else { facts.origin_head.as_str() };
        warnings.push(format!("{missing}; taking origin/HEAD ({name})"));
        return Ok(found(name, "refs/remotes/origin/HEAD", warnings));
    }
    if facts.head.is_empty() {
        bail!("{missing}, and the checkout has no commit to start from");
    }
    let name = if facts.branch.is_empty() { facts.head.clone() } else { facts.branch.clone() };
    warnings.push(format!("{missing}, and no origin/HEAD; taking the main checkout's current branch `{name}`"));
    Ok(Mainline { reference: name, commit: facts.head.clone(), gap: Some((0, 0)), warnings, ..Default::default() })
}

/// What the cache holds for one repository: the rule and the origin URL it
/// was found for, and the mainline as last found, for `context`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Entry {
    /// `None` while only an override has been resolved.
    #[serde(default)]
    rule: Option<Rule>,
    origin: String,
    #[serde(default)]
    last: Option<Last>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Last {
    reference: String,
    commit: String,
    /// `fetched <time>`, `not fetched yet`, or "" without an origin.
    fetched: String,
    warnings: Vec<String>,
    /// When it was found.
    at: String,
    /// The override it was found from; `None` when found by rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pinned: Option<String>,
}

fn now() -> String {
    jiff::Timestamp::now().to_zoned(jiff::tz::TimeZone::system()).strftime("%Y-%m-%d %H:%M").to_string()
}

/// A mainline override that names no local branch and no remote ref: an
/// error at `thread start`, a warning in `mainline` and `context`.
#[derive(Debug)]
pub struct MissingOverride(pub String);

impl std::fmt::Display for MissingOverride {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MissingOverride {}

/// Refuses an override git could read as an option or a range.
pub fn validate_override(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') || name.contains("..") || name.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c)) {
        bail!("`{name}` is not a usable branch or remote ref for a mainline override");
    }
    Ok(())
}

fn cache_path(project: &Project) -> PathBuf {
    project.dir().join(CACHE_FILE)
}

/// The path, canonical for a local repository so every spelling of it
/// shares one entry; `machine:path` for another machine's.
fn cache_key(path: &str, machine: &str) -> String {
    if !machine.is_empty() {
        return format!("{machine}:{path}");
    }
    std::fs::canonicalize(path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string())
}

fn cached(project: &Project, key: &str) -> Option<Entry> {
    let text = std::fs::read_to_string(cache_path(project)).ok()?;
    serde_json::from_str::<BTreeMap<String, Entry>>(&text).ok()?.remove(key)
}

fn remember(project: &Project, key: &str, entry: Entry) -> Result<()> {
    let _lock = project.lock()?;
    let path = cache_path(project);
    let mut all: BTreeMap<String, Entry> = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    all.insert(key.to_string(), entry);
    project::write_atomic(&path, serde_json::to_string_pretty(&all)?.as_bytes())
}

/// Finds a repository's mainline (or the `--base` it was given). A local
/// fetch runs on its own, so a hanging one costs its timeout, not the facts.
pub fn find(project: &Project, runner: &dyn Runner, at: &Location, options: &Options) -> Result<Found> {
    let base = options.base.unwrap_or("");
    if base.starts_with('-') {
        bail!("`{base}` is not a usable base");
    }
    let pin = if base.is_empty() { options.pinned.unwrap_or("") } else { "" };
    if !pin.is_empty() {
        validate_override(pin)?;
    }
    let key = cache_key(at.path, at.machine);
    let entry = if options.refresh || !base.is_empty() || !pin.is_empty() { None } else { cached(project, &key) };
    let mut fetch_ok = None;
    if options.fetch && at.target.is_none() {
        let git = |args: &[&str], timeout| runner.run(&Cmd::new("git", timeout).args(["-C", at.path]).args(args.iter().copied()));
        let origin = git(&["remote", "get-url", "origin"], GIT_TIMEOUT).ok().filter(|o| o.success()).map(|o| o.stdout.trim().to_string()).unwrap_or_default();
        if !origin.is_empty() {
            let fetched = git(&["fetch", "origin"], FETCH_TIMEOUT);
            if let Err(error) = fetched.as_ref().map_err(|e| format!("{e:#}")).and_then(|o| if o.success() { Ok(()) } else { Err(o.error_text()) }) {
                eprintln!("warning: git fetch origin in {}: {}", at.path, error.trim());
            }
            fetch_ok = Some(fetched.is_ok_and(|o| o.success()));
        }
    }
    let readme = base.is_empty() && pin.is_empty() && entry.as_ref().and_then(|e| e.rule).is_none();
    let mut facts = gather(runner, at, options.fetch && at.target.is_some(), readme, options.status, base, pin)?;
    if fetch_ok.is_some() {
        facts.fetch_ok = fetch_ok;
    }
    if !base.is_empty() {
        let commit = facts.base.clone().unwrap_or_default();
        if commit.is_empty() {
            bail!("`{base}` is not a commit in {}", at.path);
        }
        let gap = facts.refs.values().find(|r| r.commit == commit).and_then(|r| r.gap);
        let mainline = Mainline { reference: base.to_string(), commit, given: true, gap, ..Default::default() };
        return Ok(Found { facts, mainline });
    }
    if !pin.is_empty() {
        // The rule found earlier is kept for when the override goes.
        let rule = cached(project, &key).filter(|e| e.origin == facts.origin).and_then(|e| e.rule);
        let place = if at.machine.is_empty() { String::new() } else { format!(" on {}", at.machine) };
        let found = facts.pin.clone().map(|(full, at)| {
            let reference = full.strip_prefix("refs/heads/").or(full.strip_prefix("refs/remotes/")).unwrap_or(&full).to_string();
            Mainline { reference, commit: at.commit, gap: at.gap, pinned: true, ..Default::default() }
        });
        let missing = format!("the mainline override `{pin}` (PROJECT.md) is neither a local branch nor a remote ref in {}{place}", at.path);
        let last = Last {
            reference: found.as_ref().map_or(pin.to_string(), |m| m.reference.clone()),
            commit: found.as_ref().map(|m| m.commit.clone()).unwrap_or_default(),
            fetched: fetched_label(&facts),
            warnings: if found.is_some() { Vec::new() } else { vec![missing.clone()] },
            at: now(),
            pinned: Some(pin.to_string()),
        };
        remember(project, &key, Entry { rule, origin: facts.origin.clone(), last: Some(last) })?;
        return match found {
            Some(mainline) => Ok(Found { facts, mainline }),
            None => Err(MissingOverride(missing).into()),
        };
    }
    let mut warning = None;
    let rule = match entry.filter(|e| e.origin == facts.origin).and_then(|e| e.rule) {
        Some(rule) => rule,
        None => {
            if facts.readme.is_none() && crate::pr::Forge::is_azure_devops(&facts.origin) {
                facts.readme = gather(runner, at, false, true, false, "", "")?.readme;
            }
            let (rule, missing) = rule_of(&facts);
            warning = missing;
            rule
        }
    };
    let resolved = resolve(&facts, rule).map(|mut mainline| {
        mainline.warnings.splice(0..0, warning);
        mainline
    });
    let last = resolved.as_ref().ok().map(|m| Last {
        reference: m.reference.clone(),
        commit: m.commit.clone(),
        fetched: fetched_label(&facts),
        warnings: m.warnings.clone(),
        at: now(),
        pinned: None,
    });
    remember(project, &key, Entry { rule: Some(rule), origin: facts.origin.clone(), last })?;
    Ok(Found { facts, mainline: resolved? })
}

/// A worktree thread's brief lines, from its record.
pub fn worktree_lines(thread: &crate::thread::Thread) -> String {
    if thread.base_commit.is_empty() {
        return String::new();
    }
    let label = if thread.base_given {
        "Base (from --base)"
    } else if thread.base_pinned {
        "Mainline (override in PROJECT.md)"
    } else {
        "Mainline"
    };
    let when = if thread.base_fetched.is_empty() { String::new() } else { format!(" ({})", thread.base_fetched) };
    let mut out = format!("- {label}: `{}` @ {}{when}. Your branch starts here; cite this commit in your report.\n", thread.base, short(&thread.base_commit));
    for note in &thread.base_notes {
        out.push_str(&format!("  - {note}\n"));
    }
    out
}

/// One repository in a tab, checkout or design thread's brief: the mainline,
/// the main checkout and the gap between them. Whether they differ, too.
fn checkout_line(path: &str, found: &Found) -> (String, bool) {
    let m = &found.mainline;
    let f = &found.facts;
    let when = found.fetched();
    let when = if when.is_empty() { String::new() } else { format!(" ({when})") };
    let on = if f.branch.is_empty() { "a detached HEAD".to_string() } else { format!("`{}`", f.branch) };
    let mut parts = Vec::new();
    let (behind, ahead) = m.gap.unwrap_or((0, 0));
    if behind > 0 {
        parts.push(format!("{behind} behind"));
    }
    if ahead > 0 {
        parts.push(format!("{ahead} ahead"));
    }
    let dirty = f.dirty.unwrap_or(0) > 0;
    if dirty {
        parts.push("with uncommitted changes".into());
    }
    let differs = !parts.is_empty() || m.gap.is_none();
    let state = if m.gap.is_none() {
        "its distance to the mainline is unknown".to_string()
    } else if parts.is_empty() {
        "the same commit, nothing uncommitted".to_string()
    } else {
        parts.join(", ")
    };
    let kind = if m.pinned { "mainline (override)" } else { "mainline" };
    let mut line = format!("  - {path}: {kind} `{}` @ {}{when}; main checkout on {on} @ {}: {state}.\n", m.reference, short(&m.commit), short(&f.head));
    for note in found.notes() {
        line.push_str(&format!("    - {note}\n"));
    }
    (line, differs)
}

/// The brief lines of a tab, checkout or design thread: every local
/// repository of the project (and the thread's own) as its main checkout is
/// now, after a fetch of origin. The fetch moves only remote-tracking refs;
/// the checkouts are never touched. A missing mainline override is an error.
pub fn checkout_lines(project: &Project, runner: &dyn Runner, repos: &[project::Repo], own: &str) -> Result<String> {
    let mut paths: Vec<(String, Option<&str>)> = repos.iter().filter(|r| r.machine.is_none()).map(|r| (r.path.clone(), r.pinned_mainline())).collect();
    if !own.is_empty() && !paths.iter().any(|(p, _)| p == own || std::fs::canonicalize(p).is_ok_and(|c| c.to_string_lossy() == own)) {
        paths.push((own.to_string(), None));
    }
    if paths.is_empty() {
        return Ok(String::new());
    }
    let mut out = String::from("- Mainlines, and the main checkouts as they are now:\n");
    let mut any_differs = false;
    for (path, pinned) in &paths {
        let at = Location { path, machine: "", target: None };
        match find(project, runner, &at, &Options { fetch: true, status: true, pinned: *pinned, ..Default::default() }) {
            Ok(found) => {
                let (line, differs) = checkout_line(path, &found);
                any_differs |= differs;
                out.push_str(&line);
            }
            Err(error) if error.is::<MissingOverride>() => return Err(error),
            Err(error) => out.push_str(&format!("  - {path}: mainline unknown ({error:#})\n")),
        }
    }
    if any_differs {
        out.push_str("  - Where a main checkout differs from its mainline, read the mainline with `git show <commit>:<file>` and `git diff <commit>`; never switch, reset, stash or change the checkout. Say in your report which commit you read.\n");
    } else {
        out.push_str("  - Say in your report which commit you read.\n");
    }
    Ok(out)
}

fn location_for<'a>(ctx: &Ctx, repo: &'a project::Repo, target: &'a mut Option<String>) -> Result<Location<'a>> {
    let machine = repo.machine.as_deref().unwrap_or("");
    if !machine.is_empty() {
        *target = Some(remote::ssh_target(ctx.runner, &ctx.env.herdr_bin(), &ctx.config_dir, machine)?);
    }
    Ok(Location { path: &repo.path, machine, target: target.as_deref() })
}

fn describe(reference: &str, commit: &str, fetched: &str, warnings: &[String]) -> String {
    let mut text = format!("`{reference}` @ {}", short(commit));
    if !fetched.is_empty() {
        text.push_str(&format!(" ({fetched})"));
    }
    for warning in warnings {
        text.push_str(&format!("; warning: {warning}"));
    }
    text
}

/// One repository's mainline for `context`, from the cache only: no git,
/// fetch or ssh. Thread starts and `mainline` keep it current.
pub fn summary(project: &Project, repo: &project::Repo) -> String {
    let key = cache_key(&repo.path, repo.machine.as_deref().unwrap_or(""));
    let pinned = repo.pinned_mainline();
    // A result found under another override, or by rule, is not this one.
    let last = cached(project, &key).and_then(|e| e.last).filter(|l| l.pinned.as_deref() == pinned);
    match (last, pinned) {
        (Some(last), Some(_)) if last.commit.is_empty() => format!("override, warning: {}, as of {}", last.warnings.join("; "), last.at),
        (Some(last), Some(_)) => format!("{}, override in PROJECT.md, as of {}", describe(&last.reference, &last.commit, &last.fetched, &last.warnings), last.at),
        (Some(last), None) => format!("{}, as of {}", describe(&last.reference, &last.commit, &last.fetched, &last.warnings), last.at),
        (None, Some(pin)) => format!("override `{pin}` in PROJECT.md, not resolved yet (`mainline {}` resolves it)", project.slug),
        (None, None) => format!("not found yet (`mainline {}` finds it)", project.slug),
    }
}

/// `mainline <slug> [--refresh]`: finds each repository's mainline now,
/// over ssh for another machine's, without fetching; `--refresh` detects
/// the rule again instead of using the cache.
pub fn cli(ctx: &Ctx, slug: &str, refresh: bool) -> Result<()> {
    let project = Project::load(&ctx.root, slug)?;
    let (settings, _) = project.read_project_md().context("could not read PROJECT.md")?;
    if settings.repos.is_empty() {
        println!("`{slug}` has no repositories");
    }
    for repo in &settings.repos {
        let place = repo.machine.as_ref().map(|m| format!(" (machine {m})")).unwrap_or_default();
        let mut target = None;
        let options = Options { refresh, pinned: repo.pinned_mainline(), ..Default::default() };
        let found = location_for(ctx, repo, &mut target).and_then(|at| find(&project, ctx.runner, &at, &options));
        let text = match found {
            Ok(found) if found.mainline.pinned => format!("{} (override)", describe(&found.mainline.reference, &found.mainline.commit, &found.fetched(), &found.mainline.warnings)),
            Ok(found) => describe(&found.mainline.reference, &found.mainline.commit, &found.fetched(), &found.mainline.warnings),
            Err(error) if error.is::<MissingOverride>() => format!("warning: {error}"),
            Err(error) => format!("unknown ({})", format!("{error:#}").lines().next().unwrap_or("")),
        };
        println!("{}{place}: {text}", repo.path);
    }
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::runner::RealRunner;
    use crate::runner::fake::FakeRunner;
    use std::path::Path;

    pub fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    pub fn commit(dir: &Path, file: &str, text: &str) -> String {
        std::fs::write(dir.join(file), text).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", file]);
        git(dir, &["rev-parse", "HEAD"])
    }

    /// A bare `origin` with `main` (README `readme`) and optionally
    /// `develop`, and a clone of it at `<root>/clone`. With `url` origin's URL
    /// is set to it, to choose the forge; `fetch` then reaches the bare
    /// repository without going through origin.
    pub struct Repos {
        pub root: tempfile::TempDir,
        pub clone: PathBuf,
        pub seed: PathBuf,
    }

    impl Repos {
        pub fn new(url: Option<&str>, readme: Option<&str>, develop: bool) -> Repos {
            let root = tempfile::tempdir().unwrap();
            let bare = root.path().join("origin.git");
            let seed = root.path().join("seed");
            git(root.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
            git(root.path(), &["init", "-q", seed.to_str().unwrap()]);
            match readme {
                Some(text) => commit(&seed, "ReadMe.MD", text),
                None => commit(&seed, "code.rs", "fn main() {}"),
            };
            git(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
            git(&seed, &["push", "-q", "origin", "main"]);
            if develop {
                git(&seed, &["checkout", "-q", "-b", "develop"]);
                commit(&seed, "dev.txt", "develop");
                git(&seed, &["push", "-q", "origin", "develop"]);
                git(&seed, &["checkout", "-q", "main"]);
            }
            let clone = root.path().join("clone");
            git(root.path(), &["clone", "-q", bare.to_str().unwrap(), clone.to_str().unwrap()]);
            if let Some(url) = url {
                git(&clone, &["remote", "set-url", "origin", url]);
            }
            Repos { root, clone, seed }
        }

        pub fn path(&self) -> String {
            self.clone.to_string_lossy().into_owned()
        }

        pub fn bare(&self) -> String {
            self.root.path().join("origin.git").to_string_lossy().into_owned()
        }

        /// What `git fetch origin` does, from the bare repository.
        pub fn fetch(&self) {
            git(&self.clone, &["fetch", "-q", "--prune", &self.bare(), "+refs/heads/*:refs/remotes/origin/*"]);
        }
    }

    pub const ADO: &str = "https://dev.azure.com/org/Proj/_git/app";
    pub const GITHUB: &str = "https://github.com/owner/app.git";

    fn project() -> (tempfile::TempDir, Project) {
        let home = tempfile::tempdir().unwrap();
        let project = project::create(home.path(), "demo", "", vec![]).unwrap();
        (home, project)
    }

    fn found(project: &Project, path: &str, options: &Options) -> Found {
        find(project, &RealRunner, &Location { path, machine: "", target: None }, options).unwrap()
    }

    fn mainline(project: &Project, path: &str) -> Mainline {
        found(project, path, &Options::default()).mainline
    }

    #[test]
    fn an_origin_off_azure_devops_gives_origin_main() {
        let (_home, project) = project();
        let repos = Repos::new(Some(GITHUB), Some("nothing here"), true);
        let m = mainline(&project, &repos.path());
        assert_eq!(m.reference, "origin/main");
        assert_eq!(m.commit, git(&repos.clone, &["rev-parse", "origin/main"]));
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
    }

    #[test]
    fn azure_devops_with_trunk_in_the_readme_gives_origin_main() {
        let (_home, project) = project();
        let repos = Repos::new(Some(ADO), Some("We are TRUNK-based."), true);
        let m = mainline(&project, &repos.path());
        assert_eq!(m.reference, "origin/main");
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
    }

    #[test]
    fn azure_devops_without_trunk_gives_origin_develop() {
        let (_home, project) = project();
        let repos = Repos::new(Some(ADO), Some("Branch from develop."), true);
        let m = mainline(&project, &repos.path());
        assert_eq!(m.reference, "origin/develop");
        assert_eq!(m.commit, git(&repos.clone, &["rev-parse", "origin/develop"]));
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
    }

    #[test]
    fn azure_devops_without_a_readme_gives_origin_develop_with_a_warning() {
        let (_home, project) = project();
        let repos = Repos::new(Some(ADO), None, true);
        let m = mainline(&project, &repos.path());
        assert_eq!(m.reference, "origin/develop");
        assert!(m.warnings.iter().any(|w| w.contains("no README.md")), "{:?}", m.warnings);
    }

    #[test]
    fn azure_devops_without_origin_develop_falls_back_to_origin_main_with_a_warning() {
        let (_home, project) = project();
        let repos = Repos::new(Some(ADO), Some("plain"), false);
        let m = mainline(&project, &repos.path());
        assert_eq!(m.reference, "origin/main");
        assert!(m.warnings.iter().any(|w| w.contains("origin/develop does not exist")), "{:?}", m.warnings);
    }

    #[test]
    fn no_origin_gives_local_main() {
        let (_home, project) = project();
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        let first = commit(dir.path(), "a", "a");
        git(dir.path(), &["checkout", "-q", "-b", "feature/x"]);
        commit(dir.path(), "b", "b");
        let found = found(&project, &dir.path().to_string_lossy(), &Options { fetch: true, status: true, ..Default::default() });
        assert_eq!(found.mainline.reference, "main");
        assert_eq!(found.mainline.commit, first);
        assert!(found.mainline.warnings.is_empty());
        assert_eq!(found.facts.fetch_ok, None);
        assert_eq!(found.fetched(), "");
        assert_eq!(found.mainline.gap, Some((0, 1)));
        assert_eq!(found.facts.branch, "feature/x");
        assert_eq!(found.facts.dirty, Some(0));
    }

    #[test]
    fn a_local_main_that_contains_origin_main_and_is_ahead_wins() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        let local = commit(&repos.clone, "fork.rs", "custom");
        let m = mainline(&project, &repos.path());
        assert_eq!(m.reference, "main");
        assert_eq!(m.commit, local);
        assert!(m.warnings.is_empty());
    }

    #[test]
    fn a_local_main_behind_origin_main_gives_origin_main() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        commit(&repos.seed, "new.rs", "new");
        git(&repos.seed, &["push", "-q", "origin", "main"]);
        let m = found(&project, &repos.path(), &Options { fetch: true, ..Default::default() }).mainline;
        assert_eq!(m.reference, "origin/main");
        assert_eq!(m.commit, git(&repos.seed, &["rev-parse", "HEAD"]));
    }

    #[test]
    fn diverged_gives_origin_with_a_warning() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        commit(&repos.clone, "local.rs", "local");
        commit(&repos.seed, "remote.rs", "remote");
        git(&repos.seed, &["push", "-q", "origin", "main"]);
        let found = found(&project, &repos.path(), &Options { fetch: true, ..Default::default() });
        assert_eq!(found.facts.fetch_ok, Some(true));
        assert!(found.fetched().starts_with("fetched "), "{}", found.fetched());
        let m = found.mainline;
        assert_eq!(m.reference, "origin/main");
        assert!(m.warnings.iter().any(|w| w.contains("diverged")), "{:?}", m.warnings);
    }

    #[test]
    fn nothing_found_gives_origin_head_then_the_current_branch_with_a_warning() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        // Origin's line is `trunk`: no origin/main, no local main.
        git(&repos.seed, &["push", "-q", "origin", "main:trunk"]);
        let bare = repos.root.path().join("origin.git");
        git(&bare, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
        git(&repos.seed, &["push", "-q", "origin", "--delete", "main"]);
        git(&repos.clone, &["checkout", "-q", "-b", "work"]);
        git(&repos.clone, &["branch", "-q", "-D", "main"]);
        git(&repos.clone, &["fetch", "-q", "--prune", "origin"]);
        git(&repos.clone, &["remote", "set-head", "origin", "trunk"]);
        let m = mainline(&project, &repos.path());
        assert_eq!(m.reference, "origin/trunk");
        assert!(m.warnings.iter().any(|w| w.contains("origin/HEAD")), "{:?}", m.warnings);

        git(&repos.clone, &["remote", "set-head", "origin", "--delete"]);
        let m = mainline(&project, &repos.path());
        assert_eq!(m.reference, "work");
        assert_eq!(m.commit, git(&repos.clone, &["rev-parse", "HEAD"]));
        assert!(m.warnings.iter().any(|w| w.contains("current branch `work`")), "{:?}", m.warnings);
    }

    #[test]
    fn a_given_base_wins_and_must_be_a_commit() {
        let (_home, project) = project();
        let repos = Repos::new(Some(ADO), None, true);
        let found = found(&project, &repos.path(), &Options { base: Some("origin/main"), ..Default::default() });
        assert!(found.mainline.given);
        assert_eq!(found.mainline.reference, "origin/main");
        assert_eq!(found.facts.readme, None, "a given base reads no README");
        assert!(!cache_path(&project).exists(), "nor caches a rule");
        let at = Location { path: &repos.path(), machine: "", target: None };
        assert!(find(&project, &RealRunner, &at, &Options { base: Some("nope"), ..Default::default() }).is_err());
        assert!(find(&project, &RealRunner, &at, &Options { base: Some("--help"), ..Default::default() }).is_err());
    }

    #[test]
    fn the_rule_is_cached_until_origin_changes_or_a_refresh() {
        let (_home, project) = project();
        let repos = Repos::new(Some(ADO), Some("plain"), true);
        assert_eq!(mainline(&project, &repos.path()).reference, "origin/develop");
        let cache = std::fs::read_to_string(cache_path(&project)).unwrap();
        assert!(cache.contains("\"develop\"") && cache.contains(ADO), "{cache}");

        // The README now says trunk-: the cache still holds develop.
        commit(&repos.seed, "ReadMe.MD", "trunk-based now");
        git(&repos.seed, &["push", "-q", "origin", "main"]);
        repos.fetch();
        let runner = FakeRunner::new();
        runner.on_fn(|_| true, |cmd| RealRunner.run(cmd));
        let at = Location { path: &repos.path(), machine: "", target: None };
        let hit = find(&project, &runner, &at, &Options::default()).unwrap();
        assert_eq!(hit.mainline.reference, "origin/develop");
        assert_eq!(hit.facts.readme, None, "a cache hit reads no README");
        // Step 3's fallback is still evaluated on a hit.
        git(&repos.clone, &["update-ref", "-d", "refs/remotes/origin/develop"]);
        assert_eq!(mainline(&project, &repos.path()).reference, "origin/main");
        repos.fetch();
        assert_eq!(mainline(&project, &repos.path()).reference, "origin/develop");

        // An explicit refresh detects again.
        let refreshed = found(&project, &repos.path(), &Options { refresh: true, ..Default::default() });
        assert_eq!(refreshed.mainline.reference, "origin/main");
        assert_eq!(mainline(&project, &repos.path()).reference, "origin/main");

        // A new origin URL detects again: a GitHub origin is always main.
        git(&repos.clone, &["remote", "set-url", "origin", GITHUB]);
        assert_eq!(mainline(&project, &repos.path()).reference, "origin/main");
        let cache = std::fs::read_to_string(cache_path(&project)).unwrap();
        assert!(cache.contains(GITHUB) && !cache.contains(ADO), "{cache}");
    }

    #[test]
    fn a_failed_fetch_is_noted_and_the_mainline_still_found() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        git(&repos.clone, &["remote", "set-url", "origin", repos.root.path().join("gone.git").to_str().unwrap()]);
        let found = found(&project, &repos.path(), &Options { fetch: true, ..Default::default() });
        assert_eq!(found.facts.fetch_ok, Some(false));
        assert_eq!(found.mainline.reference, "origin/main");
        assert!(found.notes()[0].contains("fetch from origin failed"), "{:?}", found.notes());
    }

    #[test]
    fn the_script_runs_the_same_over_ssh() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, true);
        let runner = FakeRunner::new();
        runner.on_fn(
            |cmd| cmd.program == "ssh",
            |cmd| RealRunner.run(&Cmd { program: "sh".into(), args: vec!["-c".into(), cmd.args.last().unwrap().clone()], ..cmd.clone() }),
        );
        let at = Location { path: &repos.path(), machine: "box", target: Some("box") };
        let found = find(&project, &runner, &at, &Options { fetch: true, ..Default::default() }).unwrap();
        assert_eq!(found.facts.fetch_ok, Some(true));
        assert_eq!(found.mainline.reference, "origin/main");
        assert_eq!(runner.count("ssh"), 1, "one ssh call on a cache miss");
        let cache = std::fs::read_to_string(cache_path(&project)).unwrap();
        assert!(cache.contains(&format!("box:{}", repos.path())), "{cache}");
    }

    #[test]
    fn checkout_lines_show_the_gap_and_leave_the_checkout_alone() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        commit(&repos.seed, "new.rs", "new");
        git(&repos.seed, &["push", "-q", "origin", "main"]);
        git(&repos.clone, &["fetch", "-q", "origin"]);
        git(&repos.clone, &["checkout", "-q", "-b", "feature/y"]);
        commit(&repos.clone, "mine.rs", "mine");
        std::fs::write(repos.clone.join("scratch.txt"), "wip").unwrap();
        let head = git(&repos.clone, &["rev-parse", "HEAD"]);
        let status = git(&repos.clone, &["status", "--porcelain"]);

        let list = vec![project::Repo { path: repos.path(), machine: None, name: None, mainline: None }, project::Repo { path: "/remote/x".into(), machine: Some("box".into()), name: None, mainline: None }];
        let text = checkout_lines(&project, &RealRunner, &list, "").unwrap();
        let mainline = git(&repos.clone, &["rev-parse", "origin/main"]);
        assert!(text.contains(&format!("mainline `origin/main` @ {}", short(&mainline))), "{text}");
        assert!(text.contains(&format!("main checkout on `feature/y` @ {}: 1 behind, 1 ahead, with uncommitted changes", short(&head))), "{text}");
        assert!(text.contains("git show <commit>:<file>"), "{text}");
        assert!(!text.contains("/remote/x"), "remote repositories are not read: {text}");
        assert!(text.contains(&format!("@ {} (fetched ", short(&mainline))), "fetched first: {text}");
        assert_eq!(git(&repos.clone, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&repos.clone, &["status", "--porcelain"]), status);
        assert_eq!(git(&repos.clone, &["branch", "--show-current"]), "feature/y");
    }

    fn pinned_repo(path: String, pin: &str) -> project::Repo {
        project::Repo { path, machine: None, name: None, mainline: Some(pin.into()) }
    }

    #[test]
    fn an_override_beats_the_rule_and_its_cache_and_prefers_the_local_branch() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        // The rule takes the local main ahead of origin/main, and caches main.
        commit(&repos.clone, "v1.rs", "upstream v1");
        assert_eq!(mainline(&project, &repos.path()).reference, "main");
        git(&repos.clone, &["branch", "legacy", "origin/main"]);
        let legacy = commit(&repos.seed, "fork.rs", "fork");
        git(&repos.seed, &["push", "-q", "origin", "main:legacy"]);
        repos.fetch();

        let options = Options { pinned: Some("legacy"), ..Default::default() };
        let m = found(&project, &repos.path(), &options).mainline;
        assert_eq!((m.reference.as_str(), m.pinned, m.given), ("legacy", true, false), "the local branch first");
        assert_ne!(m.commit, legacy);
        git(&repos.clone, &["branch", "-q", "-D", "legacy"]);
        let m = found(&project, &repos.path(), &options).mainline;
        assert_eq!((m.reference.as_str(), m.commit.as_str()), ("origin/legacy", legacy.as_str()), "then origin/<name>");
        let m = found(&project, &repos.path(), &Options { pinned: Some("origin/legacy"), ..Default::default() }).mainline;
        assert_eq!(m.reference, "origin/legacy");
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);

        // --base still wins over the override.
        let given = found(&project, &repos.path(), &Options { pinned: Some("legacy"), base: Some("origin/main"), ..Default::default() }).mainline;
        assert!(given.given && !given.pinned);
        assert_eq!(given.reference, "origin/main");

        // The cached rule outlives the override.
        let cache = std::fs::read_to_string(cache_path(&project)).unwrap();
        assert!(cache.contains("\"main\""), "{cache}");
        assert_eq!(mainline(&project, &repos.path()).reference, "main");
    }

    #[test]
    fn a_missing_override_is_an_error_and_a_warning_in_context() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        let repo = pinned_repo(repos.path(), "nope");
        assert!(summary(&project, &repo).contains("override `nope` in PROJECT.md, not resolved yet"), "{}", summary(&project, &repo));
        let at = Location { path: &repos.path(), machine: "", target: None };
        let error = find(&project, &RealRunner, &at, &Options { pinned: Some("nope"), ..Default::default() }).err().unwrap();
        assert!(error.is::<MissingOverride>());
        assert!(error.to_string().contains("override `nope` (PROJECT.md) is neither a local branch nor a remote ref"), "{error}");
        let text = summary(&project, &repo);
        assert!(text.starts_with("override, warning: the mainline override `nope`"), "{text}");
        assert!(checkout_lines(&project, &RealRunner, &[repo], "").is_err(), "a read-only brief refuses it too");
        // The rule's result is not taken for the override, nor the other way round.
        let plain = project::Repo { mainline: None, ..pinned_repo(repos.path(), "") };
        assert!(summary(&project, &plain).starts_with("not found yet"), "{}", summary(&project, &plain));
        for bad in ["-x", "a..b", "a b", "HEAD~1"] {
            assert!(find(&project, &RealRunner, &at, &Options { pinned: Some(bad), ..Default::default() }).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_override_shows_in_context_and_in_read_only_briefs() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        git(&repos.clone, &["branch", "legacy"]);
        let repo = pinned_repo(repos.path(), "legacy");
        let text = checkout_lines(&project, &RealRunner, std::slice::from_ref(&repo), "").unwrap();
        assert!(text.contains("mainline (override) `legacy` @ "), "{text}");
        let text = summary(&project, &repo);
        assert!(text.starts_with("`legacy` @ ") && text.contains("override in PROJECT.md, as of "), "{text}");
    }

    #[test]
    fn an_override_resolves_over_ssh_on_the_other_machine() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        git(&repos.clone, &["branch", "legacy"]);
        let runner = FakeRunner::new();
        runner.on_fn(
            |cmd| cmd.program == "ssh",
            |cmd| RealRunner.run(&Cmd { program: "sh".into(), args: vec!["-c".into(), cmd.args.last().unwrap().clone()], ..cmd.clone() }),
        );
        let at = Location { path: &repos.path(), machine: "box", target: Some("box") };
        let found = find(&project, &runner, &at, &Options { pinned: Some("legacy"), ..Default::default() }).unwrap();
        assert_eq!((found.mainline.reference.as_str(), found.mainline.pinned), ("legacy", true));
        assert_eq!(runner.count("ssh"), 1);
        let error = find(&project, &runner, &at, &Options { pinned: Some("gone"), ..Default::default() }).err().unwrap();
        assert!(error.to_string().contains(" on box"), "{error}");
    }

    #[test]
    fn a_failed_fetch_before_a_read_only_brief_is_noted_and_not_fatal() {
        let (_home, project) = project();
        let repos = Repos::new(None, None, false);
        git(&repos.clone, &["remote", "set-url", "origin", repos.root.path().join("gone.git").to_str().unwrap()]);
        let list = vec![project::Repo { path: repos.path(), machine: None, name: None, mainline: None }];
        let text = checkout_lines(&project, &RealRunner, &list, "").unwrap();
        assert!(text.contains("mainline `origin/main` @ "), "{text}");
        assert!(text.contains("The fetch from origin failed: the mainline is as of the last fetch."), "{text}");
    }
}
