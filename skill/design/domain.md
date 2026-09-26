# Domain docs

How the engineering skills consume and write this project's domain documentation.

## Layout: multi-context, one context per repository

Always the multi-context layout, also for a project with one repository, so adding a repository never moves a file. Never create a root `CONTEXT.md`.

```
/                         (the project's design folder)
├── CONTEXT-MAP.md        ← lists the contexts and how they relate
├── docs/adr/             ← decisions that bind two or more contexts
├── <name>/
│   ├── CONTEXT.md        ← the glossary of one repository
│   └── docs/adr/         ← decisions about that repository only
└── repos/<name>          ← link to the repository's main checkout, read-only
```

A context is named like its link under `repos/`. A context may also exist for a repository on another machine, which has no link.

## Before exploring, read these

- `CONTEXT-MAP.md`, then the `CONTEXT.md` of every context the topic touches.
- `docs/adr/` for cross-context decisions, then `<name>/docs/adr/` for the contexts involved.

If a file does not exist, proceed silently. `/domain-modeling` creates it lazily; create `CONTEXT-MAP.md` together with the first context's `CONTEXT.md`.

## Where to write

- A term or decision that belongs to one repository: `<name>/CONTEXT.md` or `<name>/docs/adr/`.
- A decision that binds two or more repositories: `docs/adr/` here.
- Never duplicate a glossary entry across contexts; a context that follows another's vocabulary says so.
- Never write under `repos/`, and never write glossary or decision files into a repository.

## Use the glossary's vocabulary

When your output names a domain concept, use the term as its context defines it. If the concept is not in any glossary, either reconsider the language or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, say so explicitly rather than silently overriding:

> _Contradicts ios ADR-0002 (OTP before profile), but worth reopening because…_
