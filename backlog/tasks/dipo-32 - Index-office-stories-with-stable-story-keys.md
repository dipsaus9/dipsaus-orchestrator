---
id: DIPO-32
title: Index office stories with stable story keys
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:29'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-22
  - DIPO-29
  - DIPO-31
references:
  - packages/engine/src/stories/
  - packages/engine/src/db/migrations/
  - packages/engine/test/stories/
  - packages/engine/src/views/
  - packages/engine/src/features.ts
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0009-tui.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: high
type: feature
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when an office loads and before each pickup, the engine reads every task and draft from the `_base` worktree through the Backlog CLI, gives each story a stable `StoryKey`, keeps a `backlog_mirror` cache, and emits `story.state` and `story.renumbered` events for what changed.

Context: this is the read side of reconcile needed for M0 runs; the full mismatch table with claims, parks and runs is DIPO-56. The minimal story view and office summary live here so events and `engine.hello` carry real views from the first indexed story; DIPO-52 adds waiting-on, gate messages, work views and health (M0 review, DIPO-15). A periodic fetch every `polling.fetchSeconds` (office configuration, DIPO-26) lets a story set Ready on the remote be seen without a manual rescan. References: 0009 section 3 (columns); 0005 section 2 (StoryKey, identity checks, renumbering, Removed observed by reconcile); 0007 sections 4 (`stories`, `story_aliases`, `backlog_mirror`), 6 step 3; 0010 section 2 (reads for `run` from `_base`), section 6 (archived and completed not active).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-32/index-office-stories-stable-story-keys"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) index the Backlog fixture; keys stable across two passes; a retitled task keeps its key."
    - kind: "automated"
      check: "(engine) archive a task through the CLI; next pass emits `Removed` and a notice."
    - kind: "automated"
      check: "(engine) a hand-promoted draft is matched and emits `story.renumbered`."
    - kind: "automated"
      check: "(engine) two vanished stories with the same created date and no other match give `story.ambiguous` and a notice, and neither key is reassigned."
    - kind: "automated"
      check: "(unit) minimal story view column for each lifecycle; office summary counts per column."
    - kind: "automated"
      check: "(engine) on the manual clock, a status change pushed to the bare remote is indexed after `polling.fetchSeconds`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A migration adds `backlog_mirror` with content hash, status, tier, role, labels, read time and source.
- [ ] #2 A story first seen gets `sto_<ulid>`; a known id is matched by key, then frozen branch, then created date; a title change alone keeps the key.
- [ ] #3 The created date is stored as the raw string the CLI prints; when the created-date fallback matches more than one story, the pass reports `story.ambiguous` with an `engine.notice` and matches none of them.
- [ ] #4 A vanished id matched to a new id emits `story.renumbered { detectedBy: "reconcile" }`; an unmatched known key is closed as `Removed` with an `engine.notice`.
- [ ] #5 A changed status emits `story.state` with `from`, `to` and the derived `StoryView`.
- [ ] #6 Archived, completed and draft-folder files are not active tasks.
- [ ] #7 A minimal `deriveStoryView` (key, id, title, lifecycle, tier and a column from the lifecycle alone) and `OfficeSummary` (stories per column, active runs) are registered as the view and summary source that `engine.hello` and the change log use; DIPO-52 extends them.
- [ ] #8 `indexStories(office)` runs as an office load step (DIPO-27 seam), after every fetch done every `polling.fetchSeconds`, and when `office.rescan` (DIPO-72) and `work.run` (DIPO-48) call it; it writes all changes of one pass in one transaction.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S17 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
