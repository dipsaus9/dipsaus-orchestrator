---
id: DIPO-32
title: Index office stories with stable story keys
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
  - packages/engine/src/stories/
  - packages/engine/src/db/migrations/
  - packages/engine/test/stories/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: high
type: feature
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when an office loads and before each pickup, the engine reads every task and draft from the `_base` worktree through the Backlog CLI, gives each story a stable `StoryKey`, keeps a `backlog_mirror` cache, and emits `story.state` and `story.renumbered` events for what changed.

Context: this is the read side of reconcile needed for M0 runs; the full mismatch table with claims, parks and runs is DIPO-56. References: 0005 section 2 (StoryKey, identity checks, renumbering, Removed observed by reconcile); 0007 sections 4 (`stories`, `story_aliases`, `backlog_mirror`), 6 step 3; 0010 section 2 (reads for `run` from `_base`), section 6 (archived and completed not active).

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
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A migration adds `backlog_mirror` with content hash, status, tier, role, labels, read time and source.
- [ ] #2 A story first seen gets `sto_<ulid>`; a known id is matched by key, then frozen branch, then created date; a title change alone keeps the key.
- [ ] #3 A vanished id matched to a new id emits `story.renumbered { detectedBy: "reconcile" }`; an unmatched known key is closed as `Removed` with an `engine.notice`.
- [ ] #4 A changed status emits `story.state` with `from`, `to` and the derived `StoryView`.
- [ ] #5 Archived, completed and draft-folder files are not active tasks.
- [ ] #6 Indexing runs at office load, on `office.rescan` and before each `work.run`, and writes all changes of one pass in one transaction.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S17 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
