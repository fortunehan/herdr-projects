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
//! `priority` sorts on `hp_needs`, `hp_tier` and `hp_recent`, which the
//! ticker writes here on every agent pane of a session it lays out, outside
//! agents included, next to `grouping`'s tokens; outside agents also get
//! their folder as display name. A local fork addition: upstream files only
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
/// threads (`hp_tier` 1). Implementation threads sort by [`RECENT_TOKEN`],
/// which no other agent carries, so the rest tie on it and sort by Herdr's
/// attention, then the latest state change. Herdr sorts a missing token last
/// in both directions.
pub fn priority_view() -> serde_json::Value {
    serde_json::json!({
        "source": crate::herdr::SOURCE,
        "label": "priority",
        "sort": [
            { "field": { "token": "hp_needs" }, "order": "desc" },
            { "field": { "token": "hp_tier" }, "order": "asc" },
            { "field": { "token": RECENT_TOKEN }, "order": "desc" },
            { "field": "attention", "order": "desc" },
            { "field": "state_change_seq", "order": "desc" },
        ],
    })
}

/// An implementation thread's place among its tier: `1` while working or
/// blocked, else `0`, then its `state_change_seq`, zero-padded as tokens
/// compare as strings. It sorts ahead of Herdr's attention, which drops a
/// done thread below the idle ones once it is viewed. Herdr 0.9.3's `done` is
/// idle and unseen, so viewing it moves no sequence number; `completion_seq`
/// is `state_change_seq` or absent, so it adds nothing here.
pub const RECENT_TOKEN: &str = "hp_recent";

fn recent(agent: &Agent) -> String {
    let live = matches!(agent.agent_status.as_str(), "working" | "blocked");
    format!("{}{:020}", u8::from(live), agent.state_change_seq)
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
    /// A thread's title, the row under its name ([`TITLE_TOKEN`]).
    pub title: Option<String>,
    /// A coordinator's sub-line cells besides `$hp_sub` (see [`SubCells`]).
    pub cells: SubCells,
}

/// One session's project agents, by pane.
pub type Ranks = HashMap<String, Rank>;

/// A project's agents as the ticker saw them: its coordinators (the live
/// ones, then the recorded pane) and its open local threads.
pub fn project_ranks(ctx: &Ctx, project: &Project, record: &project::Coordinator, coordinators: &[LivePane], agents: &[Agent], paused: bool) -> Vec<(String, Rank)> {
    let mut out = Vec::new();
    let threads: Vec<thread::Thread> = thread::list(project).into_iter().filter(|t| !t.is_remote() && matches!(t.status, thread::Status::Open | thread::Status::Starting)).collect();
    let thread_needs = threads.iter().any(|t| Group::from_token(&t.last_group) == Some(Group::WaitingOnYou));
    let recorded = (!record.pane_id.is_empty()).then_some(record.pane_id.as_str());
    for pane in coordinators.iter().map(|c| c.pane_id.as_str()).chain(recorded) {
        if out.iter().any(|(p, _)| p == pane) {
            continue;
        }
        let terminal = agents.iter().find(|a| a.pane_id == pane).map(|a| a.terminal_id.clone()).unwrap_or_default();
        let report = crate::progress::self_report(&ctx.root, &record.socket, pane, &terminal);
        let state = coordinators.iter().find(|c| c.pane_id == pane).map(|c| crate::coordinator::row_state(c, report.as_ref()));
        let needs = !paused && state.is_some() && (thread_needs || state.as_ref().is_some_and(|(group, _)| *group == Group::WaitingOnYou));
        let line = state.map(|(_, line)| line).unwrap_or_default();
        let cells = if paused { SubCells::default() } else { coordinator_line(&threads, &line, report.as_ref()).cells };
        out.push((pane.to_string(), Rank { needs, cells, ..Rank::default() }));
    }
    for t in threads.into_iter().filter(|t| !t.pane_id.is_empty()) {
        let needs = !paused && Group::from_token(&t.last_group) == Some(Group::WaitingOnYou);
        let design = t.kind == thread::Kind::Design;
        let design_space = (design && !t.workspace_id.is_empty() && t.workspace_id != record.workspace_id).then(|| t.workspace_id.clone());
        let title = Some(t.title.clone()).filter(|title| !title.trim().is_empty());
        out.push((t.pane_id.clone(), Rank { needs, implementation: !design, design_space, title, ..Rank::default() }));
    }
    out
}

/// A pane's tokens: every agent gets a tier (`0` unless an implementation
/// thread); `hp_needs` is cleared, not set to 0, when it does not apply. An
/// implementation thread never gets it: its coordinator, which then needs
/// the user too, is where the user resolves it, and only it gets
/// [`RECENT_TOKEN`]. A thread's title goes in [`TITLE_TOKEN`], a
/// coordinator's [`SubCells`] in theirs; each is cleared on every other pane.
pub fn tokens(rank: Option<&Rank>, agent: &Agent) -> Tokens {
    let rank = rank.cloned().unwrap_or_default();
    vec![
        ("hp_tier".to_string(), Some(if rank.implementation { "1" } else { "0" }.to_string())),
        ("hp_needs".to_string(), (rank.needs && !rank.implementation).then(|| "1".to_string())),
        (RECENT_TOKEN.to_string(), rank.implementation.then(|| recent(agent))),
        (TITLE_TOKEN.to_string(), rank.title),
        (PROGRESS_TOKEN.to_string(), rank.cells.progress),
        (WORKING_TOKEN.to_string(), rank.cells.working),
        (REST_TOKEN.to_string(), rank.cells.rest),
    ]
}

/// An outside agent's row name: the last part of its working directory (its
/// own, else its shell's), `~` for the home directory, cut to Herdr's limit.
/// None when Herdr knows no directory, so Herdr's own name stays.
pub fn outside_display(agent: &Agent, home: &Path) -> Option<String> {
    let dir = [&agent.foreground_cwd, &agent.cwd].into_iter().find(|d| !d.trim().is_empty())?;
    let path = Path::new(dir.trim());
    let name = if path == home {
        "~".to_string()
    } else {
        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
    };
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    let name = name.trim();
    let name = if name.chars().count() > DISPLAY_CHARS { format!("{}…", name.chars().take(DISPLAY_CHARS - 1).collect::<String>().trim_end()) } else { name.to_string() };
    Some(name).filter(|n| !n.is_empty())
}

/// What was sent per `(socket, pane)`, so an unchanged pane is re-sent only
/// to keep its TTL alive.
type Sent = HashMap<(String, String), (Tokens, Option<String>, Instant)>;

static SENT: Mutex<Option<Sent>> = Mutex::new(None);

const RESEND: Duration = Duration::from_millis(crate::sidebar::TOKEN_TTL_MS / 3);

fn due(socket: &str, pane: &str, tokens: &Tokens, display: Option<&str>) -> bool {
    let mut sent = SENT.lock().unwrap_or_else(|e| e.into_inner());
    let sent = sent.get_or_insert_with(HashMap::new);
    let key = (socket.to_string(), pane.to_string());
    match sent.get(&key) {
        Some((last, shown, at)) if last == tokens && shown.as_deref() == display && at.elapsed() < RESEND => false,
        _ => {
            sent.insert(key, (tokens.clone(), display.map(str::to_string), Instant::now()));
            true
        }
    }
}

/// `grouping::report` with the display name in the same call and TTL, so an
/// outside agent's name falls back to Herdr's own when the ticker stops.
fn report(herdr: &Herdr, pane: &str, tokens: &Tokens, display: Option<&str>) {
    let Some(display) = display else {
        return crate::grouping::report(herdr, "pane", pane, tokens);
    };
    let ttl = crate::sidebar::TOKEN_TTL_MS.to_string();
    let mut args: Vec<String> = ["pane", "report-metadata", pane, "--source", crate::herdr::SOURCE, "--display-agent", display, "--ttl-ms", &ttl].iter().map(|s| s.to_string()).collect();
    for (name, value) in tokens {
        match value {
            Some(value) => args.extend(["--token".to_string(), format!("{name}={value}")]),
            None => args.extend(["--clear-token".to_string(), name.clone()]),
        }
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let _ = herdr.call(&args, crate::herdr::CALL_TIMEOUT);
}

/// Writes the priority tokens on every agent pane of one session, names each
/// outside agent (no rank) after its directory ([`outside_display`]), and
/// puts [`DESIGN_MARK`] back on a design Space label that lost it. Threads
/// and coordinators keep the names `sidebar::report_pane` gives them.
pub fn apply(herdr: &Herdr, socket: &str, ranks: Option<&Ranks>, agents: &[Agent], home: &Path) {
    for agent in agents {
        let rank = ranks.and_then(|r| r.get(&agent.pane_id));
        let tokens = tokens(rank, agent);
        let display = rank.is_none().then(|| outside_display(agent, home)).flatten();
        if due(socket, &agent.pane_id, &tokens, display.as_deref()) {
            report(herdr, &agent.pane_id, &tokens, display.as_deref());
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

/// The token of the agent card's second row: a thread's title, under the
/// project name and id of its display name. Herdr skips a row whose tokens
/// are all missing, so coordinators and outside agents draw none.
pub const TITLE_TOKEN: &str = "hp_title";

/// Herdr's cut of a display name, in characters.
const DISPLAY_CHARS: usize = 80;

/// A project's name as its coordinator's row shows it.
pub fn project_name(project: &Project) -> String {
    project.read_project_md().map(|(s, _)| project::display_name(&s.name, &project.slug)).unwrap_or_else(|_| project.slug.clone())
}

/// A thread's row name: `<project name> · <id>`, the name shortened so Herdr's
/// cut never reaches the id; a design thread's starts with [`DESIGN_MARK`].
/// A local thread's title is the row below ([`TITLE_TOKEN`]); a remote one,
/// whose machine gets none of this module's tokens, keeps it in the name.
pub fn thread_display(project: &Project, thread: &thread::Thread) -> String {
    let mark = if thread.kind == thread::Kind::Design { DESIGN_MARK.to_string() } else { String::new() };
    let id = format!(" · {}", thread.id);
    let name = project_name(project);
    let room = DISPLAY_CHARS.saturating_sub(mark.chars().count() + id.chars().count());
    let name = if name.chars().count() > room { format!("{}…", name.chars().take(room.saturating_sub(1)).collect::<String>().trim_end()) } else { name };
    if thread.is_remote() { format!("{mark}{name} · {}", crate::sidebar::thread_display(thread)) } else { format!("{mark}{name}{id}") }
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

/// Starts a coordinator's and a design thread's sub-line, so the sub-line
/// cell's rules show it in [`CLEAR_COLOUR`] instead of dim. Zero-width, and
/// apart from [`QUIET_MARK`] and [`DESIGN_MARK`], so unconfigure's checks
/// for those marks still hold.
pub const CLEAR_MARK: char = '\u{200C}';

/// `sub` with [`CLEAR_MARK`] in front; an empty one stays empty, so no row
/// is drawn.
fn clear_sub(sub: String) -> String {
    if sub.is_empty() { sub } else { format!("{CLEAR_MARK}{sub}") }
}

/// A thread's sub-line as the sidebar shows it: an implementation thread
/// that needs the user gets [`QUIET_MARK`] in front and stays dim; a design
/// thread, answered in its own pane, keeps the colour and reads clearly
/// ([`CLEAR_MARK`]).
pub fn thread_sub(thread: &thread::Thread, sub: String) -> String {
    if thread.kind == thread::Kind::Design {
        clear_sub(sub)
    } else if sub.starts_with("needs you") {
        format!("{QUIET_MARK}{sub}")
    } else {
        sub
    }
}

/// A thread's state line with its pull request named by its PR reference
/// (`PR !N` on Azure DevOps): upstream's `sidebar::state_line` builds `PR #N`
/// from the URL itself. A URL with no reference shows as `report`, like a
/// thread with no pull request.
pub fn state_line(group: Group, t: &thread::Thread, live: &thread::Live, now: jiff::Timestamp) -> String {
    let line = crate::sidebar::state_line(group, t, live, now);
    match line.split_once(" · ") {
        Some((word, fact)) if fact.starts_with("PR ") => match crate::pr::reference(&t.pr) {
            Some(reference) => format!("{word} · PR {reference}"),
            None => format!("{word} · report"),
        },
        _ => line,
    }
}

/// A coordinator's own percentage, the first cell of its sub-line row.
pub const PROGRESS_TOKEN: &str = "hp_pct";
/// A coordinator's `N working`, the cell after `$hp_sub`.
pub const WORKING_TOKEN: &str = "hp_work";
/// A coordinator's other thread counts, the last cell.
pub const REST_TOKEN: &str = "hp_rest";

/// The cells of a coordinator's sub-line row other than `$hp_sub`. Herdr
/// colours a whole token, so the yellow parts need tokens of their own; it
/// joins a row's tokens with ` · ` and skips missing ones, so the row reads
/// `~10% · needs you · 1 blocked · 2 working · 1 review` as one line.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubCells {
    pub progress: Option<String>,
    pub working: Option<String>,
    pub rest: Option<String>,
}

/// A coordinator's sub-line, split into its row's cells.
struct CoordinatorLine {
    /// `$hp_sub`: `needs you` and the blocked count, red together.
    lead: String,
    cells: SubCells,
}

/// A coordinator's sub-line: its own last reported percentage first, then
/// `needs you` when it or one of its threads needs the user, then its open
/// local threads by group. Unlike a thread's, the percentage is shown however
/// old: a coordinator waiting on its threads reports once and then sits idle.
/// Its activity is left out to keep the line short.
fn coordinator_line(threads: &[thread::Thread], state_line: &str, report: Option<&crate::progress::Record>) -> CoordinatorLine {
    let groups: Vec<Group> = threads.iter().filter_map(|t| Group::from_token(&t.last_group)).collect();
    let count = |group: Group, label: &str| Some(groups.iter().filter(|g| **g == group).count()).filter(|n| *n > 0).map(|n| format!("{n} {label}"));
    let needs = (state_line.starts_with("needs you") || groups.contains(&Group::WaitingOnYou)).then(|| "needs you".to_string());
    let lead: Vec<String> = needs.into_iter().chain(count(Group::WaitingOnYou, "blocked")).collect();
    let rest: Vec<String> = [(Group::ReadyForReview, "review"), (Group::Landing, "landing"), (Group::Idle, "idle")].into_iter().filter_map(|(g, l)| count(g, l)).collect();
    let progress = report.filter(|r| r.reported()).and_then(|r| r.percent).filter(|p| *p < 100).map(|p| format!("~{p}%"));
    CoordinatorLine { lead: lead.join(" · "), cells: SubCells { progress, working: count(Group::Working, "working"), rest: Some(rest.join(" · ")).filter(|r| !r.is_empty()) } }
}

/// A coordinator's `$hp_sub` (see [`coordinator_line`]): `needs you` and the
/// blocked count, so the red rule applies, after [`CLEAR_MARK`]; empty, so no
/// cell is drawn, when nothing needs the user.
pub fn coordinator_sub(threads: &[thread::Thread], state_line: &str, report: Option<&crate::progress::Record>) -> String {
    clear_sub(coordinator_line(threads, state_line, report).lead)
}

// ---------------------------------------------------------------- config.toml

/// Colours of the sub-line's group word, as the fork's sidebar had them
/// before the port: needs-you bold red, review yellow, both undimmed; the
/// rest of the sub-line stays dim, except after [`CLEAR_MARK`].
const STATE_COLOURS: [(&str, &str, bool); 2] = [("needs you", "#f38ba8", true), ("review", "#f9e2af", false)];

/// A [`CLEAR_MARK`] sub-line without a group word: Tokyo Night's secondary
/// foreground, readable but quieter than the coordinators' bold blue.
const CLEAR_COLOUR: &str = "#a9b1d6";

/// The sub-line rules as `(starts_with, fg, bold)`, in Herdr's order (the
/// first match wins): each group word bare and after [`CLEAR_MARK`], then
/// the mark alone.
fn sub_rules() -> Vec<(String, &'static str, bool)> {
    let bare = STATE_COLOURS.iter().map(|(word, colour, bold)| (word.to_string(), *colour, *bold));
    let clear = STATE_COLOURS.iter().map(|(word, colour, bold)| (format!("{CLEAR_MARK}{word}"), *colour, *bold));
    bare.chain(clear).chain([(CLEAR_MARK.to_string(), CLEAR_COLOUR, false)]).collect()
}

/// `row` (upstream's `$hp_sub` row) with Herdr rules that colour a sub-line
/// starting with a group word or [`CLEAR_MARK`]. The first matching rule
/// wins, and its `dim` overrides the cell's.
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
        for (start, colour, bold) in sub_rules() {
            let mut rule = InlineTable::new();
            rule.insert("starts_with", start.into());
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
    place_sub_cells(&mut doc, remove);
    place_title_rows(&mut doc, remove);
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

/// Herdr 0.9.3's limit on rows per card.
const MAX_ROWS: usize = 16;

/// Whether a card row has a cell of `token`.
fn row_names(row: &Value, token: &str) -> bool {
    row.as_array().is_some_and(|cells| cells.iter().any(|c| c.as_str() == Some(token) || c.as_inline_table().and_then(|t| t.get("token")).and_then(Value::as_str) == Some(token)))
}

fn title_row(row: &Value) -> bool {
    let token = format!("${TITLE_TOKEN}");
    row.as_array().is_some_and(|cells| cells.len() == 1) && row_names(row, &token)
}

/// The agents' `rows` and every `rows_by_agent` override.
fn agent_row_lists(doc: &mut DocumentMut) -> Vec<&mut Array> {
    let mut lists: Vec<&mut Array> = Vec::new();
    let Some(agents) = doc.as_table_mut().get_mut("ui").and_then(Item::as_table_like_mut).and_then(|ui| ui.get_mut("sidebar")).and_then(Item::as_table_like_mut).and_then(|s| s.get_mut("agents")).and_then(Item::as_table_like_mut) else {
        return lists;
    };
    for (key, item) in agents.iter_mut() {
        match key.get() {
            "rows" => lists.extend(item.as_value_mut().and_then(Value::as_array_mut)),
            "rows_by_agent" => {
                if let Some(overrides) = item.as_table_like_mut() {
                    lists.extend(overrides.iter_mut().filter_map(|(_, rows)| rows.as_value_mut().and_then(Value::as_array_mut)));
                }
            }
            _ => {}
        }
    }
    lists
}

/// The coordinator's percentage and working count: Tokyo Night's yellow, as
/// on Herdr's working state icon, and apart from the threads' paler `review`.
const PROGRESS_COLOUR: &str = "#e0af68";

/// The [`SubCells`] cells as `(token, fg)`, before `$hp_sub` and after it.
const BEFORE_SUB: [(&str, &str); 1] = [(PROGRESS_TOKEN, PROGRESS_COLOUR)];
const AFTER_SUB: [(&str, &str); 2] = [(WORKING_TOKEN, PROGRESS_COLOUR), (REST_TOKEN, CLEAR_COLOUR)];

fn cell_token(cell: &Value) -> Option<&str> {
    cell.as_str().or_else(|| cell.as_inline_table().and_then(|t| t.get("token")).and_then(Value::as_str))
}

/// Puts (or with `remove` takes out) the [`SubCells`] cells around `$hp_sub`
/// in upstream's sub-line row, in `rows` and every `rows_by_agent` override.
/// Upstream's edit keeps a row whose tokens are not all its own and adds a
/// fresh sub-line row at the bottom, so an earlier run's row loses our cells
/// and only the last bare `$hp_sub` row is kept. Before upstream's removal,
/// the row is left bare for upstream to recognise.
fn place_sub_cells(doc: &mut DocumentMut, remove: bool) {
    let ours: Vec<String> = BEFORE_SUB.iter().chain(&AFTER_SUB).map(|(t, _)| format!("${t}")).collect();
    let bare = |row: &Value| row.as_array().is_some_and(|cells| cells.len() == 1 && cells.get(0).and_then(cell_token) == Some("$hp_sub"));
    let cell = |(token, colour): &(&str, &str)| {
        let mut t = InlineTable::new();
        t.insert("token", format!("${token}").into());
        t.insert("fg", (*colour).into());
        Value::InlineTable(t)
    };
    for rows in agent_row_lists(doc) {
        for row in rows.iter_mut().filter_map(Value::as_array_mut) {
            row.retain(|c| !cell_token(c).is_some_and(|t| ours.iter().any(|o| o == t)));
        }
        rows.retain(|r| r.as_array().is_none_or(|cells| !cells.is_empty()));
        let Some(last) = rows.iter().enumerate().filter(|(_, r)| bare(r)).map(|(i, _)| i).last().filter(|_| !remove) else {
            continue;
        };
        let dupes: Vec<usize> = rows.iter().enumerate().filter(|(i, r)| *i != last && bare(r)).map(|(i, _)| i).collect();
        for i in dupes.iter().rev() {
            rows.remove(*i);
        }
        let row = rows.get_mut(last - dupes.len()).and_then(Value::as_array_mut).expect("a bare sub-line row");
        for (i, c) in BEFORE_SUB.iter().enumerate() {
            row.insert_formatted(i, cell(c));
        }
        for c in &AFTER_SUB {
            row.push_formatted(cell(c));
        }
        row.fmt();
    }
}

/// Puts (or with `remove` drops) the [`TITLE_TOKEN`] row right above the
/// `$hp_sub` row of upstream's card, in `rows` and every `rows_by_agent`
/// override. Upstream's edit keeps a row it does not own where it is and
/// moves its sub-line to the bottom, so the title stays second.
fn place_title_rows(doc: &mut DocumentMut, remove: bool) {
    let sub = "$hp_sub";
    for rows in agent_row_lists(doc) {
        let titles = rows.iter().filter(|r| title_row(r)).count();
        let at = rows.iter().position(|r| row_names(r, sub));
        let in_place = titles == 1 && at.is_some_and(|i| i > 0 && rows.get(i - 1).is_some_and(title_row));
        if remove {
            rows.retain(|r| !title_row(r));
            continue;
        }
        if at.is_none() || in_place {
            continue;
        }
        rows.retain(|r| !title_row(r));
        if rows.len() >= MAX_ROWS {
            continue;
        }
        let mut cell = InlineTable::new();
        cell.insert("token", format!("${TITLE_TOKEN}").into());
        let mut row = Array::new();
        row.push(cell);
        let at = rows.iter().position(|r| row_names(r, sub)).unwrap_or(rows.len());
        rows.insert(at, row);
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

    #[test]
    fn a_state_line_names_the_pull_request_by_its_pr_reference() {
        let now: jiff::Timestamp = "2026-09-23T12:00:00Z".parse().unwrap();
        let live = thread::Live { pane_exists: true, agent_state: Some("idle".into()), ..thread::Live::default() };
        let with_pr = |pr: &str| thread::Thread { status: thread::Status::Open, pr: pr.into(), ..thread::Thread::default() };
        let github = with_pr("https://github.com/o/r/pull/42");
        assert_eq!(state_line(Group::ReadyForReview, &github, &live, now), "review · PR #42");
        assert_eq!(state_line(Group::Landing, &github, &live, now), "landing · PR #42");
        assert_eq!(state_line(Group::ReadyForReview, &with_pr(""), &live, now), "review · report");
        let ado = with_pr("https://dev.azure.com/org/project/_git/repo/pullrequest/12");
        assert_eq!(state_line(Group::ReadyForReview, &ado, &live, now), "review · PR !12");
        // No followed forge gives this URL a reference, so no number is shown.
        let unknown = with_pr("https://gitlab.com/o/r/-/merge_requests/12");
        assert_eq!(state_line(Group::ReadyForReview, &unknown, &live, now), "review · report");
        assert_eq!(state_line(Group::Idle, &github, &live, now), "idle");
    }

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

    impl Seen {
        /// Herdr's `agent_status` for the attention level.
        fn status(&self) -> &'static str {
            match self.attention {
                BLOCKED => "blocked",
                DONE => "done",
                WORKING => "working",
                _ => "idle",
            }
        }
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
        let list: Vec<Agent> = agents.iter().map(|a| Agent { pane_id: a.name.into(), agent_status: a.status().into(), state_change_seq: a.seq, ..Default::default() }).collect();
        let layout = crate::grouping::plan(&parts, &list, &[]);
        agents
            .iter()
            .zip(&list)
            .map(|(a, agent)| {
                let grouping = &layout.agents.iter().find(|(p, _)| p == a.name).unwrap().1;
                let mut tokens: std::collections::BTreeMap<String, String> = grouping.iter().chain(tokens(ranks.get(a.name), agent).iter()).filter_map(|(n, v)| Some((n.clone(), v.clone()?))).collect();
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
                {"field":{"token":"hp_recent"},"order":"desc"},
                {"field":"attention","order":"desc"},
                {"field":"state_change_seq","order":"desc"},
            ])
        );
        assert_eq!((priority_view()["label"].as_str(), priority_view().get("filter")), (Some("priority"), None));
        assert_eq!(View::Projects.spec(), crate::sidebar::default_view());
        assert_eq!((View::Projects.other(), View::Priority.other()), (View::Priority, View::Projects));
    }

    #[test]
    fn implementation_threads_follow_every_other_agent_working_and_blocked_first() {
        let agents = [
            outside("outside-idle", IDLE, 90),
            seen("thread-working", "demo", 't', Group::Working, WORKING, 80),
            outside("outside-working", WORKING, 10),
            seen("thread-blocked", "demo", 't', Group::Working, BLOCKED, 5),
            seen("thread-done", "demo", 't', Group::ReadyForReview, DONE, 4),
        ];
        assert_eq!(priority(&agents), ["outside-working", "outside-idle", "thread-working", "thread-blocked", "thread-done"]);
    }

    #[test]
    fn stopped_implementation_threads_sort_by_when_they_stopped_whether_viewed_or_not() {
        let agents = [
            // Done at 90 and viewed: idle now, attention 1, still the latest to stop.
            seen("viewed", "demo", 't', Group::ReadyForReview, IDLE, 90),
            seen("done", "demo", 't', Group::ReadyForReview, DONE, 60),
            seen("idle", "demo", 't', Group::Idle, IDLE, 50),
            seen("working", "demo", 't', Group::Working, WORKING, 10),
            seen("blocked", "demo", 't', Group::Working, BLOCKED, 30),
            outside("outside-idle", IDLE, 1),
            seen("coordinator", "demo", 'c', Group::Working, WORKING, 2),
            outside("outside-done", DONE, 3),
        ];
        assert_eq!(priority(&agents), ["outside-done", "coordinator", "outside-idle", "blocked", "working", "viewed", "done", "idle"]);
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
        let title = |t: Option<&str>| (TITLE_TOKEN.to_string(), t.map(str::to_string));
        let none = |token: &str| (token.to_string(), None);
        let some = |token: &str, value: &str| (token.to_string(), Some(value.to_string()));
        let no_cells = [none(PROGRESS_TOKEN), none(WORKING_TOKEN), none(REST_TOKEN)];
        let with = |head: Vec<(String, Option<String>)>| head.into_iter().chain(no_cells.clone()).collect::<Vec<_>>();
        let idle = Agent { agent_status: "idle".into(), state_change_seq: 593, ..Agent::default() };
        assert_eq!(tokens(None, &idle), with(vec![some("hp_tier", "0"), none("hp_needs"), none(RECENT_TOKEN), title(None)]));
        let blocked = Rank { needs: true, implementation: true, title: Some("Fix the build".into()), ..Rank::default() };
        assert_eq!(tokens(Some(&blocked), &idle), with(vec![some("hp_tier", "1"), none("hp_needs"), some(RECENT_TOKEN, "000000000000000000593"), title(Some("Fix the build"))]));
        let working = Agent { agent_status: "blocked".into(), ..idle.clone() };
        assert_eq!(tokens(Some(&blocked), &working)[2], some(RECENT_TOKEN, "100000000000000000593"));
        let cells = SubCells { progress: Some("~10%".into()), working: Some("2 working".into()), rest: None };
        let waiting = Rank { needs: true, cells, ..Rank::default() };
        assert_eq!(tokens(Some(&waiting), &idle), vec![some("hp_tier", "0"), some("hp_needs", "1"), none(RECENT_TOKEN), title(None), some(PROGRESS_TOKEN, "~10%"), some(WORKING_TOKEN, "2 working"), none(REST_TOKEN)]);
    }

    #[test]
    fn an_outside_agent_is_named_after_its_folder_home_as_tilde() {
        let home = Path::new("/Users/me");
        let at = |cwd: &str, foreground: &str| outside_display(&Agent { cwd: cwd.into(), foreground_cwd: foreground.into(), ..Agent::default() }, home);
        assert_eq!(at("/Users/me/Codes/herdr", ""), Some("herdr".into()));
        assert_eq!(at("/Users/me", "/Users/me/Codes/app/"), Some("app".into()), "the agent's own directory wins over its shell's");
        assert_eq!(at("/Users/me/", ""), Some("~".into()));
        assert_eq!(at("/", ""), Some("/".into()));
        assert_eq!(at("", "  "), None, "no directory: Herdr's own name stays");
        assert_eq!(at("/tmp/a\u{7}b", ""), Some("ab".into()));
        let long = at(&format!("/tmp/{}", "x".repeat(90)), "").unwrap();
        assert_eq!(long.chars().count(), DISPLAY_CHARS);
        assert_eq!(herdr_display(&long), long, "Herdr's cut leaves it whole");
        assert!(long.ends_with('…'));
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
        assert_eq!(rule(2, "starts_with").unwrap().as_str(), Some(format!("{CLEAR_MARK}needs you").as_str()));
        assert_eq!(rule(3, "starts_with").unwrap().as_str(), Some(format!("{CLEAR_MARK}review").as_str()));
        let last = rules.len() - 1;
        assert_eq!((rule(last, "starts_with").unwrap().as_str(), rule(last, "fg").unwrap().as_str(), rule(last, "dim").unwrap().as_bool()), (Some(CLEAR_MARK.to_string().as_str()), Some(CLEAR_COLOUR), Some(false)));
        // Herdr 0.9.3 rejects the whole config on any other rule key.
        let keys = rules.iter().flat_map(|r| r.as_inline_table().unwrap().iter().map(|(k, _)| k.to_string()).collect::<Vec<_>>());
        assert!(keys.into_iter().all(|k| ["starts_with", "fg", "bold", "dim"].contains(&k.as_str())));
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
    fn a_coordinators_sub_line_leads_with_its_own_percentage_then_counts_its_threads() {
        let t = |group: Group, kind: thread::Kind| thread::Thread { last_group: group.token().into(), kind, ..thread::Thread::default() };
        let worker = thread::Kind::Worktree;
        let report = |percent: Option<u8>, activity: &str| crate::progress::Record { percent, activity: activity.into(), reported_at: 1, ..Default::default() };
        let waiting_on_thread = report(Some(50), "Waiting on thread");
        let clear = |text: &str| format!("{CLEAR_MARK}{text}");
        // The cells as Herdr draws the row: present ones joined by ` · `.
        let row = |threads: &[thread::Thread], line: &str, report: Option<&crate::progress::Record>| -> String {
            let CoordinatorLine { lead, cells } = coordinator_line(threads, line, report);
            [cells.progress, Some(lead).filter(|l| !l.is_empty()), cells.working, cells.rest].into_iter().flatten().collect::<Vec<_>>().join(" · ")
        };
        assert_eq!(row(&[t(Group::Working, worker)], "idle", Some(&waiting_on_thread)), "~50% · 1 working", "no activity text");
        assert_eq!(coordinator_sub(&[t(Group::Working, worker)], "idle", Some(&waiting_on_thread)), "", "nothing red, so no `$hp_sub` cell");
        let cells = coordinator_line(&[t(Group::Working, worker)], "idle", Some(&waiting_on_thread)).cells;
        assert_eq!(cells, SubCells { progress: Some("~50%".into()), working: Some("1 working".into()), rest: None });
        let two = [t(Group::Working, worker), t(Group::ReadyForReview, worker), t(Group::Working, thread::Kind::Design), t(Group::Idle, worker)];
        assert_eq!(row(&two, "idle", None), "2 working · 1 review · 1 idle");
        assert_eq!(coordinator_line(&two, "idle", None).cells.rest.as_deref(), Some("1 review · 1 idle"));
        assert_eq!(coordinator_sub(&[t(Group::WaitingOnYou, worker), t(Group::Resolved, worker)], "idle", None), clear("needs you · 1 blocked"));
        let asks = report(Some(40), crate::progress::WAITING);
        let all = [t(Group::Working, worker), t(Group::WaitingOnYou, worker), t(Group::Landing, worker)];
        assert_eq!(row(&all, "needs you · ~40%", Some(&asks)), "~40% · needs you · 1 blocked · 1 working · 1 landing");
        assert_eq!(coordinator_sub(&[t(Group::Working, worker)], "needs you · ~40%", Some(&asks)), clear("needs you"));
        assert_eq!(row(&[], "idle", Some(&report(Some(100), "Done"))), "", "done: no percentage and no activity");
        assert_eq!(row(&[], "idle", Some(&report(None, "Reading code"))), "");
        assert_eq!(row(&[], "idle", Some(&crate::progress::Record::default())), "", "no report this session: no row");
        // `$hp_sub` is red when it leads with needs you, and never taken for a thread's review.
        assert_eq!(first_match(&coordinator_sub(&[t(Group::WaitingOnYou, worker)], "idle", None)), Some(("#f38ba8", true)));
    }

    #[test]
    fn the_sub_line_row_gets_yellow_percentage_and_working_cells_once_and_unconfigure_leaves_upstreams_row() {
        let spec = crate::sidebar::Spec { key: "prefix+a".into(), tab_command: "/bin/hp needs-you --line".into() };
        let configure = |text: &str| config_edit(&crate::sidebar::config_edit(text, &spec, false).unwrap(), &[], false).unwrap().0;
        let once = configure("");
        assert_eq!(configure(&once), once, "idempotent");
        let doc = once.parse::<DocumentMut>().unwrap();
        let rows = doc["ui"]["sidebar"]["agents"]["rows"].as_array().unwrap();
        let sub = rows.iter().filter_map(Value::as_array).filter(|r| row_names(&Value::Array((*r).clone()), "$hp_sub")).collect::<Vec<_>>();
        assert_eq!(sub.len(), 1, "one sub-line row: {once}");
        let cells: Vec<(&str, Option<&str>)> = sub[0].iter().map(|c| (cell_token(c).unwrap(), c.as_inline_table().unwrap().get("fg").and_then(Value::as_str))).collect();
        assert_eq!(cells, [("$hp_pct", Some(PROGRESS_COLOUR)), ("$hp_sub", None), ("$hp_work", Some(PROGRESS_COLOUR)), ("$hp_rest", Some(CLEAR_COLOUR))]);
        assert!(sub[0].iter().all(|c| c.as_inline_table().unwrap().iter().all(|(k, _)| ["token", "fg", "dim", "rules"].contains(&k))), "only keys Herdr 0.9.3 takes");
        // A row from before this change (bare `$hp_sub`) is upgraded in place.
        let (bare, _) = config_edit(&once, &[], true).unwrap();
        assert!(!bare.contains("$hp_pct") && bare.contains("$hp_sub"), "{bare}");
        assert_eq!(configure(&bare), once);
        // Unconfigure: ours first, then upstream's, which takes the bare row out.
        let removed = crate::sidebar::config_edit(&bare, &spec, true).unwrap();
        assert!(!removed.contains("$hp_sub") && !removed.contains("$hp_work"), "{removed}");
    }

    #[test]
    fn an_implementation_threads_needs_you_stays_dim_and_a_design_threads_keeps_its_colour() {
        let worker = thread::Thread { kind: thread::Kind::Worktree, ..thread::Thread::default() };
        let design = thread::Thread { kind: thread::Kind::Design, ..thread::Thread::default() };
        let quiet = thread_sub(&worker, "needs you · ~45%".into());
        assert_eq!(quiet, format!("{QUIET_MARK}needs you · ~45%"));
        assert_eq!(thread_sub(&design, "needs you · blocked".into()), format!("{CLEAR_MARK}needs you · blocked"));
        assert_eq!(thread_sub(&design, String::new()), "", "no row");
        assert_eq!(thread_sub(&worker, "review · report".into()), "review · report", "review keeps its yellow");
        assert_eq!(thread_sub(&worker, "~40% · Writing tests".into()), "~40% · Writing tests");
        assert_eq!(first_match(&quiet), None, "dim, as the cell's base style");
        assert_eq!(first_match("~40% · Writing tests"), None);
        assert_eq!(first_match("review · report"), Some(("#f9e2af", false)));
        assert_eq!(first_match(&thread_sub(&design, "needs you · blocked".into())), Some(("#f38ba8", true)), "a design thread stays red");
        assert_eq!(first_match(&thread_sub(&design, "review · report".into())), Some(("#f9e2af", false)));
        assert_eq!(first_match(&thread_sub(&design, "~40% · Writing tests".into())), Some((CLEAR_COLOUR, false)));
    }

    /// The sub-line rules as Herdr applies them: the first `starts_with` that
    /// matches wins; `None` is the cell's dim base style.
    fn first_match(value: &str) -> Option<(&'static str, bool)> {
        sub_rules().into_iter().find(|(start, _, _)| value.starts_with(start.as_str())).map(|(_, colour, bold)| (colour, bold))
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
        let root = tempfile::tempdir().unwrap();
        let project = project::create(root.path(), "Projects Plugin", "", vec![]).unwrap();
        let design = thread::Thread { id: "t-0010".into(), title: "x".repeat(90), kind: thread::Kind::Design, ..thread::Thread::default() };
        let name = thread_display(&project, &design);
        assert_eq!(name, format!("{DESIGN_MARK}Projects Plugin · t-0010"));
        assert!(herdr_display(&name).starts_with(DESIGN_MARK));
        assert_eq!(design_label("design: otp"), format!("{DESIGN_MARK}design: otp"));
        assert_eq!(design_label(&design_label("design: otp")), design_label("design: otp"), "marked once");
    }

    #[test]
    fn a_threads_name_is_its_project_and_id_and_herdrs_cut_never_reaches_the_id() {
        let root = tempfile::tempdir().unwrap();
        let project = project::create(root.path(), "Projects Plugin", "", vec![]).unwrap();
        let worker = thread::Thread { id: "t-0014".into(), title: "Project name in thread titles".into(), kind: thread::Kind::Worktree, ..thread::Thread::default() };
        assert_eq!(thread_display(&project, &worker), "Projects Plugin · t-0014", "the title is the row below");
        let remote = thread::Thread { machine: "mini".into(), ..worker.clone() };
        assert!(remote.is_remote());
        assert_eq!(thread_display(&project, &remote), "Projects Plugin · t-0014 · Project name in thread titles", "no title row on another machine");
        // A name too long for Herdr's 80 characters is shortened; the id stays whole.
        let long = project::create(root.path(), &format!("Long {}", "n".repeat(100)), "", vec![]).unwrap();
        for kind in [thread::Kind::Worktree, thread::Kind::Design] {
            let t = thread::Thread { id: "t-0099".into(), kind, ..thread::Thread::default() };
            let name = thread_display(&long, &t);
            assert!(name.chars().count() <= 80, "{name}");
            assert!(herdr_display(&name).ends_with("… · t-0099"), "{name}");
        }
        // Without a readable PROJECT.md, the slug.
        let gone = project::Project { root: root.path().to_path_buf(), slug: "lost".into() };
        assert_eq!(thread_display(&gone, &worker), "lost · t-0014");
    }

    #[test]
    fn the_title_row_sits_between_the_name_and_the_sub_line_and_unconfigure_takes_it_out() {
        let spec = crate::sidebar::Spec { key: "prefix+a".into(), tab_command: "/bin/hp needs-you --line".into() };
        let configure = |text: &str| config_edit(&crate::sidebar::config_edit(text, &spec, false).unwrap(), &[], false).unwrap().0;
        let override_rows = "[ui.sidebar.agents.rows_by_agent]\nclaude = [[\"agent\"]]\n";
        let once = configure(override_rows);
        assert_eq!(configure(&once), once, "idempotent");
        let doc = once.parse::<DocumentMut>().unwrap();
        let tokens = |rows: &Item| -> Vec<String> { rows.as_array().unwrap().iter().map(|r| r.as_array().unwrap().iter().map(|c| c.as_str().map(str::to_string).unwrap_or_else(|| c.as_inline_table().unwrap().get("token").unwrap().as_str().unwrap().to_string())).collect::<Vec<_>>().join(",")).collect() };
        let sub = "$hp_pct,$hp_sub,$hp_work,$hp_rest";
        assert_eq!(tokens(&doc["ui"]["sidebar"]["agents"]["rows"]), ["state_icon,agent,state_text", "$hp_title", sub], "{once}");
        assert_eq!(tokens(&doc["ui"]["sidebar"]["agents"]["rows_by_agent"]["claude"]), ["agent", "$hp_title", sub], "{once}");
        // The title row has no style rule, so no key Herdr 0.9.3 would reject.
        assert!(once.contains("[{ token = \"$hp_title\" }]"), "{once}");
        // A title row the user moved is put back above the sub-line, once.
        let moved = once.replacen("[{ token = \"$hp_title\" }], ", "", 1).replacen("[\"state_icon\"", "[{ token = \"$hp_title\" }], [\"state_icon\"", 1);
        assert_eq!(tokens(&configure(&moved).parse::<DocumentMut>().unwrap()["ui"]["sidebar"]["agents"]["rows"]), ["state_icon,agent,state_text", "$hp_title", sub]);
        // A full card gets no title row rather than a config Herdr rejects.
        let full = format!("[ui.sidebar.agents]\nrows = [{}]\n", vec!["[\"agent\"]"; 15].join(","));
        let capped = configure(&full);
        assert!(!capped.contains("$hp_title") && capped.contains("$hp_sub"), "{capped}");
        // Unconfigure: ours first, then upstream's, which then puts Herdr's rows back.
        let (stripped, _) = config_edit(&once, &[], true).unwrap();
        assert!(!stripped.contains("$hp_title"), "{stripped}");
        let removed = crate::sidebar::config_edit(&stripped, &spec, true).unwrap();
        assert!(removed.parse::<DocumentMut>().unwrap()["ui"]["sidebar"]["agents"]["rows"].to_string().contains("\"machine\""), "{removed}");
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
