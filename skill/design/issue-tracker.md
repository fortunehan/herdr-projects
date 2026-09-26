# Issue tracker: local markdown, handed to herdr-projects threads

Specs and tickets live as markdown files in `.scratch/` in this folder. They are the hand-off to the herdr-projects coordinator: each ticket becomes the task of one implementation thread.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Tickets are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order, never a single combined file
- Near the top of each ticket:
  - `Repo:` the short name of the repository the thread works in (a name under `repos/`), or `none`
  - `Blocked by:` the numbers of the tickets that must land first, or `none`
  - `Status:` `ready-for-agent`
  - `Profile:` (optional) the herdr-projects profile to run the thread with; omit for the project default
  - `ADO:` (optional) the work item id
- Point at glossary terms and decision records by absolute path: implementation threads run in worktrees elsewhere.
- Comments append at the bottom under `## Comments`

## When a skill says "publish to the issue tracker"

Create the files under `.scratch/<feature-slug>/`.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path.

## Hand-off to the coordinator

The design thread names the feature directory in its report. Ticket files are not edited after that: the coordinator tracks their progress in the project's task list.
