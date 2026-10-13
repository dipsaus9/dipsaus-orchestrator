---
id: DIPO-34
title: Write planning changes through the backlog lane
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 06:37'
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
  - packages/engine/src/features.ts
  - packages/daemon/src/foreground.ts
  - packages/engine/src/index.ts
  - packages/engine/src/db/schema.ts
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

Context: M0's only caller is office init (DIPO-36). Opening the backlog PR, the structural check and auto-merge are DIPO-35 and DIPO-73 (M0 breakdown decision D4, DIPO-15). The run skip is exposed as a predicate that DIPO-48 uses, because `work.run` does not exist yet (M0 review, DIPO-15). References: 0010 section 2 (lane b, journal, rebuild, never force-push, pending-op skip, git queue ordering), section 2a step 1 (journal first); 0007 section 4 (`backlog_journal` states).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

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
    - kind: "automated"
      check: "(engine) `pendingLaneOp` is true for the story from journaling until its entry is marked merged or dropped."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A migration adds `backlog_journal` with op id, key, op kind, target state, engine branch, state and PR ref.
- [x] #2 An operation is journaled `pending` in one transaction before any CLI call, applied as target state, committed alone as `backlog: <op> <ID>`, then marked `committed` and `pushed`.
- [x] #3 Later operations append to the open engine branch until its changes are on `origin/<base>`.
- [x] #4 After a fetch that moves the base, a changed file whose blob equals the engine's blob is dropped as merged; otherwise the worktree resets to `origin/<base>` and unmerged operations are re-applied; an already pushed branch is replaced by a new branch name, never force-pushed.
- [x] #5 An operation that no longer applies is marked `dropped` with an `engine.notice`.
- [x] #6 `pendingLaneOp(office, key)` reports a story with a pending lane-b operation, with the notice text "pending backlog PR", from journaling until the entry is merged or dropped; `work.run` and the pickup re-check (DIPO-48) skip such a story as `notRunnable`.
- [x] #7 After a crash, open journal entries are replayed by an office load step (DIPO-27 seam) before any other git queue item.
- [x] #8 Without a remote, the branch stays local and the engine reports what is waiting.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S19 (DIPO-15). Before cutover: built by hand-run agents.

Added refs: packages/daemon/src/foreground.ts, because the lane's journal-replay load step needs the office's OfficeGit, which the git.version load step attaches; the daemon registers engineGit.feature after FEATURES, so the lane feature is registered right after it there. packages/engine/src/index.ts, to export the lane from the engine package entry.

Added ref packages/engine/src/db/schema.ts: the migration list that registers migration 5.

Implementation (packages/engine/src/backlog/lane/):
- Migration 5 `backlog_journal`: op id (per-office sequence, so journal order is apply order), key (null for office-wide ops), subject (the ID in the commit message), op kind, target JSON, branch, state (the seven 0007 states, CHECK), commit sha, PR ref, notice, created/updated/closed times.
- `OfficeLane.journal` runs the live-claim check and the pending insert in one git queue item and one transaction, before any CLI call. `flush` runs `OfficeGit.fetch` (when the office has a remote) and then one queue item that does every CLI write (status, writeFields, editLabels) and git step: merged check, rebuild, apply, commit `backlog: <op> <ID>`, push. Tests assert every CLI call runs inside a queue item and a concurrently queued item waits for the flush.
- Merged check: an op is merged when every file its commit changed has on the base the blob the branch tip holds. All merged: branch closed (worktree detached at base, local branch deleted). Some merged, or `git merge-tree --write-tree` conflicts: rebuild on a new branch name (`-2` suffix within the same second), old branch untouched, never force-pushed. Base moved without conflict: keep appending.
- Built-in kind `edit` (status, field-block keys, labels, optional `from` statuses); `editKind(name)` and `BacklogLane.register` let DIPO-36 and later stories add kinds. An op that no longer applies (story gone, status not in `from`, R02 block) is dropped with an engine.notice; one whose target state already holds is closed as merged (on the base) or dropped with an info notice (on the open branch).
- Each commit carries a `Dipo-Op: <op id>` trailer so a commit made just before a crash is found again instead of applied twice.
- `pendingLaneOp(office, key)` returns { reason: notRunnable, notice: "pending backlog PR", ops } while an entry is pending/applied/committed/pushed. `recordPrRef` is the hook for DIPO-35.
- Load step `backlog.lane.replay` (registered in the daemon right after engineGit.feature) replays open entries before any other queue item; a failure is an engine.notice and the office still loads.
- Without a remote the branch stays local; `waiting()` and the flush report name the branch and commits, and a `backlog.lane.waiting` notice is emitted.
<!-- SECTION:NOTES:END -->
