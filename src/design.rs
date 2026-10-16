//! The project's design folder: where design threads work,
//! and where the glossary, the context map and the decision records live.
//! The binary keeps `repos/` in step with `repos` in PROJECT.md and writes the
//! starting files once; everything else in it is written by design threads.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::project::{Project, Settings};

const AGENTS_MD: &str = include_str!("../skill/design/AGENTS.md");
const ISSUE_TRACKER_MD: &str = include_str!("../skill/design/issue-tracker.md");
const DOMAIN_MD: &str = include_str!("../skill/design/domain.md");

/// Creates the design folder when missing, links every local repository under
/// `repos/<short name>`, drops links for repositories no longer listed, and
/// writes the starting files that do not exist yet. Never overwrites a file.
pub fn prepare(project: &Project, settings: &Settings) -> Result<PathBuf> {
    let dir = project.design_dir();
    let links = dir.join("repos");
    std::fs::create_dir_all(&links).with_context(|| format!("could not create {}", links.display()))?;

    let wanted = wanted_links(settings)?;
    for (name, target) in &wanted {
        link(&links.join(name), target)?;
    }
    for entry in std::fs::read_dir(&links)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !wanted.contains_key(&name) && is_symlink(&entry.path()) {
            std::fs::remove_file(entry.path()).with_context(|| format!("could not remove {}", entry.path().display()))?;
        }
    }

    write_missing(&dir.join("AGENTS.md"), AGENTS_MD)?;
    let claude = dir.join("CLAUDE.md");
    if std::fs::symlink_metadata(&claude).is_err() {
        std::os::unix::fs::symlink("AGENTS.md", &claude).with_context(|| format!("could not link {}", claude.display()))?;
    }
    std::fs::create_dir_all(dir.join("docs/agents"))?;
    write_missing(&dir.join("docs/agents/issue-tracker.md"), ISSUE_TRACKER_MD)?;
    write_missing(&dir.join("docs/agents/domain.md"), DOMAIN_MD)?;
    Ok(dir)
}

/// Short name to main checkout, for the local repositories. A repository on
/// another machine has no checkout here and gets no link.
fn wanted_links(settings: &Settings) -> Result<BTreeMap<String, String>> {
    let mut wanted = BTreeMap::new();
    for repo in settings.repos.iter().filter(|r| r.machine.is_none()) {
        let name = repo.short_name();
        validate_name(&name).with_context(|| format!("repository {}", repo.path))?;
        if let Some(other) = wanted.insert(name.clone(), repo.path.clone()) {
            bail!("{other} and {} are both named `{name}` in the design folder; give one of them a `name` in its [[repos]] entry in PROJECT.md", repo.path);
        }
    }
    Ok(wanted)
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') {
        bail!("`{name}` cannot name a folder in the design folder; set `name` in its [[repos]] entry in PROJECT.md");
    }
    Ok(())
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Points `path` at `target`, replacing a link that points elsewhere. Anything
/// at `path` that is not a link is someone's file and is left alone.
fn link(path: &Path, target: &str) -> Result<()> {
    match std::fs::read_link(path) {
        Ok(current) if current == Path::new(target) => return Ok(()),
        Ok(_) => std::fs::remove_file(path).with_context(|| format!("could not replace {}", path.display()))?,
        Err(_) if std::fs::symlink_metadata(path).is_ok() => bail!("{} is not a link; move it away so the repository can be linked there", path.display()),
        Err(_) => {}
    }
    std::os::unix::fs::symlink(target, path).with_context(|| format!("could not link {} to {target}", path.display()))
}

fn write_missing(path: &Path, text: &str) -> Result<()> {
    if std::fs::symlink_metadata(path).is_ok() {
        return Ok(());
    }
    crate::project::write_atomic(path, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::Repo;
    use crate::scenarios::World;

    fn repo(path: &Path, name: Option<&str>) -> Repo {
        Repo { path: path.to_string_lossy().into_owned(), machine: None, name: name.map(str::to_string), mainline: None }
    }

    #[test]
    fn prepare_links_local_repos_by_short_name_and_writes_the_starting_files_once() {
        let world = World::new();
        let project = world.project("demo", "a.sock");
        let app = world.home.path().join("code/app-ios");
        let api = world.home.path().join("code/api");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(&api).unwrap();
        let far = Repo { path: "/srv/far".into(), machine: Some("box".into()), name: None, mainline: None };
        let settings = Settings { repos: vec![repo(&app, Some("ios")), repo(&api, None), far], ..Settings::default() };

        let dir = prepare(&project, &settings).unwrap();
        assert_eq!(std::fs::read_link(dir.join("repos/ios")).unwrap(), app);
        assert_eq!(std::fs::read_link(dir.join("repos/api")).unwrap(), api);
        assert!(!dir.join("repos/far").exists(), "a remote repository has no checkout to link");
        assert_eq!(std::fs::read_link(dir.join("CLAUDE.md")).unwrap(), Path::new("AGENTS.md"));
        assert!(dir.join("docs/agents/issue-tracker.md").is_file() && dir.join("docs/agents/domain.md").is_file());

        std::fs::write(dir.join("AGENTS.md"), "mine").unwrap();
        let settings = Settings { repos: vec![repo(&app, Some("ios"))], ..Settings::default() };
        prepare(&project, &settings).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("AGENTS.md")).unwrap(), "mine", "never overwritten");
        assert!(std::fs::symlink_metadata(dir.join("repos/api")).is_err(), "an unlisted repository's link is dropped");
    }

    #[test]
    fn two_repos_with_one_short_name_are_refused() {
        let world = World::new();
        let project = world.project("demo", "a.sock");
        let settings = Settings { repos: vec![repo(Path::new("/a/app"), None), repo(Path::new("/b/app"), None)], ..Settings::default() };
        let error = prepare(&project, &settings).unwrap_err().to_string();
        assert!(error.contains("both named `app`"), "{error}");
    }

    #[test]
    fn a_file_where_a_link_belongs_is_left_alone() {
        let world = World::new();
        let project = world.project("demo", "a.sock");
        std::fs::create_dir_all(project.design_dir().join("repos")).unwrap();
        std::fs::write(project.design_dir().join("repos/app"), "notes").unwrap();
        let settings = Settings { repos: vec![repo(Path::new("/a/app"), None)], ..Settings::default() };
        assert!(prepare(&project, &settings).unwrap_err().to_string().contains("is not a link"));
        assert_eq!(std::fs::read_to_string(project.design_dir().join("repos/app")).unwrap(), "notes");
    }
}
