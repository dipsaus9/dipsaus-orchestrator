---
id: DIPO-58
title: Detect Done and tear down worktrees and branches
status: Done
assignee:
  - '@claude'
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 13:58'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-35
  - DIPO-38
  - DIPO-39
  - DIPO-46
  - DIPO-47
references:
  - packages/engine/src/worktree/teardown.ts
  - packages/engine/src/worktree/
  - packages/engine/test/worktree/
  - packages/engine/src/platform/host.ts
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: medium
type: feature
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after a story's PR merges, the engine detects Done from the host's PR state or from `git merge-tree`, closes the claim and run, removes the worktree, frees the slot, and deletes the local and remote branch.

Context: the host is reached through `platform/host.ts` (DIPO-35), polled at the office's `polling.prStateSeconds` (DIPO-26); `worker_notes` and `context_packs` come from DIPO-47 and DIPO-46 (M0 review, DIPO-15). References: 0010 section 7 ("Merge and Done", "Teardown", dirty worktree failure case), open question 8; 0007 section 7 (tier T rows deleted at teardown).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-58/detect-done-tear-down-worktrees-branches"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) squash-merge the branch on the bare remote; detection and teardown follow; a dirty worktree is kept with a notice."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 PR state is read through `platform/host.ts` every `polling.prStateSeconds` from office configuration.
- [x] #2 Done is detected from the host PR state, or when `git merge-tree --write-tree origin/<base> <branch>` returns the tree of `origin/<base>`, never by ancestry.
- [x] #3 Teardown unlocks and runs `git worktree remove` without `--force`; a dirty or locked worktree keeps everything and raises a notice listing the files.
- [x] #4 The local branch is force-deleted only after Done is detected, guarded on the judged tip (`update-ref -d`), then `git push origin --delete <branch>`; a missing remote branch is accepted.
- [x] #5 The slot is freed and `worker_notes` and `context_packs` for the worktree are deleted.
- [x] #6 Parked stories keep worktree, branch and slot.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S42 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

Maintainer decision (2026-10-13): a Parked story whose PR merged keeps worktree, branch and slot with a notice (parked wins).

Scope additions (files outside References):
- packages/daemon/src/foreground.ts: wires StoryTeardown into the daemon (its own GhHost on the daemon PATH, the <state>/slots.json SlotTable, load step after claims.feature, stopped on exit), so the Done poll runs every polling.prStateSeconds (AC #1).
- packages/engine/test/platform/host.test.ts: a test for the new GhHost.findMergedPr (gh pr list --head --state merged).
- packages/engine/src/db/migrations/0016-claim-teardown.ts: migration 16, column claims.teardown_started_at (no new table, so no retention policy line). DIPO-73 renumbers if it needs a migration.
- packages/engine/src/db/schema.ts: registers migration 16.

Where the ACs are met:
- AC #1: worktree/done.ts StoryTeardown arms a timer per office at polling.prStateSeconds of the configuration in force (re-read each interval); detection asks PrStateHost.findMergedPr (platform/host.ts, additive interface, GhHost implements it; CodeHost unchanged).
- AC #2: worktree/teardown.ts detectDone: a merged PR into the claim base whose head is the local tip (or the branch is gone), else git merge-tree --write-tree origin/<base> refs/heads/<branch> exit 0 whose tree equals origin/<base>^{tree}. No ancestry test. A branch still at its start SHA is never Done by merge-tree (it has nothing of its own).
- AC #3: tearDown unlocks only its own lock (dipo <run-id>), runs git worktree remove without --force; a refusal re-locks and keeps claim, branch, slot and tier T rows; a foreign lock is not touched; the teardown.kept notice lists the files git status reports, once per claim and cause.
- AC #4: DoneCheck carries the tip detection judged; tearDown re-reads refs/heads/<branch> in its queue item and keeps everything when it moved. After the worktree is gone the branch is force-deleted with git update-ref -d refs/heads/<branch> <judged tip> (branch -D without its race), its branch.<name> config section is removed (no section is fine), then git push <remote> --delete <branch>; remote ref does not exist is accepted, another failure is a teardown.remoteBranch notice.
- AC #5: after the git steps, one transaction releases the claim (reason done) and deletes worker_notes and context_packs of the worktree; then SlotTable.free.
- AC #6: a Done claim whose story status in its worktree is Parked keeps everything with a teardown.parked notice; an unreadable status keeps everything for that poll with a teardown.statusUnknown notice.

Notes:
- Migration 16 adds claims.teardown_started_at, set before the first destructive git step and cleared when the worktree is kept. A live claim with it set whose worktree and branch are both gone is finished on the next poll without the host; without it, a done.claimGone notice.
- No contract change: release_reason done fits claims; notice codes are engine.notice codes (teardown.done, teardown.kept, teardown.parked, teardown.statusUnknown, teardown.remoteBranch, done.checkFailed, done.unmergedCommits, done.claimGone), deduplicated per run and code and pruned when the claim is no longer live.
- A Done claim whose run still has a live worker host waits (notice once); DIPO-50 owns stopping runs.
- Tests: test/worktree/teardown.test.ts (fake git and host, fast); test/worktree/teardown.ci.test.ts (real squash merge on a bare remote, detection by merge-tree, teardown of worktree and both branches; dirty worktree kept with a notice, then torn down once clean).
<!-- SECTION:NOTES:END -->
