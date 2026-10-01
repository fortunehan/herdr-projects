//! The agents list's two views of this plugin: `projects`, upstream's project
//! blocks (`sidebar::default_view`), and `priority`, the attention order of
//! ADR 0003 in the design folder.
//!
//! Herdr holds one view per session, cannot report which, and keeps a
//! plugin view's header label unclickable (0.9.3), so the choice is switched
//! with `view` (bound to [`KEY`], the `toggle-view` action, the popup's `v`)
//! and kept in `<root>/.sidebar-view`, to be set again at startup and on
//! `unfocus`. `focus <slug>` replaces either view until `unfocus`.
//!
//! `priority` sorts on `hp_needs` and `hp_tier`, which the ticker writes here
//! on every agent pane of a session it lays out, outside agents included,
//! next to `grouping`'s tokens. A local fork addition: upstream files only
//! call into this module.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use toml_edit::{Array, ArrayOfTables, DocumentMut, InlineTable, Item, Table, Value};

use crate::coordinator::LivePane;
use crate::grouping::Tokens;
use crate::herdr::{Agent, Herdr};
use crate::paths::{Ctx, SessionFlags};
use crate::project::{self, Project};
use crate::thread::{self, Group};

/// The plugin action that toggles the view, and the key `configure` binds to
/// it when free (`prefix+v` is Herdr's `split_vertical`).
pub const ACTION: &str = "herdr-projects.toggle-view";
pub const KEY: &str = "prefix+shift+v";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Projects,
    Priority,
}

impl View {
    pub fn parse(text: &str) -> Result<View> {
        match text.trim() {
            "projects" => Ok(View::Projects),
            "priority" => Ok(View::Priority),
            other => bail!("`{other}` is not a view (projects or priority)"),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            View::Projects => "projects",
            View::Priority => "priority",
        }
    }

    pub fn other(self) -> View {
        match self {
            View::Projects => View::Priority,
            View::Priority => View::Projects,
        }
    }

    pub fn spec(self) -> serde_json::Value {
        match self {
            View::Projects => crate::sidebar::default_view(),
            View::Priority => priority_view(),
        }
    }
}

/// The attention order (ADR 0003): project agents that need the user first
/// (`hp_needs`), then Herdr's attention; at the same attention implementation
/// threads (`hp_tier` 1) after every other agent; then the latest state
/// change. Herdr sorts a missing token last in both directions.
pub fn priority_view() -> serde_json::Value {
    serde_json::json!({
        "source": crate::herdr::SOURCE,
        "label": "priority",
        "sort": [
            { "field": { "token": "hp_needs" }, "order": "desc" },
            { "field": "attention", "order": "desc" },
            { "field": { "token": "hp_tier" }, "order": "asc" },
            { "field": "state_change_seq", "order": "desc" },
        ],
    })
}

fn choice_path(root: &Path) -> PathBuf {
    root.join(".sidebar-view")
}

/// The view last chosen with `view`; `projects` when none was.
pub fn chosen(root: &Path) -> View {
    std::fs::read_to_string(choice_path(root)).ok().and_then(|text| View::parse(&text).ok()).unwrap_or(View::Projects)
}

/// `view projects|priority|toggle`: sets the view in the session and keeps
/// the choice. `toggle` goes from the chosen view, so it also leaves a focus.
pub fn set(ctx: &Ctx, session: &SessionFlags, which: &str) -> Result<View> {
    let view = match which.trim() {
        "toggle" => chosen(&ctx.root).other(),
        other => View::parse(other)?,
    };
    let session = crate::paths::resolve_session(session, ctx.env, ctx.runner)?;
    let herdr = Herdr::new(ctx.env.herdr_bin(), &session.socket, ctx.runner);
    herdr.agent_view_set(view.spec()).map_err(|e| anyhow::anyhow!("{e}"))?;
    project::write_atomic(&choice_path(&ctx.root), format!("{}\n", view.name()).as_bytes())?;
    Ok(view)
}

pub fn cli(ctx: &Ctx, session: &SessionFlags, which: &str) -> Result<()> {
    let view = set(ctx, session, which)?;
    println!("sidebar agents view: {} ({} toggles it)", view.name(), KEY);
    Ok(())
}

/// The popup's `v`: the line it shows.
pub fn popup_toggle(ctx: &Ctx) -> String {
    match set(ctx, &SessionFlags::default(), "toggle") {
        Ok(view) => format!("agents view: {}", view.name()),
        Err(error) => format!("could not switch the view: {error:#}"),
    }
}

// ---------------------------------------------------------------- tokens

/// What the priority view knows of one project agent.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rank {
    /// In the needs-you group (never while the project is paused).
    pub needs: bool,
    /// An implementation thread: after every other agent at the same attention.
    pub implementation: bool,
}

/// One session's project agents, by pane.
pub type Ranks = HashMap<String, Rank>;

/// A project's agents as the ticker saw them: its coordinators (the live
/// ones, then the recorded pane) and its open local threads.
pub fn project_ranks(ctx: &Ctx, project: &Project, record: &project::Coordinator, coordinators: &[LivePane], agents: &[Agent], paused: bool) -> Vec<(String, Rank)> {
    let mut out = Vec::new();
    for c in coordinators {
        let terminal = agents.iter().find(|a| a.pane_id == c.pane_id).map(|a| a.terminal_id.clone()).unwrap_or_default();
        let report = crate::progress::self_report(&ctx.root, &record.socket, &c.pane_id, &terminal);
        let needs = !paused && crate::coordinator::row_state(c, report.as_ref()).0 == Group::WaitingOnYou;
        out.push((c.pane_id.clone(), Rank { needs, implementation: false }));
    }
    if !record.pane_id.is_empty() && !out.iter().any(|(pane, _)| pane == &record.pane_id) {
        out.push((record.pane_id.clone(), Rank::default()));
    }
    for t in thread::list(project).into_iter().filter(|t| !t.is_remote() && matches!(t.status, thread::Status::Open | thread::Status::Starting) && !t.pane_id.is_empty()) {
        let needs = !paused && Group::from_token(&t.last_group) == Some(Group::WaitingOnYou);
        out.push((t.pane_id.clone(), Rank { needs, implementation: t.kind != thread::Kind::Design }));
    }
    out
}

/// A pane's tokens: every agent gets a tier (`0` unless an implementation
/// thread); `hp_needs` is cleared, not set to 0, when it does not apply.
pub fn tokens(rank: Option<&Rank>) -> Tokens {
    let rank = rank.copied().unwrap_or_default();
    vec![
        ("hp_tier".to_string(), Some(if rank.implementation { "1" } else { "0" }.to_string())),
        ("hp_needs".to_string(), rank.needs.then(|| "1".to_string())),
    ]
}

/// Tokens sent per `(socket, pane)`, so an unchanged pane is re-sent only to
/// keep its TTL alive.
type Sent = HashMap<(String, String), (Tokens, Instant)>;

static SENT: Mutex<Option<Sent>> = Mutex::new(None);

const RESEND: Duration = Duration::from_millis(crate::sidebar::TOKEN_TTL_MS / 3);

fn due(socket: &str, pane: &str, tokens: &Tokens) -> bool {
    let mut sent = SENT.lock().unwrap_or_else(|e| e.into_inner());
    let sent = sent.get_or_insert_with(HashMap::new);
    let key = (socket.to_string(), pane.to_string());
    match sent.get(&key) {
        Some((last, at)) if last == tokens && at.elapsed() < RESEND => false,
        _ => {
            sent.insert(key, (tokens.clone(), Instant::now()));
            true
        }
    }
}

/// Writes the priority tokens on every agent pane of one session.
pub fn apply(herdr: &Herdr, socket: &str, ranks: Option<&Ranks>, agents: &[Agent]) {
    for agent in agents {
        let tokens = tokens(ranks.and_then(|r| r.get(&agent.pane_id)));
        if due(socket, &agent.pane_id, &tokens) {
            crate::grouping::report(herdr, "pane", &agent.pane_id, &tokens);
        }
    }
}

// ---------------------------------------------------------------- config.toml

/// Colours of the sub-line's group word, as the fork's sidebar had them
/// before the port: needs-you bold red, review yellow, both undimmed; the
/// rest of the sub-line stays dim.
const STATE_COLOURS: [(&str, &str, bool); 2] = [("needs you", "#f38ba8", true), ("review", "#f9e2af", false)];

/// `row` (upstream's `$hp_sub` row) with Herdr rules that colour a sub-line
/// starting with a group word. The first matching rule wins, and its `dim`
/// overrides the cell's.
pub fn with_state_colours(row: Value) -> Value {
    let Value::Array(mut cells) = row else {
        return row;
    };
    for cell in cells.iter_mut() {
        let Value::InlineTable(cell) = cell else {
            continue;
        };
        if cell.get("token").and_then(Value::as_str) != Some("$hp_sub") {
            continue;
        }
        let mut rules = Array::new();
        for (word, colour, bold) in STATE_COLOURS {
            let mut rule = InlineTable::new();
            rule.insert("starts_with", word.into());
            rule.insert("fg", colour.into());
            if bold {
                rule.insert("bold", true.into());
            }
            rule.insert("dim", false.into());
            rules.push(rule);
        }
        cell.insert("rules", rules.into());
    }
    Value::Array(cells)
}

/// Adds (or with `remove` drops) the `[[keys.command]]` entry binding [`KEY`]
/// to [`ACTION`]. An existing entry keeps the user's key; a taken key adds
/// nothing and says so.
pub fn key_edit(text: &str, builtin: &[(String, String)], remove: bool) -> Result<(String, Option<String>)> {
    let mut doc = text.parse::<DocumentMut>().context("config.toml does not parse")?;
    let ours = |t: &Table| t.get("command").and_then(Item::as_str) == Some(ACTION);
    let existing = doc.get("keys").and_then(|k| k.get("command")).and_then(Item::as_array_of_tables).is_some_and(|c| c.iter().any(ours));
    if remove {
        if let Some(commands) = doc.get_mut("keys").and_then(|k| k.get_mut("command")).and_then(Item::as_array_of_tables_mut) {
            commands.retain(|t| !ours(t));
        }
        return Ok((doc.to_string(), None));
    }
    if existing {
        return Ok((text.to_string(), None));
    }
    if let Some(conflict) = crate::sidebar::key_conflict(text, KEY, builtin) {
        return Ok((text.to_string(), Some(format!("{conflict}, so no key toggles the agents view; bind `{ACTION}` yourself or run `herdr-projects view toggle`"))));
    }
    if doc.get("keys").is_none() {
        let mut keys = Table::new();
        keys.set_implicit(true);
        doc.insert("keys", Item::Table(keys));
    }
    let keys = doc["keys"].as_table_like_mut().context("`keys` must be a table")?;
    if keys.get("command").is_none() {
        keys.insert("command", Item::ArrayOfTables(ArrayOfTables::new()));
    }
    let commands = keys.get_mut("command").and_then(Item::as_array_of_tables_mut).context("`keys.command` must be an array of tables")?;
    let mut entry = Table::new();
    entry["key"] = toml_edit::value(KEY);
    entry["type"] = toml_edit::value("plugin_action");
    entry["command"] = toml_edit::value(ACTION);
    entry["description"] = toml_edit::value("Projects: switch the agents view (projects / priority)");
    commands.push(entry);
    Ok((doc.to_string(), None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grouping::{PaneRow, Parts, coordinator_key, thread_key};

    /// An agent as Herdr's agent view sort sees it.
    struct Row {
        name: &'static str,
        tokens: std::collections::BTreeMap<String, String>,
        attention: u64,
        seq: u64,
    }

    /// Herdr's view sort: a filter keeps rows whose token equals its value;
    /// then stable, keys in order, missing values after present ones whatever
    /// the direction, tokens compared as strings.
    fn herdr_sort(view: &serde_json::Value, rows: Vec<Row>) -> Vec<&'static str> {
        use std::cmp::Ordering;
        let mut rows: Vec<Row> = match view.get("filter") {
            Some(filter) => rows.into_iter().filter(|r| r.tokens.get(filter["field"]["token"].as_str().unwrap()).map(String::as_str) == filter["value"].as_str()).collect(),
            None => rows,
        };
        let sort = view["sort"].as_array().unwrap().clone();
        rows.sort_by(|a, b| {
            for key in &sort {
                let desc = key["order"] == "desc";
                let value = |r: &Row| -> Option<String> {
                    match &key["field"] {
                        serde_json::Value::String(f) if f == "attention" => Some(format!("{:020}", r.attention)),
                        serde_json::Value::String(f) if f == "state_change_seq" => Some(format!("{:020}", r.seq)),
                        field => r.tokens.get(field["token"].as_str().unwrap()).cloned(),
                    }
                };
                let ordering = match (value(a), value(b)) {
                    (Some(x), Some(y)) if desc => y.cmp(&x),
                    (Some(x), Some(y)) => x.cmp(&y),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => Ordering::Equal,
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            Ordering::Equal
        });
        rows.iter().map(|r| r.name).collect()
    }

    // Herdr's `tab_attention_priority`.
    const BLOCKED: u64 = 4;
    const DONE: u64 = 3;
    const WORKING: u64 = 2;
    const IDLE: u64 = 1;

    /// One agent of a scene: `slug` is empty for an outside agent; `kind` is
    /// `c` (coordinator), `t` (implementation thread) or `d` (design thread).
    struct Seen {
        name: &'static str,
        slug: &'static str,
        kind: char,
        group: Group,
        attention: u64,
        seq: u64,
    }

    fn seen(name: &'static str, slug: &'static str, kind: char, group: Group, attention: u64, seq: u64) -> Seen {
        Seen { name, slug, kind, group, attention, seq }
    }

    fn outside(name: &'static str, attention: u64, seq: u64) -> Seen {
        seen(name, "", 'o', Group::Idle, attention, seq)
    }

    /// The rows Herdr sorts, with every token the ticker writes: `grouping`'s
    /// (`hp_group`), this module's (`hp_tier`, `hp_needs`) on every pane in
    /// Herdr's list order, and `report_pane`'s `hp_project` and `hp_rank` on
    /// project agents. A paused project's agents never need the user.
    fn scene(agents: &[Seen], paused: &[&str]) -> Vec<Row> {
        let mut parts = Parts::new();
        let mut ranks = Ranks::new();
        for a in agents.iter().filter(|a| !a.slug.is_empty()) {
            let key = match a.kind {
                'c' => coordinator_key(a.slug, a.name),
                _ => thread_key(a.slug, a.group.rank(), a.name),
            };
            parts.entry(a.slug.to_string()).or_default().panes.push(PaneRow { pane: a.name.into(), key, sub: String::new() });
            ranks.insert(a.name.into(), Rank { needs: a.group == Group::WaitingOnYou && !paused.contains(&a.slug), implementation: a.kind == 't' });
        }
        let list: Vec<Agent> = agents.iter().map(|a| Agent { pane_id: a.name.into(), ..Default::default() }).collect();
        let layout = crate::grouping::plan(&parts, &list, &[]);
        agents
            .iter()
            .map(|a| {
                let grouping = &layout.agents.iter().find(|(p, _)| p == a.name).unwrap().1;
                let mut tokens: std::collections::BTreeMap<String, String> = grouping.iter().chain(tokens(ranks.get(a.name)).iter()).filter_map(|(n, v)| Some((n.clone(), v.clone()?))).collect();
                if !a.slug.is_empty() {
                    tokens.insert("hp_project".into(), a.slug.into());
                    tokens.insert("hp_rank".into(), a.group.rank().to_string());
                }
                Row { name: a.name, tokens, attention: a.attention, seq: a.seq }
            })
            .collect()
    }

    fn priority(agents: &[Seen]) -> Vec<&'static str> {
        herdr_sort(&priority_view(), scene(agents, &[]))
    }

    #[test]
    fn the_priority_view_is_the_attention_order_and_projects_is_upstreams() {
        assert_eq!(
            priority_view()["sort"],
            serde_json::json!([
                {"field":{"token":"hp_needs"},"order":"desc"},
                {"field":"attention","order":"desc"},
                {"field":{"token":"hp_tier"},"order":"asc"},
                {"field":"state_change_seq","order":"desc"},
            ])
        );
        assert_eq!((priority_view()["label"].as_str(), priority_view().get("filter")), (Some("priority"), None));
        assert_eq!(View::Projects.spec(), crate::sidebar::default_view());
        assert_eq!((View::Projects.other(), View::Priority.other()), (View::Priority, View::Projects));
    }

    #[test]
    fn implementation_threads_yield_only_within_their_attention_level() {
        let agents = [
            outside("outside-idle", IDLE, 90),
            seen("thread-working", "demo", 't', Group::Working, WORKING, 80),
            outside("outside-working", WORKING, 10),
            seen("thread-blocked", "demo", 't', Group::Working, BLOCKED, 5),
            seen("thread-done", "demo", 't', Group::ReadyForReview, DONE, 4),
        ];
        assert_eq!(priority(&agents), ["thread-blocked", "thread-done", "outside-working", "thread-working", "outside-idle"]);
    }

    #[test]
    fn coordinators_and_design_threads_are_not_demoted() {
        let agents = [
            seen("thread", "demo", 't', Group::Working, WORKING, 99),
            seen("design", "demo", 'd', Group::Working, WORKING, 20),
            outside("outside", WORKING, 30),
            seen("coordinator", "demo", 'c', Group::Working, WORKING, 10),
        ];
        assert_eq!(priority(&agents), ["outside", "design", "coordinator", "thread"]);
    }

    #[test]
    fn needs_you_rows_lead_and_idle_review_threads_sit_with_idle_agents() {
        let agents = [
            outside("outside-blocked", BLOCKED, 50),
            // Self-reported waiting while Herdr shows idle, and a failed thread.
            seen("coordinator-waiting", "demo", 'c', Group::WaitingOnYou, IDLE, 1),
            seen("thread-failed", "other", 't', Group::WaitingOnYou, IDLE, 2),
            seen("thread-review", "demo", 't', Group::ReadyForReview, IDLE, 70),
            outside("outside-idle", IDLE, 3),
            outside("outside-working", WORKING, 4),
        ];
        assert_eq!(priority(&agents), ["coordinator-waiting", "thread-failed", "outside-blocked", "outside-working", "outside-idle", "thread-review"]);
    }

    #[test]
    fn a_paused_projects_threads_stay_demoted_but_never_need_you() {
        let agents = [
            outside("outside", WORKING, 1),
            seen("paused-thread", "zzz", 't', Group::WaitingOnYou, WORKING, 9),
            seen("paused-coordinator", "zzz", 'c', Group::WaitingOnYou, WORKING, 8),
        ];
        assert_eq!(herdr_sort(&priority_view(), scene(&agents, &["zzz"])), ["paused-coordinator", "outside", "paused-thread"]);
    }

    fn mixed() -> Vec<Seen> {
        vec![
            outside("outside", BLOCKED, 99),
            seen("t-0003", "demo", 't', Group::Working, BLOCKED, 50),
            seen("t-0001", "demo", 't', Group::Idle, IDLE, 1),
            seen("other-coordinator", "other", 'c', Group::WaitingOnYou, IDLE, 70),
            seen("t-0004", "demo", 'd', Group::WaitingOnYou, IDLE, 2),
            seen("coordinator", "demo", 'c', Group::Working, WORKING, 3),
            seen("t-0002", "demo", 't', Group::ReadyForReview, IDLE, 4),
            seen("t-0005", "demo", 't', Group::Working, WORKING, 60),
        ]
    }

    #[test]
    fn the_projects_view_keeps_upstreams_blocks_and_outside_agents_last() {
        assert_eq!(
            herdr_sort(&View::Projects.spec(), scene(&mixed(), &[])),
            ["coordinator", "t-0004", "t-0002", "t-0003", "t-0005", "t-0001", "other-coordinator", "outside"]
        );
    }

    #[test]
    fn the_focus_view_lists_one_projects_block_coordinators_first_then_threads_by_need() {
        assert_eq!(herdr_sort(&crate::sidebar::project_view("demo"), scene(&mixed(), &[])), ["coordinator", "t-0004", "t-0002", "t-0003", "t-0005", "t-0001"]);
    }

    #[test]
    fn every_pane_gets_a_tier_and_hp_needs_is_cleared_when_it_does_not_apply() {
        assert_eq!(tokens(None), vec![("hp_tier".to_string(), Some("0".to_string())), ("hp_needs".to_string(), None)]);
        let blocked = Rank { needs: true, implementation: true };
        assert_eq!(tokens(Some(&blocked)), vec![("hp_tier".to_string(), Some("1".to_string())), ("hp_needs".to_string(), Some("1".to_string()))]);
    }

    #[test]
    fn the_choice_defaults_to_projects_and_survives_bad_text() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(chosen(dir.path()), View::Projects);
        std::fs::write(dir.path().join(".sidebar-view"), "priority\n").unwrap();
        assert_eq!(chosen(dir.path()), View::Priority);
        std::fs::write(dir.path().join(".sidebar-view"), "nonsense").unwrap();
        assert_eq!(chosen(dir.path()), View::Projects);
    }

    #[test]
    fn the_toggle_key_is_added_once_kept_when_rebound_skipped_when_taken_and_removed() {
        let builtin = vec![("split_vertical".to_string(), "prefix+v".to_string())];
        let (added, note) = key_edit("# mine\n[ui]\nsidebar_width = 30\n", &builtin, false).unwrap();
        assert!(note.is_none());
        assert_eq!(added.matches(ACTION).count(), 1);
        assert!(added.contains(KEY) && added.contains("plugin_action") && added.starts_with("# mine"), "{added}");
        assert_eq!(key_edit(&added, &builtin, false).unwrap().0, added);
        let rebound = added.replace(KEY, "alt+v");
        assert_eq!(key_edit(&rebound, &builtin, false).unwrap().0, rebound, "the user's own key stays");
        let taken = "[[keys.command]]\nkey = \"prefix+shift+v\"\ntype = \"shell\"\ncommand = \"mine\"\n";
        let (kept, note) = key_edit(taken, &builtin, false).unwrap();
        assert_eq!(kept, taken);
        assert!(note.unwrap().contains("bind `herdr-projects.toggle-view` yourself"));
        let (removed, _) = key_edit(&added, &builtin, true).unwrap();
        assert!(!removed.contains(ACTION) && removed.contains("# mine"));
        // With the popup key in the same list.
        let both = crate::sidebar::config_edit(&added, &crate::sidebar::Spec { key: "prefix+a".into(), tab_command: "/bin/hp needs-you --line".into() }, false).unwrap();
        assert!(both.contains(ACTION) && both.contains(crate::sidebar::POPUP_ACTION));
    }

    #[test]
    fn the_sub_line_colours_needs_you_and_review_and_configure_keeps_it_in_place() {
        let spec = crate::sidebar::Spec { key: "prefix+a".into(), tab_command: "/bin/hp needs-you --line".into() };
        let added = crate::sidebar::config_edit("", &spec, false).unwrap();
        let doc = added.parse::<DocumentMut>().unwrap();
        let rows = doc["ui"]["sidebar"]["agents"]["rows"].as_array().unwrap();
        let sub = rows.get(1).unwrap().as_array().unwrap().get(0).unwrap().as_inline_table().unwrap();
        assert_eq!((sub.get("token").and_then(Value::as_str), sub.get("dim").and_then(Value::as_bool)), (Some("$hp_sub"), Some(true)));
        let rules = sub.get("rules").unwrap().as_array().unwrap();
        let rule = |i: usize, key: &str| rules.get(i).unwrap().as_inline_table().unwrap().get(key).cloned();
        assert_eq!(rule(0, "starts_with").unwrap().as_str(), Some("needs you"));
        assert_eq!((rule(0, "fg").unwrap().as_str(), rule(0, "bold").unwrap().as_bool(), rule(0, "dim").unwrap().as_bool()), (Some("#f38ba8"), Some(true), Some(false)));
        assert_eq!((rule(1, "starts_with").unwrap().as_str(), rule(1, "fg").unwrap().as_str(), rule(1, "bold").is_none()), (Some("review"), Some("#f9e2af"), true));
        // Idempotent, and a plain sub row of an earlier configure is replaced, not doubled.
        assert_eq!(crate::sidebar::config_edit(&added, &spec, false).unwrap(), added);
        let plain = "[ui.sidebar.agents]\nrows = [[\"state_icon\", \"agent\"], [{ token = \"$hp_sub\", dim = true }]]\n";
        let upgraded = crate::sidebar::config_edit(plain, &spec, false).unwrap();
        assert_eq!(upgraded.matches("$hp_sub").count(), 1, "{upgraded}");
        assert!(upgraded.contains("#f38ba8") && upgraded.contains("#f9e2af"), "{upgraded}");
        // Unconfigure still takes it out.
        assert!(!crate::sidebar::config_edit(&added, &spec, true).unwrap().contains("$hp_sub"));
    }
}
