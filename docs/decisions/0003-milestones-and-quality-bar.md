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

- **M0, walking skeleton.** Engine, daemon, local database, Claude CLI adapter and a minimal TUI. Office init and switching (the office list). Repository scan and rescan for run knowledge. Context provider interface with the default provider (story scope, inputs, component map when present) and budgets by project size (research ideas 23 and 26). Takes one Ready story from Backlog.md, creates the worktree and branch, runs a worker, runs verify and shows live output. No planning, review or parallelism. Proves the core loop and the engine/UI boundary.
- **M1, review and park.** Reviewer bot, structured park reasons, morning triage view, caps. Difficulty tiers mapped to model and budget. The test-story command with pass or fail feedback. A mechanical feedback loop for CI, review and conflicts, daily and monthly spend alerts, feedback that carries evidence, and send-once signatures with review keyed on commit, an optional codegraph context backend measured against the baseline with stale-index detection, and affected-files test selection when a backend offers it (research ideas 5, 6, 14, 17, 24, 25, 27 and 28, see `docs/research/2026-10-comparable-tools.md`).
- **M2, parallel runs.** Batch selection, collision checks (using the declared component map when present, research idea 18), worktree locking, push serialization, worktrees prepared while a batch is being confirmed (idea 22).
- **M3, rituals.** `plan`, `refine`, `ready` and `estimate` (with tier proposal) with Claude interview sessions. `retro` and insights: park reasons, loops, usage and cost efficiency aggregated from the local database, with suggestions for better preparation.
- **M4, roster.** Roles as stored definitions, hiring, role chosen per story, non-code roles.
- **M5, conversation.** Conversation layer that maps the maintainer's words to commands, with confirmation.

Until M3, stories are written by hand or with the existing `dipsaus-ai` skills. Until M4 there is one built-in developer role.

Amended 2026-10-09 after decision 0011 (office model): office basics added to M0, tiers and test command to M1, estimate to M3, and new milestones M4 and M5.

## Rationale

The riskiest unknowns are in the execution engine: the daemon, the worker adapter and the UI/engine boundary. Proving those first avoids building ritual UI on an engine that does not hold up. The TUI in M0 addresses the visual gap early.

## Amendments

- 2026-10-11, M0 story breakdown (maintainer): caps (token budget, turns, time) and parking a story with a reason move from M1 to M0. The triage view and resuming parked stories stay in M1.
- 2026-10-11, M0 story breakdown (maintainer): draft promotion moves to M3.
- 2026-10-11, M0 story breakdown (maintainer): the M0 repository scan is code only, and `run` refuses an office whose verify is unresolved, with a message naming the script to add. The scan's AI fallback and the confirm command move to M1.
- 2026-10-11, M0 story breakdown (maintainer): cutover comes after DIPO-55; dipo delivers the remaining M0 stories, DIPO-56 to DIPO-67, itself. `v0.1.0` follows once DIPO-66 (release pipeline) lands and the maintainer's live smoke run passes.
- 2026-10-12, M0 story breakdown (maintainer): as an explicit exception to the 2026-10-11 line on caps and parks, answering a permission park with allow once or deny (`work.answer`, `dipo answer`) stays in M0. It resumes only a story parked `needs-permission`; every other resume of a parked story stays in M1.
- 2026-10-12, M0 review (maintainer): reconcile at daemon start (DIPO-56) and re-attaching worker hosts after a daemon restart (DIPO-57) move before cutover. Cutover now needs DIPO-16 to DIPO-57 Done, together with the stories split from them during the M0 review (DIPO-68 to DIPO-74). dipo delivers DIPO-58 to DIPO-67 and the stories split from them (DIPO-75, DIPO-76) itself. This replaces the cutover point of the 2026-10-11 line; the `v0.1.0` rule is unchanged.
- 2026-10-12, M0 review (maintainer): nothing planned for M0 is deferred. Pricing, nudges, restore and purge, and autostart stay in M0; a story that is too big is split instead.
