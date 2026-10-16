//! The proxies Azure DevOps and `gh` requests go through.
//!
//! Each comes from its environment variable, else from a top-level key in
//! `~/.config/herdr-projects/config.toml`. The key is what a ticker started by
//! the Herdr server relies on: herdr-gpui starts the server with the login
//! shell's environment minus every `HERDR_*` variable
//! (`crates/herdr-gpui/src/login_env.rs`, `allowed`), so the plugin's
//! `[[startup]]` and every action never see `HERDR_PROJECTS_*_PROXY`.

use std::path::Path;

use crate::paths::Env;
use crate::ticker::Info;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Ado,
    Gh,
}

pub const KINDS: [Kind; 2] = [Kind::Ado, Kind::Gh];

impl Kind {
    pub fn var(self) -> &'static str {
        match self {
            Kind::Ado => crate::pr::ado::PROXY_VAR,
            Kind::Gh => crate::pr::github::PROXY_VAR,
        }
    }

    /// The `config.toml` key.
    pub fn key(self) -> &'static str {
        match self {
            Kind::Ado => "ado_proxy",
            Kind::Gh => "gh_proxy",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Kind::Ado => "Azure DevOps",
            Kind::Gh => "GitHub",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Proxy {
    pub url: String,
    /// The variable's name, or `<key> in <config.toml path>`.
    pub source: String,
}

impl Proxy {
    /// The URL without `user:password@`, and where it came from.
    pub fn describe(&self) -> String {
        format!("{} ({})", redact(&self.url), self.source)
    }
}

/// The variable when set and not empty, else the `config.toml` key.
pub fn resolve(env: &Env, kind: Kind) -> Option<Proxy> {
    match env.var(kind.var()) {
        Some(url) => Some(Proxy { url: url.to_string(), source: kind.var().to_string() }),
        None => from_config(&env.config_dir(), kind),
    }
}

/// The `config.toml` key alone. A file that is missing or does not parse, or
/// a value that is not a non-empty string, gives none.
pub fn from_config(config_dir: &Path, kind: Kind) -> Option<Proxy> {
    let file = config_dir.join("config.toml");
    let table: toml::Table = std::fs::read_to_string(&file).ok()?.parse().ok()?;
    let url = table.get(kind.key())?.as_str()?.trim();
    (!url.is_empty()).then(|| Proxy { url: url.to_string(), source: format!("{} in {}", kind.key(), file.display()) })
}

/// The proxy variables set in this process's environment, by name, for the
/// ticker's lock file.
pub fn vars_set(env: &Env) -> Vec<String> {
    KINDS.iter().map(|k| k.var()).filter(|var| env.var(var).is_some()).map(str::to_string).collect()
}

/// A proxy URL without its `user:password@`.
pub fn redact(url: &str) -> String {
    let shown = match url.rsplit_once('@') {
        Some((before, host)) => match before.split_once("://") {
            Some((scheme, _)) => format!("{scheme}://{host}"),
            None => host.to_string(),
        },
        None => url.to_string(),
    };
    crate::pr::sanitize(&shown)
}

/// One warning per kind in `needed` that the running ticker has no proxy for:
/// its environment had no variable when it started and `env`'s `config.toml`
/// has no key now (the ticker reads the key on every pass). Nothing for a
/// ticker that predates recording its variables, whose environment is unknown.
pub fn ticker_gaps(info: &Info, env: &Env, needed: &[Kind]) -> Vec<String> {
    let config_dir = env.config_dir();
    let Some(vars) = &info.proxy_vars else {
        return Vec::new();
    };
    needed
        .iter()
        .filter(|kind| !vars.iter().any(|v| v == kind.var()) && from_config(&config_dir, **kind).is_none())
        .map(|kind| {
            format!(
                "the ticker (pid {}) has no {} proxy: it started without {} and {} sets no `{}`, so its requests use the inherited proxy variables. Add `{} = \"http://127.0.0.1:<port>\"` there; the ticker reads it on its next pass",
                info.pid,
                kind.label(),
                kind.var(),
                config_dir.join("config.toml").display(),
                kind.key(),
                kind.key()
            )
        })
        .collect()
}

/// The kinds `forges` need.
pub fn needed<'a>(forges: impl IntoIterator<Item = &'a crate::pr::Forge>) -> Vec<Kind> {
    let mut kinds = Vec::new();
    for forge in forges {
        let kind = match forge {
            crate::pr::Forge::AzureDevOps(_) => Kind::Ado,
            crate::pr::Forge::GitHub(_) => Kind::Gh,
        };
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    kinds
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADO_ORIGIN: &str = "git@ssh.dev.azure.com:v3/org/proj/repo";
    const GH_ORIGIN: &str = "https://github.com/owner/repo.git";

    fn config(text: &str) -> (tempfile::TempDir, Env) {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_test(home.path(), &[]);
        std::fs::create_dir_all(env.config_dir()).unwrap();
        std::fs::write(env.config_dir().join("config.toml"), text).unwrap();
        (home, env)
    }

    #[test]
    fn the_variable_wins_over_config_toml_and_config_toml_fills_in() {
        let (home, env) = config("ado_proxy = \"http://127.0.0.1:7890\"\ngh_proxy = \" http://127.0.0.1:10060 \"\n");
        let file = env.config_dir().join("config.toml");
        assert_eq!(
            resolve(&env, Kind::Ado),
            Some(Proxy { url: "http://127.0.0.1:7890".into(), source: format!("ado_proxy in {}", file.display()) })
        );
        assert_eq!(resolve(&env, Kind::Gh).unwrap().url, "http://127.0.0.1:10060");

        let env = Env::for_test(home.path(), &[(Kind::Ado.var(), "http://127.0.0.1:1"), (Kind::Gh.var(), "")]);
        assert_eq!(resolve(&env, Kind::Ado), Some(Proxy { url: "http://127.0.0.1:1".into(), source: "HERDR_PROJECTS_ADO_PROXY".into() }));
        assert_eq!(resolve(&env, Kind::Gh).unwrap().source, format!("gh_proxy in {}", file.display()), "an empty variable counts as unset");
    }

    #[test]
    fn a_missing_empty_or_broken_config_gives_no_proxy() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(resolve(&Env::for_test(home.path(), &[]), Kind::Ado), None);
        for text in ["ado_proxy = \"\"\n", "ado_proxy = 7890\n", "ado_proxy = [\n", "[ado]\nado_proxy = \"http://x\"\n"] {
            let (_home, env) = config(text);
            assert_eq!(resolve(&env, Kind::Ado), None, "{text}");
        }
    }

    #[test]
    fn a_proxy_is_shown_without_its_password() {
        let proxy = Proxy { url: "http://me:pw@127.0.0.1:7890".into(), source: "HERDR_PROJECTS_ADO_PROXY".into() };
        assert_eq!(proxy.describe(), "http://127.0.0.1:7890 (HERDR_PROJECTS_ADO_PROXY)");
        assert_eq!(redact("127.0.0.1:7890"), "127.0.0.1:7890");
    }

    #[test]
    fn needed_kinds_follow_the_forges() {
        let forges = |origins: &[&str]| origins.iter().filter_map(|o| crate::pr::Forge::of(o)).collect::<Vec<_>>();
        assert_eq!(needed(&forges(&[ADO_ORIGIN, "/local/path", ADO_ORIGIN])), vec![Kind::Ado]);
        assert_eq!(needed(&forges(&[GH_ORIGIN, ADO_ORIGIN])), vec![Kind::Gh, Kind::Ado]);
        assert!(needed(&forges(&["/local/path"])).is_empty());
    }

    #[test]
    fn a_ticker_gap_is_a_needed_proxy_in_neither_its_environment_nor_config_toml() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_test(home.path(), &[]);
        let config_dir = env.config_dir();
        let gaps_of = |info: &Info, needed: &[Kind]| ticker_gaps(info, &env, needed);
        let info = |vars: Option<&[&str]>| Info { pid: 9969, proxy_vars: vars.map(|v| v.iter().map(|s| s.to_string()).collect()), ..Info::default() };

        let gaps = gaps_of(&info(Some(&[])), &[Kind::Ado, Kind::Gh]);
        assert_eq!(gaps.len(), 2, "{gaps:?}");
        assert!(gaps[0].starts_with("the ticker (pid 9969) has no Azure DevOps proxy: it started without HERDR_PROJECTS_ADO_PROXY and "), "{}", gaps[0]);
        assert!(gaps[0].contains("Add `ado_proxy = \"http://127.0.0.1:<port>\"` there"), "{}", gaps[0]);
        assert!(gaps[1].contains("no GitHub proxy"), "{}", gaps[1]);

        assert_eq!(gaps_of(&info(Some(&["HERDR_PROJECTS_ADO_PROXY"])), &[Kind::Ado]), Vec::<String>::new());
        assert!(gaps_of(&info(Some(&[])), &[]).is_empty(), "nothing needed, nothing missing");
        assert!(gaps_of(&info(None), &[Kind::Ado]).is_empty(), "an older ticker's environment is unknown");

        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("config.toml"), "ado_proxy = \"http://127.0.0.1:7890\"\n").unwrap();
        let gaps = gaps_of(&info(Some(&[])), &[Kind::Ado, Kind::Gh]);
        assert_eq!(gaps.len(), 1);
        assert!(gaps[0].contains("no GitHub proxy"), "{}", gaps[0]);
    }
}
