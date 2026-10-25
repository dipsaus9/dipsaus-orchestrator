# 0003 Milestones and quality bar

Status: accepted. First written 2026-10-09. Rewritten 2026-10-24 after the simplification audit (`docs/research/2026-10-24-simplification-audit.md`).

## Quality bar

This is a long-lived project, not a proof of concept.

- Architecture is decided in an ADR before the code it governs.
- Each milestone is production quality for its scope. A narrow scope is fine; throwaway code is not.
- A shortcut is allowed only when it is recorded as debt, with a reason.
- Tests and a verify command exist from the first line of code.

## How the design stays small

The project grew to about 137k source lines in 15 days, with up to 40 amendments per ADR. These rules keep that from happening again.

1. **Build at the milestone, not before.** Code for a later milestone, or infrastructure no current flow uses, is not built. Ideas for later go into the milestone list below, not into the code.
2. **Delete before adding.** A story that fixes a gap names the mechanism it replaces and removes it. A story that only adds a mechanism beside an existing one for the same goal fails review.
3. **One mechanism per goal** (0001, principle 8). Before a new state, vocabulary, table, config key or command is added, the story shows that no existing one serves the goal.
4. **ADRs describe what runs.** A changed decision rewrites the ADR body. The ADR keeps a short "Replaced" list, one line per earlier decision and why it went. There is no amendment log; git keeps the history.
5. **Code cites ADRs by number only,** never by section, so rewriting an ADR never leaves comments stale.

## Milestones

- **M0, walking skeleton.** Done. Engine, daemon, database, Claude CLI adapter, minimal TUI, office init and switching, repository scan, caps, tiers and parking. Cutover (DIPO-115): dipo delivers its own stories since then.
- **M1, review and park.** The story PR, a reviewer session, one feedback loop for review, CI and conflicts, merge on approval, resume for every park reason, the maintainer's commands (park, resume, drop, discard, steer, answer, approve, reject), and `dipo desk`. Then the triage view in the TUI, `dipo test` in a test box, the scan's AI fallback with its confirm command, and daily and monthly spend alerts. Stories carry `slice:m1a` for the unattended loop and `slice:m1b` for the rest.
- **M2, parallel runs.** Several stories at once, each in its own box, started by a pickup loop of dipo's own instead of one `dipo run` per story. Batch selection, collision checks on changed files, and GitHub's merge queue if merge order starts to matter.
- **M3, rituals.** `plan`, `refine`, `ready` and `estimate` with model interviews, including the tier proposal. `retro` with insights from the database: park reasons, loops and cost per kind of work.
- **M4, roster.** Roles as stored definitions, hiring, a role chosen per story, non-code roles, and the skills and plugins each role brings to its sessions.
- **M5, conversation.** A conversation layer that maps the maintainer's words to commands, with confirmation.

Until M3, stories are written by hand or with the `dipsaus-ai` skills. Until M4 there is one developer role plus the reviewer.

**Later, with no milestone yet:**

- a codegraph context backend measured against the default;
- a Linux box backend;
- a declared "online" presence for live questions;
- a web or desktop client;
- another story tracker, such as Jira, behind the `StoryStore` seam (0010);
- an experiment: a full plan written in the story, against a planning session by the worker before Build, measured against each other.

## Current state

M1 is paused since 2026-10-24. The code is first pruned toward the rewritten ADRs, following a plan the maintainer and Claude make together.

How dipo is built during the prune (maintainer, 2026-10-24):

1. **Track 1, the run path,** is built by builder agents from the maintainer's orchestrating Claude session. These are the stories dipo needs to deliver one story the new way: the claim without a worktree, verify in the box, the reviewer box, one feedback path, GitHub auto-merge, one git module. A separate agent reviews each PR, and a scratch-repository run checks each story.
2. **The cutover gate:** dipo delivers one real story of this repository end to end on the simplified path, and the maintainer confirms it.
3. **Track 2, everything else,** is built by dipo itself, one story at a time. The orchestrating Claude starts the runs, answers worker questions and files every gap a run shows as a story.

The prune stories sit in M1 with the labels `slice:prune` and `track:1` or `track:2`. The cutover gate is DIPO-351, and every Track 2 story depends on it.

In both tracks dipo runs from a pinned binary that is upgraded only after a smoke run of the new build, every story names what it removes, and an ADR is rewritten in the same PR as the change it decides.

## Rationale

The riskiest unknowns were in the execution engine: the daemon, the worker adapter and the boundary between engine and UI. Proving those first meant no ritual UI was built on an engine that did not hold up.

## Replaced

- "Nothing planned for M0 is deferred" (2026-10-12). It pulled pricing catalogs, restore and purge, and an autostart supervisor into the walking skeleton. Replaced by "build at the milestone, not before".
- An amendment log in every ADR. Replaced by rewriting the body plus a "Replaced" list (2026-10-24), because the bodies had stopped describing what runs.
- M1 items that are now implementation details or later work: send-once feedback signatures, evidence on feedback, affected-files test selection and the codegraph backend (moved to Later).
- M2 items for Mac worktrees (worktree locking, push serialisation, worktrees prepared during batch confirmation). The box replaced the Mac worktree.
