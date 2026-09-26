# Design folder

Written by herdr-projects once; edit it freely, it is never overwritten.

This folder holds the project's glossary, context map and decision records, shared by every design thread of the project. An agent working here is a design thread: its brief (`.herdr-project/<slug>-<id>/brief.md`) says what to do. Implementation threads read this folder and never write to it.

- `repos/<name>` links to each local repository's main checkout. Read code through these links; never write under `repos/`.
- Search inside a link (`repos/<name>/src`), not from this folder's root: ripgrep does not follow symlinks while traversing.
- Other design threads may work here at the same time. Re-read a file right before you change it.

## Agent skills

### Issue tracker

Local markdown under `.scratch/`, handed to the herdr-projects coordinator. See `docs/agents/issue-tracker.md`.

### Domain docs

Multi-context, one context per repository, even when there is only one. See `docs/agents/domain.md`.
