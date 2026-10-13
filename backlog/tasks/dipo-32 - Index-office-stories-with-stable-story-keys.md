---
id: DIPO-32
title: Index office stories with stable story keys
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 07:11'
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
  - packages/engine/src/db/schema.ts
  - packages/engine/src/index.ts
  - packages/daemon/src/foreground.ts
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

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

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
- [x] #1 A migration adds `backlog_mirror` with content hash, status, tier, role, labels, read time and source.
- [x] #2 A story first seen gets `sto_<ulid>`; a known id is matched by key, then frozen branch, then created date; a title change alone keeps the key.
- [x] #3 The created date is stored as the raw string the CLI prints; when the created-date fallback matches more than one story, the pass reports `story.ambiguous` with an `engine.notice` and matches none of them.
- [x] #4 A vanished id matched to a new id emits `story.renumbered { detectedBy: "reconcile" }`; an unmatched known key is closed as `Removed` with an `engine.notice`.
- [x] #5 A changed status emits `story.state` with `from`, `to` and the derived `StoryView`.
- [x] #6 Archived, completed and draft-folder files are not active tasks.
- [x] #7 A minimal `deriveStoryView` (key, id, title, lifecycle, tier and a column from the lifecycle alone) and `OfficeSummary` (stories per column, active runs) are registered as the view and summary source that `engine.hello` and the change log use; DIPO-52 extends them.
- [x] #8 `indexStories(office)` runs as an office load step (DIPO-27 seam), after every fetch done every `polling.fetchSeconds`, and when `office.rescan` (DIPO-72) and `work.run` (DIPO-48) call it; it writes all changes of one pass in one transaction.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S17 (DIPO-15). Before cutover: built by hand-run agents.

Refs added: packages/engine/src/db/schema.ts lists the new backlog_mirror migration; packages/engine/src/index.ts exports the story index and the view and summary sources; packages/daemon/src/foreground.ts registers the story index after the git load step and replaces noOfficeSummaries with the real OfficeSummary source (AC #7).

Implementation (DIPO-32):
- Migration 5 adds backlog_mirror (content hash, kind, status, title, tier, role, labels JSON, read time, source), one row per key, overwritten each pass.
- stories/read.ts reads task list, draft list and each view in _base through the CLI (4 views at a time). The content hash is sha256 of the view without its File: line. A failed list or view stops the pass, so a partial read never closes keys; a view that fails R02 keeps the story with what the list printed.
- stories/apply.ts matches identity: a current id keeps its key unless its frozen branch, else its created date, differs (a title change is an edit); vanished keys match new ids by frozen branch, then created date; a created date shared by more than one vanished story or new id is story.ambiguous (engine.notice) and matches none; unmatched keys close as Removed with story.state and an engine.notice. Renumbering moves ids in two phases, so swaps and chains do not hit the current-id index.
- story.state is emitted when the derived view changes: a status change (from, to, view), a new story (from = to), and a title, tier or id change (from = to).
- indexStories reads _base as one item of the office git queue and writes the pass with its change-log entries in one transaction. StoryIndex registers the stories.index load step (fetch when the remote answers, then index; an office whose stories cannot be read still loads, with a stories.notIndexed notice) and polls every polling.fetchSeconds, indexing when _base is at a commit no pass read yet. A forgotten office stops polling. office.rescan (DIPO-72) and work.run (DIPO-48) call StoryIndex.indexStories(office).
- views/: deriveStoryView with the column from the lifecycle alone (Parked is desk, Removed is the open-enum value removed); officeSummarySource (running = runs with a live worker host, parked and waitingOnMaintainer = desk, onHold = held) replaces noOfficeSummaries for engine.hello and the software stream.
- Found while testing: backlog task archive fails (exit 1, no reason) when backlog/archive/tasks does not exist; story.drop (DIPO-34) will need to create it.

Review fixes (PR #61): the load step's fetch now runs inside the try, so an office whose fetch or Backlog CLI fails still loads with a stories.notIndexed notice (tested with a failing CLI). A key closed as Removed with no prior view takes its from-lifecycle from the stories row (provisional id → Draft, else Refined).

Follow-ups:
- DIPO-52: the office summary counts per column, including the 'removed' column; decide whether removed stories count or drop out of the summary.
- Batch-created stories sharing a created minute (Backlog.md dates have minute precision) will often be judged ambiguous and close as Removed with new keys; DIPO-56 may add a tiebreak (for example title or content hash).
- Each pass reads every story through a per-story Backlog CLI view (one process per story); cost grows with the backlog size and may need a bulk read later.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Story index: migration 6 backlog_mirror; on office load and on a poll when _base moved the engine reads every task and draft from _base through the Backlog CLI inside one git queue item, matches stable story keys by current id, frozen branch and created date (ambiguous dates give story.ambiguous and new keys), emits story.renumbered and story.state with the derived StoryView, closes vanished keys as Removed, and serves real office summaries to engine.hello; the office still loads with stories.notIndexed when reading fails. Load order git.version, lane replay, stories.index. Reviewer pass.
<!-- SECTION:FINAL_SUMMARY:END -->
