---
id: DIPO-34
title: Write planning changes through the backlog lane
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-22
  - DIPO-29
  - DIPO-31
references:
  - packages/engine/src/backlog/lane/
  - packages/engine/src/db/migrations/
  - packages/engine/test/backlog/lane/
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: high
type: feature
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: planning operations that belong to no story PR are journaled, applied through the Backlog CLI on an engine branch `dipo/backlog-<UTC timestamp>` in the `<root>/_backlog` worktree, committed as `backlog: <op> <ID>`, pushed, and rebuilt from the journal when the base moves.

Context: M0's only caller is office init (DIPO-36). Opening the backlog PR, the structural check and auto-merge are DIPO-35 (M0 breakdown decision D4, DIPO-15). References: 0010 section 2 (lane b, journal, rebuild, never force-push, pending-op skip, git queue ordering), section 2a step 1 (journal first); 0007 section 4 (`backlog_journal` states).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-34/write-planning-changes-through-backlog"
unknowns:
  - q: "Who opens and merges the backlog PR in M0?"
    status: "resolved"
    answer: "maintainer decision D4 of the M0 breakdown (2026-10-11, recorded in DIPO-15): the engine opens the backlog-lane PR and auto-merges it after its structural check, as 0010 decided; built in DIPO-35."
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) two operations produce two commits on one engine branch, pushed to the bare remote."
    - kind: "automated"
      check: "(integration) merge the branch on the remote; the next fetch drops the local changes."
    - kind: "automated"
      check: "(integration) a conflicting base change triggers a rebuild on a new branch name; the old branch is untouched."
    - kind: "automated"
      check: "(engine) crash after journaling replays the operation."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A migration adds `backlog_journal` with op id, key, op kind, target state, engine branch, state and PR ref.
- [ ] #2 An operation is journaled `pending` in one transaction before any CLI call, applied as target state, committed alone as `backlog: <op> <ID>`, then marked `committed` and `pushed`.
- [ ] #3 Later operations append to the open engine branch until its changes are on `origin/<base>`.
- [ ] #4 After a fetch that moves the base, a changed file whose blob equals the engine's blob is dropped as merged; otherwise the worktree resets to `origin/<base>` and unmerged operations are re-applied; an already pushed branch is replaced by a new branch name, never force-pushed.
- [ ] #5 An operation that no longer applies is marked `dropped` with an `engine.notice`.
- [ ] #6 `work.run` and the pickup re-check skip a story with a pending lane-b operation as `notRunnable` with the notice "pending backlog PR".
- [ ] #7 After a crash, open journal entries are replayed before any other git queue item.
- [ ] #8 Without a remote, the branch stays local and the engine reports what is waiting.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S19 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
