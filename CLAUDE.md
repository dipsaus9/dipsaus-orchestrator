# dipsaus-orchestrator

Open source software that orchestrates AI coding agents like a team lead. Read `docs/vision.md` and `docs/decisions/` before making design choices.

## Status

Pre-code. Stack not chosen. Vision, decisions and architecture spikes (DIPO-1 to DIPO-7) exist.

## Rules

- Anything deterministic is code, never prose for a model to follow.
- Engine is headless. UIs are clients that send commands and read events. No UI imports engine internals.
- Backlog.md/CLI is the source of truth for stories. Never edit task files by hand when the CLI can do it.
- Local state database is per project, gitignored, and never the only copy of a story fact.
- Claude is reached only through the worker adapter. Keep Claude specifics out of the engine.
- Decisions that change `docs/decisions/` need the user's explicit approval. Ask when unsure.

## Backlog

- Prefix `DIPO`. Milestones `m-0` to `m-3` are M0 to M3 (see `docs/decisions/0003-milestones-and-quality-bar.md`). Backlog.md has no epic type, so milestones play that role.
- Architecture spikes (`--type spike`) each end in an ADR in `docs/decisions/`. Implementation stories are written after the spikes resolve.
- `auto_commit` is off. Commit backlog changes yourself.

## Review

- Every PR is reviewed by a separate agent against the story goal before merge. Fix its feedback, then merge. The maintainer tests behavior and does not review code. See `docs/decisions/0002-review-and-testing.md`.

## Git

- Early bootstrap commits may go to `main`. After the initial backlog exists, work on `<ID>/<slug>` branches and merge by PR.
- Commits are small and scoped. Never `git add -A`. Never skip hooks.
