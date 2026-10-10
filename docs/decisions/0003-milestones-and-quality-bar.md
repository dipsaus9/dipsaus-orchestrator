# 0003 Milestones and quality bar

Status: accepted (grill session, 2026-10-09).

## Quality bar

This is a long-lived project, not a proof of concept. Fast results are not expected.

- Architecture is planned and documented as decision records before the code it governs.
- Each milestone is production-quality for its scope. Narrow scope is acceptable, throwaway code is not.
- Shortcuts are allowed only when recorded as explicit debt with a reason.
- Tests and a verify command exist from the first line of code.
- Stack, daemon transport, database schema, worker adapter contract and TUI framework are decided in dedicated architecture sessions, each recorded in `docs/decisions/`.

## Milestones

- **M0, walking skeleton.** Engine, daemon, local database, Claude CLI adapter and a minimal TUI. Office init and switching (the office list). Repository scan and rescan for run knowledge. Takes one Ready story from Backlog.md, creates the worktree and branch, runs a worker, runs verify and shows live output. No planning, review or parallelism. Proves the core loop and the engine/UI boundary.
- **M1, review and park.** Reviewer bot, structured park reasons, morning triage view, caps. Difficulty tiers mapped to model and budget. The test-story command with pass or fail feedback. A mechanical feedback loop for CI, review and conflicts, and daily and monthly spend alerts (research ideas 5 and 6, see `docs/research/2026-10-comparable-tools.md`).
- **M2, parallel runs.** Batch selection, collision checks, worktree locking, push serialization.
- **M3, rituals.** `plan`, `refine`, `ready` and `estimate` (with tier proposal) with Claude interview sessions. `retro` and insights: park reasons, loops, usage and cost efficiency aggregated from the local database, with suggestions for better preparation.
- **M4, roster.** Roles as stored definitions, hiring, role chosen per story, non-code roles.
- **M5, conversation.** Conversation layer that maps the maintainer's words to commands, with confirmation.

Until M3, stories are written by hand or with the existing `dipsaus-ai` skills. Until M4 there is one built-in developer role.

Amended 2026-10-09 after decision 0011 (office model): office basics added to M0, tiers and test command to M1, estimate to M3, and new milestones M4 and M5.

## Rationale

The riskiest unknowns are in the execution engine: the daemon, the worker adapter and the UI/engine boundary. Proving those first avoids building ritual UI on an engine that does not hold up. The TUI in M0 addresses the visual gap early.
