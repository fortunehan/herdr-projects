//! Thread and pane links: `https://hp.invalid/<slug>/<id>` names a thread
//! and `https://hp.invalid/pane/<pane-id>` a pane of the clicked session; a
//! link-modifier click on one focuses that pane.
//!
//! Herdr 0.9.3 hands a click to a plugin `[[link_handlers]]` entry only for a
//! URL, and herdr-gpui asks it only for http(s) ones (plain text or OSC 8):
//! neither reads a bare `t-0014`, a bare `w8C:p1` or a custom scheme. So a
//! coordinator writes a thread or pane as a Markdown link with this URL;
//! Claude Code shows only the id when it emits OSC 8 hyperlinks
//! (`FORCE_HYPERLINK=1` under Herdr), and the id followed by the URL
//! otherwise. `.invalid` never resolves (RFC 2606), so a client that opens
//! the URL itself reaches nothing.

use anyhow::{Context, Result, bail};

use crate::herdr::Herdr;
use crate::paths::Ctx;
use crate::project::Project;
use crate::thread::{self, Status};

const PREFIX: &str = "https://hp.invalid/";

/// What a link names.
#[derive(Debug, PartialEq)]
pub enum Link {
    /// A thread; no slug in the short form `https://hp.invalid/<id>`, which
    /// means the clicked pane's project.
    Thread { slug: Option<String>, id: String },
    /// A Herdr pane id of the session the link is clicked in.
    Pane(String),
}

/// The link for thread `id` of project `slug`.
pub fn url(slug: &str, id: &str) -> String {
    format!("{PREFIX}{slug}/{id}")
}

/// The link for pane `pane` (`w8C:p1`).
pub fn pane_url(pane: &str) -> String {
    format!("{PREFIX}pane/{pane}")
}

/// A Herdr public pane id: `w<workspace>:p<number>`. The `:` keeps it apart
/// from thread ids, so `/pane/t-0001` stays a thread of a project `pane`.
pub fn is_pane_id(id: &str) -> bool {
    let Some((workspace, number)) = id.split_once(":p") else { return false };
    workspace.strip_prefix('w').is_some_and(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_alphanumeric()))
        && !number.is_empty()
        && number.bytes().all(|b| b.is_ascii_digit())
}

/// What `url` links to, or `None` for any other URL.
pub fn parse(url: &str) -> Option<Link> {
    let path = url.strip_prefix(PREFIX).or_else(|| url.strip_prefix("http://hp.invalid/"))?;
    let path = path.split(['?', '#']).next()?.trim_end_matches('/');
    let is_id = |s: &str| thread::validate_id(s).is_ok();
    let is_slug = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let thread = |slug: Option<&str>, id: &str| Some(Link::Thread { slug: slug.map(str::to_string), id: id.to_string() });
    match path.split('/').collect::<Vec<_>>()[..] {
        ["pane", pane] if !is_id(pane) => {
            let pane = pane.replace("%3A", ":").replace("%3a", ":");
            is_pane_id(&pane).then_some(Link::Pane(pane))
        }
        [id] if is_id(id) => thread(None, id),
        [slug, id] if is_slug(slug) && is_id(id) => thread(Some(slug), id),
        _ => None,
    }
}

/// Focuses the pane of thread `id`, on its own session and machine (as the
/// popup's jump does). A remote thread's pane is focused in that machine's
/// Herdr, which this one does not show.
pub fn focus(ctx: &Ctx, slug: &str, id: &str) -> Result<String> {
    let project = Project::load(&ctx.root, slug)?;
    let record = thread::load(&project, id)?;
    if record.status == Status::Resolved {
        bail!("{id} is resolved; its report is {}", record.report_path());
    }
    if record.pane_id.is_empty() {
        bail!("{id} has no pane; `thread restart {slug} {id}` brings it back");
    }
    let view = crate::threads::session_view(ctx, &project).with_context(|| format!("the herdr session of `{slug}` is not reachable"))?;
    view.herdr.on_machine(&record.machine).agent_focus(&record.pane_id).map_err(|error| anyhow::anyhow!("{error}"))?;
    Ok(if record.is_remote() { format!("focused {id} (pane {} on {})", record.pane_id, record.machine) } else { format!("focused {id} (pane {})", record.pane_id) })
}

/// Focuses pane `pane` of `herdr`'s session with its tab and workspace.
/// Herdr 0.9.3 focuses a single pane only through `agent focus`, which takes
/// agent panes alone; any other pane gets its tab focused.
pub fn focus_pane(herdr: &Herdr, pane: &str) -> Result<String> {
    if !is_pane_id(pane) {
        bail!("`{pane}` is not a pane id (expected the form w1:p1)");
    }
    if herdr.agent_focus(pane).is_ok() {
        return Ok(format!("focused pane {pane}"));
    }
    let panes = herdr.pane_list().map_err(|error| anyhow::anyhow!("{error}"))?;
    let found = panes.iter().find(|p| p.pane_id == pane).with_context(|| format!("pane {pane} is not open in this herdr session"))?;
    herdr.tab_focus(&found.tab_id).map_err(|error| anyhow::anyhow!("{error}"))?;
    Ok(format!("focused tab {} of pane {pane}", found.tab_id))
}

/// The `focus-thread` action a thread or pane link's click runs. Herdr shows
/// nothing of an action's output, so a failure becomes a notification.
pub fn run_action(ctx: &Ctx) -> Result<()> {
    let socket = ctx.env.var("HERDR_SOCKET_PATH");
    let result = clicked(ctx).and_then(|link| match link {
        Clicked::Thread(slug, id) => focus(ctx, &slug, &id),
        Clicked::Pane(pane) => {
            let socket = socket.context("Herdr passed no session socket")?;
            focus_pane(&Herdr::new(ctx.env.herdr_bin(), socket, ctx.runner), &pane)
        }
    });
    if let Err(error) = &result
        && let Some(socket) = socket
    {
        let _ = Herdr::new(ctx.env.herdr_bin(), socket, ctx.runner).notification_show("Projects: link", &format!("{error:#}"));
    }
    result.map(|line| println!("{line}"))
}

enum Clicked {
    Thread(String, String),
    Pane(String),
}

fn clicked(ctx: &Ctx) -> Result<Clicked> {
    let clicked = ctx.env.var("HERDR_PLUGIN_CLICKED_URL").context("Herdr passed no clicked URL")?;
    let link = parse(clicked).with_context(|| format!("{clicked} is not a thread link ({PREFIX}<slug>/t-NNNN) or pane link ({PREFIX}pane/w1:p1)"))?;
    let (slug, id) = match link {
        Link::Pane(pane) => return Ok(Clicked::Pane(pane)),
        Link::Thread { slug, id } => (slug, id),
    };
    match slug.or_else(|| crate::actions::current_slug(ctx)) {
        Some(slug) => Ok(Clicked::Thread(slug, id)),
        None => bail!("{id}: the clicked pane does not belong to a project; link it as {}", url("<slug>", &id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Env;
    use crate::runner::fake::ok;
    use crate::scenarios::World;

    #[test]
    fn parse_reads_the_long_and_short_forms_and_nothing_else() {
        let thread = |slug: Option<&str>, id: &str| Some(Link::Thread { slug: slug.map(str::to_string), id: id.to_string() });
        assert_eq!(parse(&url("projects-plugin", "t-0014")), thread(Some("projects-plugin"), "t-0014"));
        assert_eq!(parse("https://hp.invalid/t-0014"), thread(None, "t-0014"));
        assert_eq!(parse("http://hp.invalid/demo/t-10234/"), thread(Some("demo"), "t-10234"));
        assert_eq!(parse("https://hp.invalid/demo/t-0014#x"), thread(Some("demo"), "t-0014"));
        for other in ["https://hp.invalid/", "https://hp.invalid/demo", "https://hp.invalid/demo/t-", "https://hp.invalid/demo/t-12", "https://hp.invalid/Demo/t-1", "https://hp.invalid/a/b/t-1", "https://example.com/demo/t-0014", "hp.invalid/demo/t-1"] {
            assert_eq!(parse(other), None, "{other}");
        }
    }

    #[test]
    fn parse_reads_pane_links_and_rejects_malformed_pane_ids() {
        let pane = |id: &str| Some(Link::Pane(id.to_string()));
        assert_eq!(parse(&pane_url("w8C:p1")), pane("w8C:p1"));
        assert_eq!(parse("http://hp.invalid/pane/w1X:p24/"), pane("w1X:p24"));
        assert_eq!(parse("https://hp.invalid/pane/w15%3Ap7?x#y"), pane("w15:p7"));
        // A project may be called `pane`: its threads still parse as threads.
        assert_eq!(parse("https://hp.invalid/pane/t-0001"), Some(Link::Thread { slug: Some("pane".into()), id: "t-0001".into() }));
        for other in ["https://hp.invalid/pane/", "https://hp.invalid/pane", "https://hp.invalid/pane/w8C", "https://hp.invalid/pane/w8C:p", "https://hp.invalid/pane/w:p1", "https://hp.invalid/pane/8C:p1", "https://hp.invalid/pane/w8C:t1", "https://hp.invalid/pane/w8C:p1x", "https://hp.invalid/pane/w8-C:p1", "https://hp.invalid/pane/w8C:p1/w9:p1", "https://hp.invalid/demo/w8C:p1", "https://hp.invalid/w8C:p1", "https://example.com/pane/w8C:p1"] {
            assert_eq!(parse(other), None, "{other}");
        }
    }

    /// Herdr matches the manifest's pattern against the whole clicked URL: it
    /// claims this host only, anchored, so no other URL is taken from the browser.
    #[test]
    fn the_manifest_routes_thread_links_to_the_focus_thread_action() {
        let manifest: toml::Table = toml::from_str(include_str!("../herdr-plugin.toml")).unwrap();
        let handler = manifest["link_handlers"].as_array().unwrap().iter().find(|h| h["id"].as_str() == Some("thread")).unwrap();
        assert_eq!(handler["pattern"].as_str(), Some("^https?://hp\\.invalid/"));
        assert_eq!(handler["action"].as_str(), Some("focus-thread"));
        let actions = manifest["actions"].as_array().unwrap();
        assert!(actions.iter().any(|a| a["id"].as_str() == Some("focus-thread")));
    }

    fn click_env(world: &World, url: &str, workspace: &str) -> Env {
        click_env_on(world, url, workspace, "a.sock")
    }

    fn click_env_on(world: &World, url: &str, workspace: &str, socket: &str) -> Env {
        let socket = world.home.path().join(socket);
        Env::for_test(world.home.path(), &[("HERDR_PLUGIN_CLICKED_URL", url), ("HERDR_SOCKET_PATH", socket.to_str().unwrap()), ("HERDR_WORKSPACE_ID", workspace)])
    }

    #[test]
    fn a_click_focuses_the_threads_pane_on_the_projects_session() {
        let world = World::new();
        let project = world.project("demo", "a.sock");
        let cwd = world.home.path().join("wt");
        let t = world.thread(&project, &cwd, |_| {});
        world.runner.on("agent focus", ok(r#"{"result":{}}"#));
        // Clicked in another session's pane: the focus still goes to the project's.
        let env = click_env_on(&world, &url("demo", &t.id), "w9", "b.sock");
        let ctx = Ctx { env: &env, ..world.ctx() };
        run_action(&ctx).unwrap();
        let calls = world.runner.calls.borrow();
        let focus = calls.iter().find(|c| c.display().contains("agent focus")).unwrap();
        assert!(focus.display().contains("agent focus w2:p1"), "{}", focus.display());
        let socket = focus.env.iter().find(|(k, _)| k == "HERDR_SOCKET_PATH").map(|(_, v)| v.as_str()).unwrap_or_default();
        assert!(socket.ends_with("a.sock"), "{socket}");
        assert_eq!(world.runner.count("notification show"), 0);
    }

    #[test]
    fn the_short_form_takes_the_project_of_the_clicked_panes_workspace() {
        let world = World::new();
        let project = world.project("demo", "a.sock");
        let t = world.thread(&project, &world.home.path().join("wt"), |_| {});
        world.runner.on("agent focus", ok(r#"{"result":{}}"#));
        let env = click_env(&world, &format!("https://hp.invalid/{}", t.id), "w1");
        let ctx = Ctx { env: &env, ..world.ctx() };
        run_action(&ctx).unwrap();
        assert_eq!(world.runner.count("agent focus w2:p1"), 1);

        let elsewhere = click_env(&world, &format!("https://hp.invalid/{}", t.id), "w7");
        let ctx = Ctx { env: &elsewhere, ..world.ctx() };
        assert!(run_action(&ctx).is_err());
        assert_eq!(world.runner.count("notification show"), 1);
    }

    #[test]
    fn a_resolved_or_unknown_thread_is_a_notification_not_a_focus() {
        let world = World::new();
        let project = world.project("demo", "a.sock");
        let t = world.thread(&project, &world.home.path().join("wt"), |t| t.status = Status::Resolved);
        for link in [url("demo", &t.id), url("demo", "t-9999"), url("nope", "t-0001")] {
            let env = click_env(&world, &link, "w1");
            let ctx = Ctx { env: &env, ..world.ctx() };
            assert!(run_action(&ctx).is_err(), "{link}");
        }
        assert_eq!(world.runner.count("agent focus"), 0);
        assert_eq!(world.runner.count("notification show"), 3);
    }

    #[test]
    fn a_pane_link_focuses_that_pane_on_the_clicked_session() {
        let world = World::new();
        world.runner.on("agent focus", ok(r#"{"result":{}}"#));
        let env = click_env_on(&world, &pane_url("w8C:p1"), "w9", "b.sock");
        let ctx = Ctx { env: &env, ..world.ctx() };
        run_action(&ctx).unwrap();
        let calls = world.runner.calls.borrow();
        let focus = calls.iter().find(|c| c.display().contains("agent focus")).unwrap();
        assert!(focus.display().contains("agent focus w8C:p1"), "{}", focus.display());
        let socket = focus.env.iter().find(|(k, _)| k == "HERDR_SOCKET_PATH").map(|(_, v)| v.as_str()).unwrap_or_default();
        assert!(socket.ends_with("b.sock"), "{socket}");
        assert_eq!(world.runner.count("tab focus"), 0);
        assert_eq!(world.runner.count("notification show"), 0);
    }

    #[test]
    fn a_pane_without_an_agent_gets_its_tab_focused() {
        let world = World::new();
        world.runner.on("agent focus", crate::runner::fake::fail(1, "agent not found"));
        *world.panes.borrow_mut() = format!("[{}]", crate::scenarios::pane_json("w3", "w3:t2", "w3:p2", "/tmp"));
        world.runner.on("tab focus", ok(r#"{"result":{}}"#));
        let env = click_env(&world, &pane_url("w3:p2"), "w1");
        let ctx = Ctx { env: &env, ..world.ctx() };
        run_action(&ctx).unwrap();
        assert_eq!(world.runner.count("tab focus w3:t2"), 1);

        let gone = click_env(&world, &pane_url("w3:p9"), "w1");
        let ctx = Ctx { env: &gone, ..world.ctx() };
        assert!(run_action(&ctx).is_err());
        assert_eq!(world.runner.count("tab focus"), 1);
        assert_eq!(world.runner.count("notification show"), 1);
    }

    #[test]
    fn focus_pane_refuses_a_malformed_pane_id_without_calling_herdr() {
        let world = World::new();
        let herdr = Herdr::new("herdr", world.home.path().join("a.sock"), &world.runner);
        assert!(focus_pane(&herdr, "w8C").is_err());
        assert!(world.runner.calls.borrow().is_empty());
    }
}
