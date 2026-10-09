# dipsaus-orchestrator

Open source software that orchestrates AI coding agents like a team lead. Read `docs/vision.md` and `docs/decisions/` before making design choices.

## Status

Pre-code. Stack not chosen. Only vision and decisions exist.

## Rules

- Anything deterministic is code, never prose for a model to follow.
- Engine is headless. UIs are clients that send commands and read events. No UI imports engine internals.
- Backlog.md/CLI is the source of truth for stories. Never edit task files by hand when the CLI can do it.
- Local state database is per project, gitignored, and never the only copy of a story fact.
- Claude is reached only through the worker adapter. Keep Claude specifics out of the engine.
- Decisions that change `docs/decisions/` need the user's explicit approval. Ask when unsure.

## Git

- Early bootstrap commits may go to `main`. After the initial backlog exists, work on `<ID>/<slug>` branches and merge by PR.
- Commits are small and scoped. Never `git add -A`. Never skip hooks.
