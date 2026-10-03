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

/// The attention order (ADR 0003): coordinators and design threads that need
/// the user first (`hp_needs`), then every other agent before implementation
/// threads (`hp_tier` 1), each tier by Herdr's attention, then the latest
/// state change. Herdr sorts a missing token last in both directions.
pub fn priority_view() -> serde_json::Value {
    serde_json::json!({
        "source": crate::herdr::SOURCE,
        "label": "priority",
        "sort": [
            { "field": { "token": "hp_needs" }, "order": "desc" },
            { "field": { "token": "hp_tier" }, "order": "asc" },
            { "field": "attention", "order": "desc" },
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
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Rank {
    /// In the needs-you group (never while the project is paused).
    pub needs: bool,
    /// An implementation thread: after every other agent, never `hp_needs`.
    pub implementation: bool,
    /// A design thread's own Space, whose label keeps [`DESIGN_MARK`]; none
    /// for a design thread started as a tab of the home Space.
    pub design_space: Option<String>,
}

/// One session's project agents, by pane.
pub type Ranks = HashMap<String, Rank>;

/// A project's agents as the ticker saw them: its coordinators (the live
/// ones, then the recorded pane) and its open local threads.
pub fn project_ranks(ctx: &Ctx, project: &Project, record: &project::Coordinator, coordinators: &[LivePane], agents: &[Agent], paused: bool) -> Vec<(String, Rank)> {
    let mut out = Vec::new();
    let threads: Vec<thread::Thread> = thread::list(project).into_iter().filter(|t| !t.is_remote() && matches!(t.status, thread::Status::Open | thread::Status::Starting)).collect();
    let thread_needs = threads.iter().any(|t| Group::from_token(&t.last_group) == Some(Group::WaitingOnYou));
    for c in coordinators {
        let terminal = agents.iter().find(|a| a.pane_id == c.pane_id).map(|a| a.terminal_id.clone()).unwrap_or_default();
        let report = crate::progress::self_report(&ctx.root, &record.socket, &c.pane_id, &terminal);
        let needs = !paused && (thread_needs || crate::coordinator::row_state(c, report.as_ref()).0 == Group::WaitingOnYou);
        out.push((c.pane_id.clone(), Rank { needs, ..Rank::default() }));
    }
    if !record.pane_id.is_empty() && !out.iter().any(|(pane, _)| pane == &record.pane_id) {
        out.push((record.pane_id.clone(), Rank::default()));
    }
    for t in threads.into_iter().filter(|t| !t.pane_id.is_empty()) {
        let needs = !paused && Group::from_token(&t.last_group) == Some(Group::WaitingOnYou);
        let design = t.kind == thread::Kind::Design;
        let design_space = (design && !t.workspace_id.is_empty() && t.workspace_id != record.workspace_id).then(|| t.workspace_id.clone());
        out.push((t.pane_id.clone(), Rank { needs, implementation: !design, design_space }));
    }
    out
}

/// A pane's tokens: every agent gets a tier (`0` unless an implementation
/// thread); `hp_needs` is cleared, not set to 0, when it does not apply. An
/// implementation thread never gets it: its coordinator, which then needs
/// the user too, is where the user resolves it.
pub fn tokens(rank: Option<&Rank>) -> Tokens {
    let rank = rank.cloned().unwrap_or_default();
    vec![
        ("hp_tier".to_string(), Some(if rank.implementation { "1" } else { "0" }.to_string())),
        ("hp_needs".to_string(), (rank.needs && !rank.implementation).then(|| "1".to_string())),
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

/// Writes the priority tokens on every agent pane of one session, and puts
/// [`DESIGN_MARK`] back on a design Space label that lost it.
pub fn apply(herdr: &Herdr, socket: &str, ranks: Option<&Ranks>, agents: &[Agent]) {
    for agent in agents {
        let tokens = tokens(ranks.and_then(|r| r.get(&agent.pane_id)));
        if due(socket, &agent.pane_id, &tokens) {
            crate::grouping::report(herdr, "pane", &agent.pane_id, &tokens);
        }
    }
    mark_design_spaces(herdr, socket, ranks, agents);
}

// ---------------------------------------------------------------- design threads

/// Starts a design thread's display name and its own Space's label, so the
/// agent and Space cells' `contains` rule colours them (see [`config_edit`]).
/// Zero-width and apart from `grouping::HEAD_MARK` (U+200B) and
/// `grouping::HOME_MARK` (U+2800). At the start, because Herdr keeps only
/// the first 80 characters of a display name.
pub const DESIGN_MARK: char = '\u{2060}';

/// A thread's row name: a design thread's starts with [`DESIGN_MARK`].
pub fn thread_display(thread: &thread::Thread) -> String {
    let display = crate::sidebar::thread_display(thread);
    if thread.kind == thread::Kind::Design { design_label(&display) } else { display }
}

/// `label` with [`DESIGN_MARK`] in front, once.
pub fn design_label(label: &str) -> String {
    if label.contains(DESIGN_MARK) { label.to_string() } else { format!("{DESIGN_MARK}{label}") }
}

/// Design Spaces checked per `(socket, Space)`, so the labels are listed
/// again only every [`RESEND`].
static CHECKED: Mutex<Option<HashMap<(String, String), Instant>>> = Mutex::new(None);

fn check_due(socket: &str, space: &str) -> bool {
    let mut checked = CHECKED.lock().unwrap_or_else(|e| e.into_inner());
    let checked = checked.get_or_insert_with(HashMap::new);
    let key = (socket.to_string(), space.to_string());
    match checked.get(&key) {
        Some(at) if at.elapsed() < RESEND => false,
        _ => {
            checked.insert(key, Instant::now());
            true
        }
    }
}

/// Like upstream's `grouping::unmarked_homes` for home Spaces: a design
/// thread's own Space, while its pane is still there (ids repeat after a
/// server restart), keeps [`DESIGN_MARK`] when renamed by hand.
fn mark_design_spaces(herdr: &Herdr, socket: &str, ranks: Option<&Ranks>, agents: &[Agent]) {
    let Some(ranks) = ranks else {
        return;
    };
    let mut spaces: Vec<&str> = agents.iter().filter_map(|a| ranks.get(&a.pane_id)?.design_space.as_deref().filter(|s| *s == a.workspace_id)).collect();
    spaces.dedup();
    spaces.retain(|s| check_due(socket, s));
    if spaces.is_empty() {
        return;
    }
    let Ok(workspaces) = herdr.workspace_list() else {
        return;
    };
    for w in workspaces.iter().filter(|w| spaces.contains(&w.workspace_id.as_str()) && !w.label.is_empty() && !w.label.contains(DESIGN_MARK)) {
        let _ = herdr.workspace_rename(&w.workspace_id, &design_label(&w.label));
    }
}

/// Starts an implementation thread's needs-you sub-line, so the sub-line
/// cell's `starts_with = "needs you"` rule (bold red) does not match it: the
/// user answers such a thread through the coordinator, whose own row stays
/// red. Zero-width, like `grouping::HEAD_MARK`, so the text reads the same.
pub const QUIET_MARK: char = '\u{200B}';

/// A thread's sub-line as the sidebar shows it: an implementation thread
/// that needs the user gets [`QUIET_MARK`] in front and stays dim; a design
/// thread, answered in its own pane, keeps the colour.
pub fn thread_sub(thread: &thread::Thread, sub: String) -> String {
    if thread.kind != thread::Kind::Design && sub.starts_with("needs you") {
        format!("{QUIET_MARK}{sub}")
    } else {
        sub
    }
}

/// A coordinator's sub-line: `needs you` when it or one of its threads needs
/// the user (so the red rule applies), its open local threads by group, then
/// its own last report. Unlike a thread's, the report is shown however old:
/// a coordinator waiting on its threads reports once and then sits idle.
pub fn coordinator_sub(threads: &[thread::Thread], state_line: &str, report: Option<&crate::progress::Record>) -> String {
    let groups: Vec<Group> = threads.iter().filter_map(|t| Group::from_token(&t.last_group)).collect();
    let mut parts: Vec<String> = Vec::new();
    if state_line.starts_with("needs you") || groups.contains(&Group::WaitingOnYou) {
        parts.push("needs you".into());
    }
    let labels = [(Group::WaitingOnYou, "blocked"), (Group::Working, "working"), (Group::ReadyForReview, "review"), (Group::Landing, "landing"), (Group::Idle, "idle")];
    for (group, label) in labels {
        let n = groups.iter().filter(|g| **g == group).count();
        if n > 0 {
            parts.push(format!("{n} {label}"));
        }
    }
    if let Some(r) = report.filter(|r| r.reported()) {
        if let Some(p) = r.percent.filter(|p| *p < 100) {
            parts.push(format!("~{p}%"));
        }
        if !r.activity.trim().is_empty() && !r.waiting() {
            parts.push(r.activity.trim().to_string());
        }
    }
    parts.join(" · ")
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

/// The coordinator's name colour, added to upstream's bold `contains = U+200B`
/// rule: Tokyo Night's blue (Herdr's accent there, as on the view label),
/// apart from the sub-line's needs-you red and review yellow and from the
/// state icons' yellow, red, teal and green.
const HEAD_COLOUR: &str = "#7aa2f7";

/// The fork's part of `configure`'s `config.toml` edit, run after upstream's
/// (and before it with `remove`, so upstream still recognises its own card):
/// the coordinator name's colour on every agent card (`rows` and each
/// `rows_by_agent` override), the design threads' colour there and on the
/// Space card, and the `[[keys.command]]` entry binding
/// [`KEY`] to [`ACTION`]. An existing key entry keeps the user's key; a taken
/// key adds nothing and says so.
pub fn config_edit(text: &str, builtin: &[(String, String)], remove: bool) -> Result<(String, Option<String>)> {
    let mut doc = text.parse::<DocumentMut>().context("config.toml does not parse")?;
    colour_heads(&mut doc, remove);
    let ours = |t: &Table| t.get("command").and_then(Item::as_str) == Some(ACTION);
    let existing = doc.get("keys").and_then(|k| k.get("command")).and_then(Item::as_array_of_tables).is_some_and(|c| c.iter().any(ours));
    if remove {
        if let Some(commands) = doc.get_mut("keys").and_then(|k| k.get_mut("command")).and_then(Item::as_array_of_tables_mut) {
            commands.retain(|t| !ours(t));
        }
        return Ok((doc.to_string(), None));
    }
    if existing {
        return Ok((doc.to_string(), None));
    }
    if let Some(conflict) = crate::sidebar::key_conflict(text, KEY, builtin) {
        return Ok((doc.to_string(), Some(format!("{conflict}, so no key toggles the agents view; bind `{ACTION}` yourself or run `herdr-projects view toggle`"))));
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

/// Design threads' names and Space labels: Tokyo Night's purple, apart from
/// the coordinators' blue and the state colours. Not bold, which marks the
/// heads; not italic, which Herdr 0.9.3's rules do not offer.
const DESIGN_COLOUR: &str = "#bb9af7";

/// Sets (or with `remove` drops) [`HEAD_COLOUR`] on the head rule of every
/// `agent` cell in the agents rows, and the [`DESIGN_MARK`] rule after the
/// head rule of every `agent` cell and of the Space rows' `workspace` cell.
/// Only those rules are ours; other cells and rules are the user's and stay
/// as they are.
fn colour_heads(doc: &mut DocumentMut, remove: bool) {
    let Some(sidebar) = doc.as_table_mut().get_mut("ui").and_then(Item::as_table_like_mut).and_then(|ui| ui.get_mut("sidebar")).and_then(Item::as_table_like_mut) else {
        return;
    };
    if let Some(agents) = sidebar.get_mut("agents").and_then(Item::as_table_like_mut) {
        if let Some(rows) = agents.get_mut("rows").and_then(Item::as_value_mut) {
            colour_rows(rows, "agent", crate::grouping::HEAD_MARK, Some(HEAD_COLOUR), remove);
        }
        if let Some(overrides) = agents.get_mut("rows_by_agent").and_then(Item::as_table_like_mut) {
            for (_, rows) in overrides.iter_mut() {
                if let Some(rows) = rows.as_value_mut() {
                    colour_rows(rows, "agent", crate::grouping::HEAD_MARK, Some(HEAD_COLOUR), remove);
                }
            }
        }
    }
    if let Some(rows) = sidebar.get_mut("spaces").and_then(Item::as_table_like_mut).and_then(|s| s.get_mut("rows")).and_then(Item::as_value_mut) {
        colour_rows(rows, "workspace", crate::grouping::HOME_MARK, None, remove);
    }
}

fn mark_rule(rule: &Value, mark: char) -> bool {
    rule.as_inline_table().and_then(|r| r.get("contains")).and_then(Value::as_str).is_some_and(|c| c.chars().eq([mark]))
}

/// The `token` cells of upstream's card (those with the `head` rule): the
/// head rule gets `head_colour`, and one design rule follows it. Herdr
/// applies the first rule that matches, and no name carries both marks.
fn colour_rows(rows: &mut Value, token: &str, head: char, head_colour: Option<&str>, remove: bool) {
    let cells = rows.as_array_mut().into_iter().flat_map(|rows| rows.iter_mut()).filter_map(Value::as_array_mut).flat_map(|row| row.iter_mut());
    for cell in cells.filter_map(Value::as_inline_table_mut).filter(|c| c.get("token").and_then(Value::as_str) == Some(token)) {
        let Some(rules) = cell.get_mut("rules").and_then(Value::as_array_mut).filter(|r| r.iter().any(|rule| mark_rule(rule, head))) else {
            continue;
        };
        if let Some(colour) = head_colour {
            for rule in rules.iter_mut().filter(|r| mark_rule(r, head)).filter_map(Value::as_inline_table_mut) {
                let changed = if remove { rule.remove("fg").is_some() } else { rule.get("fg").and_then(Value::as_str) != Some(colour) && rule.insert("fg", colour.into()).is_none() };
                if changed {
                    rule.fmt();
                }
            }
        }
        let mut design = InlineTable::new();
        design.insert("contains", DESIGN_MARK.to_string().into());
        design.insert("fg", DESIGN_COLOUR.into());
        let current: Vec<usize> = rules.iter().enumerate().filter(|(_, r)| mark_rule(r, DESIGN_MARK)).map(|(i, _)| i).collect();
        let in_place = current.len() == 1 && rules.get(current[0]).and_then(Value::as_inline_table).is_some_and(|r| r.to_string().split_whitespace().eq(design.to_string().split_whitespace()));
        if (remove && !current.is_empty()) || (!remove && !in_place) {
            rules.retain(|r| !mark_rule(r, DESIGN_MARK));
            if !remove {
                rules.push(design);
            }
            rules.fmt();
        }
    }
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
            ranks.insert(a.name.into(), Rank { needs: a.group == Group::WaitingOnYou && !paused.contains(&a.slug), implementation: a.kind == 't', ..Rank::default() });
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
                {"field":{"token":"hp_tier"},"order":"asc"},
                {"field":"attention","order":"desc"},
                {"field":"state_change_seq","order":"desc"},
            ])
        );
        assert_eq!((priority_view()["label"].as_str(), priority_view().get("filter")), (Some("priority"), None));
        assert_eq!(View::Projects.spec(), crate::sidebar::default_view());
        assert_eq!((View::Projects.other(), View::Priority.other()), (View::Priority, View::Projects));
    }

    #[test]
    fn implementation_threads_follow_every_other_agent_and_sort_by_attention_among_themselves() {
        let agents = [
            outside("outside-idle", IDLE, 90),
            seen("thread-working", "demo", 't', Group::Working, WORKING, 80),
            outside("outside-working", WORKING, 10),
            seen("thread-blocked", "demo", 't', Group::Working, BLOCKED, 5),
            seen("thread-done", "demo", 't', Group::ReadyForReview, DONE, 4),
        ];
        assert_eq!(priority(&agents), ["outside-working", "outside-idle", "thread-blocked", "thread-done", "thread-working"]);
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
    fn needs_you_coordinators_and_design_threads_lead_but_needs_you_implementation_threads_do_not() {
        let agents = [
            outside("outside-blocked", BLOCKED, 50),
            // Self-reported waiting while Herdr shows idle, and a failed thread.
            seen("coordinator-waiting", "demo", 'c', Group::WaitingOnYou, IDLE, 1),
            seen("thread-failed", "other", 't', Group::WaitingOnYou, IDLE, 2),
            seen("thread-review", "demo", 't', Group::ReadyForReview, IDLE, 70),
            seen("thread-done", "demo", 't', Group::WaitingOnYou, DONE, 80),
            seen("design-waiting", "demo", 'd', Group::WaitingOnYou, IDLE, 6),
            outside("outside-idle", IDLE, 3),
            outside("outside-working", WORKING, 4),
        ];
        assert_eq!(
            priority(&agents),
            ["design-waiting", "coordinator-waiting", "outside-blocked", "outside-working", "outside-idle", "thread-done", "thread-review", "thread-failed"]
        );
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
    fn every_pane_gets_a_tier_and_hp_needs_only_on_coordinators_and_design_threads() {
        assert_eq!(tokens(None), vec![("hp_tier".to_string(), Some("0".to_string())), ("hp_needs".to_string(), None)]);
        let blocked = Rank { needs: true, implementation: true, ..Rank::default() };
        assert_eq!(tokens(Some(&blocked)), vec![("hp_tier".to_string(), Some("1".to_string())), ("hp_needs".to_string(), None)]);
        let waiting = Rank { needs: true, ..Rank::default() };
        assert_eq!(tokens(Some(&waiting)), vec![("hp_tier".to_string(), Some("0".to_string())), ("hp_needs".to_string(), Some("1".to_string()))]);
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
        let (added, note) = config_edit("# mine\n[ui]\nsidebar_width = 30\n", &builtin, false).unwrap();
        assert!(note.is_none());
        assert_eq!(added.matches(ACTION).count(), 1);
        assert!(added.contains(KEY) && added.contains("plugin_action") && added.starts_with("# mine"), "{added}");
        assert_eq!(config_edit(&added, &builtin, false).unwrap().0, added);
        let rebound = added.replace(KEY, "alt+v");
        assert_eq!(config_edit(&rebound, &builtin, false).unwrap().0, rebound, "the user's own key stays");
        let taken = "[[keys.command]]\nkey = \"prefix+shift+v\"\ntype = \"shell\"\ncommand = \"mine\"\n";
        let (kept, note) = config_edit(taken, &builtin, false).unwrap();
        assert_eq!(kept, taken);
        assert!(note.unwrap().contains("bind `herdr-projects.toggle-view` yourself"));
        let (removed, _) = config_edit(&added, &builtin, true).unwrap();
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

    #[test]
    fn coordinator_names_get_their_colour_upgraded_in_place_and_unconfigure_restores_herdrs_rows() {
        let spec = crate::sidebar::Spec { key: "prefix+a".into(), tab_command: "/bin/hp needs-you --line".into() };
        // The rows upstream's configure wrote on this machine, plus a per-harness override with the same card.
        let card = format!("[\"state_icon\", {{ token = \"agent\", bold = false, dim = false, rules = [{{ contains = \"{}\", bold = true }}] }}, \"state_text\"]", crate::grouping::HEAD_MARK);
        let plain = format!("[ui.sidebar.agents]\nrows = [{card}, [{{ token = \"$hp_sub\", dim = true }}]]\n\n[ui.sidebar.agents.rows_by_agent]\nclaude = [{card}]\n");
        let (coloured, _) = config_edit(&plain, &[], false).unwrap();
        let doc = coloured.parse::<DocumentMut>().unwrap();
        let head_rule = |rows: &Item| -> Option<String> {
            rows.as_array()?.get(0)?.as_array()?.iter().find_map(|c| c.as_inline_table().filter(|t| t.get("token").and_then(Value::as_str) == Some("agent")))?.get("rules")?.as_array()?.get(0)?.as_inline_table()?.get("fg")?.as_str().map(str::to_string)
        };
        assert_eq!(head_rule(&doc["ui"]["sidebar"]["agents"]["rows"]).as_deref(), Some(HEAD_COLOUR), "{coloured}");
        assert_eq!(head_rule(&doc["ui"]["sidebar"]["agents"]["rows_by_agent"]["claude"]).as_deref(), Some(HEAD_COLOUR), "{coloured}");
        assert_eq!(coloured.matches(HEAD_COLOUR).count(), 2);
        // Bold stays, the rule reads cleanly, and configure (upstream's edit, then ours) is idempotent.
        assert!(coloured.contains(&format!("{{ contains = \"{}\", bold = true, fg = \"{HEAD_COLOUR}\" }}", crate::grouping::HEAD_MARK)), "{coloured}");
        let configure = |text: &str| config_edit(&crate::sidebar::config_edit(text, &spec, false).unwrap(), &[], false).unwrap().0;
        let once = configure(&coloured);
        assert_eq!(configure(&once), once);
        // Unconfigure: ours first, then upstream's, which then still finds its card and puts Herdr's rows back.
        let (stripped, _) = config_edit(&coloured, &[], true).unwrap();
        let removed = crate::sidebar::config_edit(&stripped, &spec, true).unwrap();
        assert!(!removed.contains(HEAD_COLOUR), "{removed}");
        let doc = removed.parse::<DocumentMut>().unwrap();
        assert!(doc["ui"]["sidebar"]["agents"]["rows"].to_string().contains("\"machine\""), "Herdr's built-in rows are back: {removed}");
        // Upstream leaves per-harness overrides to the user: the card there stays, only our colour is gone.
        assert!(doc["ui"]["sidebar"]["agents"]["rows_by_agent"]["claude"].to_string().contains(crate::grouping::HEAD_MARK));
    }

    #[test]
    fn a_coordinators_sub_line_counts_its_threads_and_ends_with_its_own_report() {
        let t = |group: Group, kind: thread::Kind| thread::Thread { last_group: group.token().into(), kind, ..thread::Thread::default() };
        let worker = thread::Kind::Worktree;
        let report = |percent: Option<u8>, activity: &str| crate::progress::Record { percent, activity: activity.into(), reported_at: 1, ..Default::default() };
        let waiting_on_thread = report(Some(50), "Waiting on thread");
        assert_eq!(coordinator_sub(&[t(Group::Working, worker)], "idle", Some(&waiting_on_thread)), "1 working · ~50% · Waiting on thread");
        let two = [t(Group::Working, worker), t(Group::ReadyForReview, worker), t(Group::Working, thread::Kind::Design)];
        assert_eq!(coordinator_sub(&two, "idle", None), "2 working · 1 review");
        assert_eq!(coordinator_sub(&[t(Group::WaitingOnYou, worker), t(Group::Resolved, worker)], "idle", None), "needs you · 1 blocked");
        // Its own question: the waiting activity is what `needs you` already says.
        let asks = report(Some(40), crate::progress::WAITING);
        assert_eq!(coordinator_sub(&[], "needs you · ~40%", Some(&asks)), "needs you · ~40%");
        assert_eq!(coordinator_sub(&[], "idle", Some(&report(Some(100), "Done"))), "Done");
        assert_eq!(coordinator_sub(&[], "idle", Some(&crate::progress::Record::default())), "", "no report this session: no row");
        // Red only when it leads with needs you; a leading count is never taken for a thread's review.
        let first_match = |value: &str| STATE_COLOURS.iter().find(|(word, _, _)| value.starts_with(word)).map(|(word, _, _)| *word);
        assert_eq!(first_match(&coordinator_sub(&[t(Group::WaitingOnYou, worker)], "idle", None)), Some("needs you"));
        assert_eq!(first_match(&coordinator_sub(&[t(Group::ReadyForReview, worker)], "idle", None)), None);
    }

    #[test]
    fn an_implementation_threads_needs_you_stays_dim_and_a_design_threads_keeps_its_colour() {
        let worker = thread::Thread { kind: thread::Kind::Worktree, ..thread::Thread::default() };
        let design = thread::Thread { kind: thread::Kind::Design, ..thread::Thread::default() };
        let quiet = thread_sub(&worker, "needs you · ~45%".into());
        assert_eq!(quiet, format!("{QUIET_MARK}needs you · ~45%"));
        assert_eq!(thread_sub(&design, "needs you · blocked".into()), "needs you · blocked");
        assert_eq!(thread_sub(&worker, "review · report".into()), "review · report", "review keeps its yellow");
        assert_eq!(thread_sub(&worker, "~40% · Writing tests".into()), "~40% · Writing tests");
        // The sub-line rules as Herdr applies them: the first `starts_with` that matches wins.
        let first_match = |value: &str| STATE_COLOURS.iter().find(|(word, _, _)| value.starts_with(word)).map(|(word, _, _)| *word);
        assert_eq!(first_match(&quiet), None, "dim, as the cell's base style");
        assert_eq!(first_match("needs you · ~45%"), Some("needs you"), "a coordinator or design thread stays red");
        assert_eq!(first_match("review · report"), Some("review"));
    }

    /// Herdr's `normalize_presentation_text` (0.9.3) for a display name.
    fn herdr_display(value: &str) -> String {
        let normalized: String = value.trim().chars().filter(|c| !c.is_control()).take(80).collect();
        normalized.trim().to_string()
    }

    /// Herdr's rule match on one cell: the first rule whose `contains` is in the value.
    fn first_rule(rules: &Value, value: &str) -> Option<InlineTable> {
        rules.as_array()?.iter().filter_map(Value::as_inline_table).find(|r| r.get("contains").and_then(Value::as_str).is_some_and(|c| value.contains(c))).cloned()
    }

    #[test]
    fn a_design_threads_name_and_space_label_carry_their_own_zero_width_mark() {
        let marks = [DESIGN_MARK, crate::grouping::HEAD_MARK, crate::grouping::HOME_MARK, QUIET_MARK];
        assert!(marks[1..].iter().all(|m| *m != DESIGN_MARK));
        // Not whitespace or a control character, so Herdr's trim and filter keep it.
        assert!(!DESIGN_MARK.is_whitespace() && !DESIGN_MARK.is_control());
        let design = thread::Thread { id: "t-0010".into(), title: "x".repeat(90), kind: thread::Kind::Design, ..thread::Thread::default() };
        let worker = thread::Thread { id: "t-0011".into(), title: "Task".into(), kind: thread::Kind::Worktree, ..thread::Thread::default() };
        let name = thread_display(&design);
        assert!(name.starts_with(DESIGN_MARK) && name.ends_with('x'));
        assert!(herdr_display(&name).starts_with(DESIGN_MARK), "kept when Herdr cuts a long name at 80 characters");
        assert_eq!(thread_display(&worker), "t-0011 · Task");
        assert_eq!(design_label("design: otp"), format!("{DESIGN_MARK}design: otp"));
        assert_eq!(design_label(&design_label("design: otp")), design_label("design: otp"), "marked once");
    }

    fn sidebar_cells(text: &str) -> (Value, Value, Value) {
        let doc = text.parse::<DocumentMut>().unwrap();
        let cell = |rows: &Item, token: &str| -> Value {
            rows.as_array().unwrap().iter().flat_map(|r| r.as_array().unwrap().iter()).find(|c| c.as_inline_table().is_some_and(|t| t.get("token").and_then(Value::as_str) == Some(token))).unwrap().as_inline_table().unwrap().get("rules").unwrap().clone()
        };
        let agents = &doc["ui"]["sidebar"]["agents"];
        (cell(&agents["rows"], "agent"), cell(&agents["rows_by_agent"]["claude"], "agent"), cell(&doc["ui"]["sidebar"]["spaces"]["rows"], "workspace"))
    }

    #[test]
    fn design_threads_are_purple_in_both_lists_upgraded_in_place_and_removed_by_unconfigure() {
        let spec = crate::sidebar::Spec { key: "prefix+a".into(), tab_command: "/bin/hp needs-you --line".into() };
        let (head, home) = (crate::grouping::HEAD_MARK, crate::grouping::HOME_MARK);
        // The rows the previous fork configure wrote on this machine.
        let card = format!("[\"state_icon\", {{ token = \"agent\", bold = false, dim = false, rules = [{{ contains = \"{head}\", bold = true, fg = \"{HEAD_COLOUR}\" }}] }}, \"state_text\"]");
        let earlier = format!(
            "[ui.sidebar.agents]\nrows = [{card}, [{{ token = \"$hp_sub\", dim = true }}]]\n\n[ui.sidebar.agents.rows_by_agent]\nclaude = [{card}]\n\n[ui.sidebar.spaces]\nrows = [[\"state_icon\", {{ token = \"workspace\", rules = [{{ contains = \"{home}\", bold = true }}] }}, {{ token = \"branch\", dim = true }}, \"git_status\"]]\n"
        );
        let configure = |text: &str| config_edit(&crate::sidebar::config_edit(text, &spec, false).unwrap(), &[], false).unwrap().0;
        let once = configure(&earlier);
        assert_eq!(configure(&once), once, "idempotent");
        assert_eq!(once.matches(DESIGN_COLOUR).count(), 3, "{once}");
        assert!(once.contains(&format!("{{ contains = \"{DESIGN_MARK}\", fg = \"{DESIGN_COLOUR}\" }}")), "{once}");
        // What `doctor`'s `sidebar_current` checks: our tab-bar entry and sub-line, no legacy token.
        assert!(once.contains("/bin/hp needs-you --line") && once.contains("\"$hp_sub\"") && !crate::grouping::legacy().iter().any(|t| once.contains(&format!("\"${t}\""))));

        let (agent, by_agent, space) = sidebar_cells(&once);
        assert_eq!(agent.to_string(), by_agent.to_string());
        let fg = |rule: Option<InlineTable>| rule.and_then(|r| r.get("fg").and_then(Value::as_str).map(str::to_string));
        let bold = |rule: Option<InlineTable>| rule.and_then(|r| r.get("bold").and_then(Value::as_bool));
        // First match wins: coordinators stay bold blue, design threads purple and not bold, others plain.
        let coordinator = format!("Projects Plugin{head}");
        let design = format!("{DESIGN_MARK}t-0010 · Colour design threads");
        assert_eq!((fg(first_rule(&agent, &coordinator)).as_deref(), bold(first_rule(&agent, &coordinator))), (Some(HEAD_COLOUR), Some(true)));
        assert_eq!((fg(first_rule(&agent, &design)).as_deref(), bold(first_rule(&agent, &design))), (Some(DESIGN_COLOUR), None));
        assert!(first_rule(&agent, "t-0011 · Task").is_none());
        let home_label = format!("Projects Plugin{home}");
        let design_space = format!("{DESIGN_MARK}design: otp");
        assert_eq!((fg(first_rule(&space, &home_label)), bold(first_rule(&space, &home_label))), (None, Some(true)));
        assert_eq!(fg(first_rule(&space, &design_space)).as_deref(), Some(DESIGN_COLOUR));
        assert!(first_rule(&space, "repo").is_none());

        // A design rule in another colour is replaced, not doubled.
        let recoloured = configure(&once.replace(DESIGN_COLOUR, "#000000"));
        assert_eq!(recoloured, once);

        // Unconfigure: ours first, then upstream's, which still finds its cards and puts Herdr's rows back.
        let (stripped, _) = config_edit(&once, &[], true).unwrap();
        assert!(!stripped.contains(DESIGN_MARK) && !stripped.contains(DESIGN_COLOUR), "{stripped}");
        let removed = crate::sidebar::config_edit(&stripped, &spec, true).unwrap();
        let doc = removed.parse::<DocumentMut>().unwrap();
        assert!(doc["ui"]["sidebar"]["agents"]["rows"].to_string().contains("\"machine\""), "{removed}");
        assert!(!doc["ui"]["sidebar"]["spaces"]["rows"].to_string().contains(home), "Herdr's Space rows are back: {removed}");
        // Unconfigure on rows without our rules changes nothing.
        assert_eq!(config_edit(&stripped, &[], true).unwrap().0, stripped);
    }
}
