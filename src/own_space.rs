//! Threads that open in a Space of their own without a worktree: tab threads
//! in `threads/<id>/`, design threads in the design folder. The sidebar puts
//! each Space in the project's block; it closes with the thread's tab, its
//! only one.
//!
//! A checkout thread stays a tab of the project workspace. A Space whose
//! folder is a repo's main checkout is the one Herdr (0.9.3) adopts as that
//! repo's primary Space at the next `worktree create`; closing its last tab
//! would then be refused (`confirmation_required`), or with `confirm_close`
//! off close every worktree thread's Space in the group with it.

use std::path::Path;

use crate::herdr::Pane;
use crate::project::Project;
use crate::thread::{self, Kind, Status, Thread};

/// Whether a new thread of `kind` gets its own Space without a worktree.
pub fn applies(kind: Kind) -> bool {
    matches!(kind, Kind::Tab | Kind::Design)
}

/// A new Space's label: the thread's title, a design thread's with
/// [`crate::views::DESIGN_MARK`] in front.
pub fn label(record: &Thread) -> String {
    if record.kind == Kind::Design { crate::views::design_label(&record.title) } else { record.title.clone() }
}

/// Placed in its own Space, not as a tab of the home Space (as tab threads
/// started before own Spaces still are).
pub fn has_own(project: &Project, t: &Thread) -> bool {
    let home = project.coordinator().map(|c| c.workspace_id).unwrap_or_default();
    applies(t.kind) && !t.workspace_id.is_empty() && t.workspace_id != home
}

/// The open Spaces of the project's unresolved local threads placed in one,
/// as `(workspace id, what)`: a listed pane of the Space still works in the
/// thread's folder (ids repeat after a server restart).
pub fn spaces(project: &Project, panes: &[Pane]) -> Vec<(String, String)> {
    thread::list(project)
        .into_iter()
        .filter(|t| t.status != Status::Resolved && !t.is_remote() && has_own(project, t))
        .filter(|t| panes.iter().any(|p| p.workspace_id == t.workspace_id && Path::new(&p.cwd) == Path::new(&t.cwd)))
        .map(|t| (t.workspace_id.clone(), format!("{}'s Space", t.id)))
        .collect()
}
