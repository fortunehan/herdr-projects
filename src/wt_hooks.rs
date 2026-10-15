//! worktrunk's blocking create hooks (`wt hook pre-start`) in a new thread
//! worktree, before its brief is written and its agent starts (ADR 0009).
//! `herdr worktree create` fires no wt hooks itself.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::remote::{self, quote};
use crate::runner::{Cmd, Output, Runner};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);

/// Every hook script carries it; the scripted fake runner matches on it.
pub const MARK: &str = "# herdr-projects: wt hook pre-start";

/// What the last `wt hook pre-start` in a thread worktree came to, kept in
/// the thread record.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Setup {
    /// Never run: not a worktree thread, or made before ADR 0009.
    #[default]
    None,
    /// Started and not finished: the command was cut off.
    Running,
    /// `worktree_hooks = "off"`, or no `wt` on the thread's machine.
    Skipped,
    Done,
    /// The user hooks ran; the repository's project hooks are not approved.
    Unapproved,
    Failed,
    #[serde(rename = "timeout")]
    TimedOut,
}

impl Setup {
    /// `thread restart` runs the hooks again only when the last run did not
    /// finish them: never after one that succeeded.
    pub fn needs_retry(self) -> bool {
        matches!(self, Setup::Running | Setup::Failed | Setup::TimedOut)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub timeout: Duration,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: true, timeout: DEFAULT_TIMEOUT }
    }
}

/// `worktree_hooks = "wt" | "off"` (default `"wt"`) and
/// `worktree_hooks_timeout` in seconds (default 600), top-level keys of
/// `<config_dir>/config.toml`.
pub fn settings(config_dir: &Path) -> Result<Settings> {
    let file = config_dir.join("config.toml");
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(Settings::default());
    };
    let table: toml::Table = toml::from_str(&text).with_context(|| format!("{} does not parse", file.display()))?;
    let enabled = match table.get("worktree_hooks") {
        None => true,
        Some(toml::Value::String(mode)) if mode == "wt" => true,
        Some(toml::Value::String(mode)) if mode == "off" => false,
        Some(other) => bail!("{}: worktree_hooks is {other}; use \"wt\" or \"off\"", file.display()),
    };
    let timeout = match table.get("worktree_hooks_timeout") {
        None => DEFAULT_TIMEOUT,
        Some(toml::Value::Integer(secs)) if *secs > 0 => Duration::from_secs(*secs as u64),
        Some(other) => bail!("{}: worktree_hooks_timeout is {other}, not a number of seconds above 0", file.display()),
    };
    Ok(Settings { enabled, timeout })
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Missing,
    Done,
    Unapproved,
    Failed(String),
    TimedOut,
}

impl Outcome {
    pub fn setup(&self) -> Setup {
        match self {
            Outcome::Missing => Setup::Skipped,
            Outcome::Done => Setup::Done,
            Outcome::Unapproved => Setup::Unapproved,
            Outcome::Failed(_) => Setup::Failed,
            Outcome::TimedOut => Setup::TimedOut,
        }
    }
}

/// The `sh` script for one worktree. Output goes to `<thread_dir>/setup.log`;
/// the last stdout line is `hp-setup:<result>`.
///
/// - stdin is closed and `--yes` is never passed. With no TTY wt 0.78.0 does
///   not skip unapproved project hooks: it refuses the whole run ("Cannot
///   prompt for approval") before any hook starts, user hooks included. The
///   script then runs the user hooks alone (`user:`), so project hooks
///   (`.config/wt.toml`, repository content) run only once the user approved
///   them.
/// - `wt step copy-ignored` copies the main checkout's ignored
///   `.herdr-project/`, other threads' folders with it. `--config-set` does
///   not reach the nested `wt` a hook runs, and wt's environment overrides
///   cannot set a list, so whatever lands in `.herdr-project/` beside this
///   thread's own folder is removed afterwards, whether or not the user's
///   config excludes it.
pub fn script(worktree: &str, thread_dir: &str, remote: bool) -> String {
    let path = if remote { format!("{}\n", remote::HP_PATH) } else { String::new() };
    format!(
        "{MARK}\n\
         {path}command -v wt >/dev/null 2>&1 || {{ echo hp-setup:missing; exit 0; }}\n\
         d={d}; td={td}\n\
         hp=$(dirname \"$td\"); own=$(basename \"$td\")\n\
         mkdir -p \"$td\" || exit 1\n\
         log=\"$td/setup.log\"; code=0; only_user=\n\
         {{\n\
           echo \"\\$ wt -C $d hook pre-start\"\n\
           wt -C \"$d\" hook pre-start </dev/null; code=$?\n\
           if [ \"$code\" != 0 ] && grep -q 'Cannot prompt for approval' \"$log\"; then\n\
             only_user=1\n\
             echo 'herdr-projects: project hooks are not approved, so they are skipped; running the user hooks only'\n\
             echo \"\\$ wt -C $d hook pre-start user:\"\n\
             wt -C \"$d\" hook pre-start user: </dev/null; code=$?\n\
             if [ \"$code\" != 0 ] && grep -q 'No user pre-start hooks' \"$log\"; then code=0; fi\n\
           fi\n\
           stale=$(find \"$hp\" -mindepth 1 -maxdepth 1 ! -name \"$own\" 2>/dev/null)\n\
           if [ -n \"$stale\" ]; then\n\
             echo 'herdr-projects: removed copies of other threads'\"'\"' folders from .herdr-project/:'\n\
             printf '%s\\n' \"$stale\"\n\
             find \"$hp\" -mindepth 1 -maxdepth 1 ! -name \"$own\" -exec rm -rf {{}} +\n\
           fi\n\
           echo \"exit $code\"\n\
         }} >\"$log\" 2>&1\n\
         if [ \"$code\" != 0 ]; then echo \"hp-setup:failed $code\"; elif [ -n \"$only_user\" ]; then echo hp-setup:unapproved; else echo hp-setup:done; fi\n",
        d = quote(worktree),
        td = quote(thread_dir),
    )
}

fn parse(out: &Output) -> Outcome {
    if out.timed_out {
        return Outcome::TimedOut;
    }
    let result = out.stdout.lines().rev().find_map(|line| line.trim().strip_prefix("hp-setup:"));
    match result {
        Some("missing") => Outcome::Missing,
        Some("done") => Outcome::Done,
        Some("unapproved") => Outcome::Unapproved,
        Some(failed) if failed.starts_with("failed") => Outcome::Failed(format!("exit {}", failed.trim_start_matches("failed").trim())),
        _ => {
            let error = out.error_text();
            let code = out.code.map(|c| format!("exit {c}")).unwrap_or_else(|| "killed".into());
            Outcome::Failed(if error.is_empty() { code } else { format!("{code}: {error}") })
        }
    }
}

/// Runs the hooks in `worktree`, on this machine or over ssh (`target`), and
/// on a timeout adds a line saying so to the log.
pub fn run(runner: &dyn Runner, target: Option<&str>, worktree: &str, thread_dir: &str, timeout: Duration) -> Outcome {
    let script = script(worktree, thread_dir, target.is_some());
    let out = match target {
        None => runner.run(&Cmd::new("sh", timeout).args(["-c", &script]).own_group()),
        Some(target) => remote::ssh(runner, target, &script, None, timeout),
    };
    let outcome = match out {
        Ok(out) => parse(&out),
        Err(error) => Outcome::Failed(format!("{error:#}")),
    };
    if outcome == Outcome::TimedOut {
        let line = format!("herdr-projects: timed out after {} s; the hooks were stopped", timeout.as_secs());
        let log = format!("{thread_dir}/setup.log");
        match target {
            None => {
                use std::io::Write;
                let _ = std::fs::OpenOptions::new().append(true).create(true).open(&log).and_then(|mut f| writeln!(f, "{line}"));
            }
            Some(target) => {
                let _ = remote::ssh(runner, target, &format!("printf '%s\\n' {} >> {}", quote(&line), quote(&log)), None, remote::SSH_TIMEOUT);
            }
        }
    }
    outcome
}

/// The brief's line about the hooks, "" when there is nothing to say.
pub fn brief_line(setup: Setup, thread_dir: &str) -> String {
    let what = match setup {
        Setup::None | Setup::Running | Setup::Skipped | Setup::Done => return String::new(),
        Setup::Unapproved => "only the user's `wt` pre-start hooks ran; this repository's project hooks (`.config/wt.toml`) are not approved and were skipped",
        Setup::Failed => "`wt hook pre-start` failed in this worktree",
        Setup::TimedOut => "`wt hook pre-start` was stopped at its time limit",
    };
    format!("- Setup: {what}. Log: `{thread_dir}/setup.log`. Read it before you start; say in your report what was not set up.\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::RealRunner;

    #[test]
    fn settings_default_to_wt_and_ten_minutes() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(settings(dir.path()).unwrap(), Settings::default());
        std::fs::write(dir.path().join("config.toml"), "worktree_hooks = \"off\"\nworktree_hooks_timeout = 30\n").unwrap();
        assert_eq!(settings(dir.path()).unwrap(), Settings { enabled: false, timeout: Duration::from_secs(30) });
        std::fs::write(dir.path().join("config.toml"), "worktree_hooks = \"wt\"\n").unwrap();
        assert_eq!(settings(dir.path()).unwrap(), Settings::default());
        std::fs::write(dir.path().join("config.toml"), "worktree_hooks = true\n").unwrap();
        assert!(settings(dir.path()).is_err());
        std::fs::write(dir.path().join("config.toml"), "worktree_hooks_timeout = 0\n").unwrap();
        assert!(settings(dir.path()).is_err());
    }

    #[test]
    fn only_runs_that_did_not_finish_are_retried() {
        assert!([Setup::Running, Setup::Failed, Setup::TimedOut].iter().all(|s| s.needs_retry()));
        assert!([Setup::None, Setup::Skipped, Setup::Done, Setup::Unapproved].iter().all(|s| !s.needs_retry()));
    }

    #[test]
    fn the_last_marker_line_decides() {
        let out = |stdout: &str, code: i32| Output { code: Some(code), stdout: stdout.into(), ..Output::default() };
        assert_eq!(parse(&out("hp-setup:missing\n", 0)), Outcome::Missing);
        assert_eq!(parse(&out("hp-setup:done\n", 0)), Outcome::Done);
        assert_eq!(parse(&out("hp-setup:unapproved\n", 0)), Outcome::Unapproved);
        assert_eq!(parse(&out("hp-setup:failed 3\n", 0)), Outcome::Failed("exit 3".into()));
        assert_eq!(parse(&Output { code: Some(255), stderr: "ssh: connect refused".into(), ..Output::default() }), Outcome::Failed("exit 255: ssh: connect refused".into()));
        assert_eq!(parse(&Output { timed_out: true, ..Output::default() }), Outcome::TimedOut);
    }

    /// A fake `wt` on PATH that behaves as wt 0.78.0 does with no TTY.
    fn fake_wt(bin: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let wt = bin.join("wt");
        std::fs::write(&wt, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&wt, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn run_with_path(bin: &Path, worktree: &Path, timeout: Duration) -> (Outcome, String) {
        let td = worktree.join(".herdr-project/demo-t-0001");
        let script = script(&worktree.to_string_lossy(), &td.to_string_lossy(), false);
        let path = format!("{}:/usr/bin:/bin", bin.display());
        let out = RealRunner.run(&Cmd::new("sh", timeout).args(["-c", &script]).env("PATH", path).own_group()).unwrap();
        (parse(&out), std::fs::read_to_string(td.join("setup.log")).unwrap_or_default())
    }

    #[test]
    fn the_script_runs_user_hooks_alone_when_project_hooks_are_not_approved() {
        let dir = tempfile::tempdir().unwrap();
        let (bin, wt) = (dir.path().join("bin"), dir.path().join("wt"));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(wt.join(".herdr-project/demo-t-0022/library")).unwrap();
        // `user:` succeeds; the full run refuses as wt does without a TTY.
        fake_wt(
            &bin,
            "case \"$*\" in *user:*) echo user-ran; exit 0;; esac\n\
             echo '✗ Cannot prompt for approval in non-interactive environment' >&2; exit 1",
        );
        let (outcome, log) = run_with_path(&bin, &wt, Duration::from_secs(10));
        assert_eq!(outcome, Outcome::Unapproved);
        assert!(log.contains("user-ran") && log.contains("exit 0"), "{log}");
        // Another thread's folder copied from the main checkout is gone; this one's stays.
        assert!(!wt.join(".herdr-project/demo-t-0022").exists());
        assert!(wt.join(".herdr-project/demo-t-0001/setup.log").exists());
    }

    #[test]
    fn the_script_reports_missing_wt_success_and_failure() {
        let dir = tempfile::tempdir().unwrap();
        let (bin, wt) = (dir.path().join("bin"), dir.path().join("wt"));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        assert_eq!(run_with_path(&bin, &wt, Duration::from_secs(10)).0, Outcome::Missing);
        fake_wt(&bin, "test -t 0 && exit 9; echo copied; exit 0");
        let (outcome, log) = run_with_path(&bin, &wt, Duration::from_secs(10));
        assert_eq!(outcome, Outcome::Done, "stdin must not be a terminal: {log}");
        assert!(log.contains("hook pre-start") && log.contains("copied"), "{log}");
        fake_wt(&bin, "echo boom; exit 3");
        let (outcome, log) = run_with_path(&bin, &wt, Duration::from_secs(10));
        assert_eq!(outcome, Outcome::Failed("exit 3".into()));
        assert!(log.contains("boom") && log.contains("exit 3"), "{log}");
    }

    #[test]
    fn a_slow_hook_is_stopped_and_the_log_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let (bin, wt) = (dir.path().join("bin"), dir.path().join("wt"));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        fake_wt(&bin, "echo started; sleep 30");
        // `run` uses the process PATH; put the fake first for this call only.
        let td = wt.join(".herdr-project/demo-t-0001");
        let script = script(&wt.to_string_lossy(), &td.to_string_lossy(), false);
        let out = RealRunner
            .run(&Cmd::new("sh", Duration::from_millis(1500)).args(["-c", &script]).env("PATH", format!("{}:/usr/bin:/bin", bin.display())).own_group())
            .unwrap();
        assert_eq!(parse(&out), Outcome::TimedOut);
        let log = std::fs::read_to_string(td.join("setup.log")).unwrap();
        assert!(log.contains("started"), "{log}");
    }

    #[test]
    fn values_are_quoted_and_remote_scripts_extend_path() {
        let s = script("/w t/it's", "/w t/it's/.herdr-project/demo-t-0001", true);
        assert!(s.starts_with(MARK));
        assert!(s.contains(remote::HP_PATH));
        assert!(s.contains(r"d='/w t/it'\''s'"), "{s}");
        assert!(!script("/w", "/w/.herdr-project/x", false).contains(remote::HP_PATH));
        assert!(!s.contains("--yes") && !s.contains("post-start"));
    }
}
