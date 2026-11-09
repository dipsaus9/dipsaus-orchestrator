---
id: DIPO-468
title: A story whose PR merges while it is parked becomes Done
status: Refined
assignee: []
created_date: '2026-11-09 17:56'
labels:
  - 'tier:L'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/worktree/done-check.ts
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/worktree/teardown.ts
  - packages/engine/src/run-state/park-records.ts
  - packages/engine/src/records/story-prs.ts
  - packages/engine/src/run/next-up.ts
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/backlog/lane/ops.ts
  - packages/engine/src/backlog/pr/check.ts
  - packages/engine/src/platform/host.ts
  - packages/engine/src/overview/desk.ts
  - scripts/check-backlog-pr.ts
  - packages/engine/test/worktree/teardown.test.ts
  - packages/engine/test/worktree/done-check.test.ts
  - packages/engine/test/backlog/pr/check.test.ts
  - scripts/check-backlog-pr.test.ts
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0020-park-and-resume.md
priority: high
type: bug
ordinal: 441000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a story whose PR merged while dipo's run for it was parked to end Done by itself, so that merged work never stays parked on my desk and the stories that depend on it can start.

M3 (maintainer's choice, 2026-11-09). Two triggers:

- DIPO-460: after the maintainer approved its merge gate, a CI fix round ran (a cancelled check read as red), its box verify went red 5 times, and dipo parked the story and pushed "status Parked" to the story branch. GitHub's auto-merge then merged PR #634 with that commit. main now says DIPO-460 is Parked, dipo's desk keeps the park, and DIPO-461, which depends on DIPO-460, can never start. A backlog PR that set DIPO-460 to Done (#637) was refused by the backlog PR check: "DIPO-460 moves from Parked to Done, which a backlog PR may not do (0012)". That rule is right in general and stays closed for everyone else.
- DIPO-463: a builder finished the story on dipo's branch and PR #626 merged it (main says Done), but dipo's run stayed parked on the desk and only `dipo discard` cleared it.

Today the one Done check (packages/engine/src/worktree/done-check.ts) answers merged for the claim's PR, but the Done poll (packages/engine/src/worktree/done.ts, `#merged`) reads the story's status on its branch and, when it is Parked, keeps the claim with the `teardown.parked` notice (packages/engine/src/worktree/teardown.ts) and asks the maintainer to resolve the park. `claimPr` counts a merged PR of the branch only when it has the number dipo recorded for the run, so a builder's PR on dipo's branch is not seen. Next up already skips a story whose PR is recorded merged (DIPO-445, packages/engine/src/records/story-prs.ts, packages/engine/src/run/next-up.ts), but a dependent story waits for its dependency to read Done on the base. The backlog PR check (packages/engine/src/backlog/pr/check.ts, `LANE_B_TRANSITIONS`) refuses Parked to Done in dipo's own run and in CI (scripts/check-backlog-pr.ts).

The fix, one mechanism (0001): the merge is the fact, decided by code with no model.

1. The Done check's merged answer settles a parked or not ended run. When `decideDone` answers merged and the branch status is Parked, the Done poll resolves the open park as `merged` (packages/engine/src/run-state/park-records.ts), ends the run done and tears down as for any merged story, with one desk line. This replaces the `teardown.parked` keep for a merged PR. A worker still running keeps the claim as today.
2. `claimPr` also counts a merged PR on the claim's branch that is not the recorded one, when it merged into the claim's base after the claim was taken and its head holds the claim's start commit. This replaces the recorded-number match; a merged PR of an earlier claim of a reused branch still does not count (DIPO-332).
3. When the base does not say Done after the teardown, dipo writes Done through its planning lane (packages/engine/src/backlog/lane/lane.ts, the `edit` kind in packages/engine/src/backlog/lane/ops.ts) once the claim is released, so the no-claim rule still holds.
4. The backlog PR check accepts Parked to Done for a task exactly when that story's own PR merged: a merged PR whose head branch is the `branch` of the task's `dipo` field block, whose base is the PR's base and whose merge commit is on the base. dipo's own run reads it from its story PR record; CI reads it from `gh` and `git merge-base --is-ancestor`. Every other Parked to Done, and every other refused transition, is still refused.

ADRs: 0012 (its transition table gets a Parked to Done row, "the story's PR merged", with one Replaced line) and 0020 (a park resolved as merged when the story's PR merged, next to section 7, with one Replaced line for the keep of a merged parked story). The maintainer approves the wording in the story's PR; the merge gate waits for any change under docs/decisions/ (0002).

Built by builder agents: it changes dipo's own Done poll and the backlog PR check, and DIPO-460 shows a parked dipo run cannot be trusted to finish it.

```dipo
branch: "DIPO-468/merged-while-parked"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) done poll: a claim whose PR merged while its branch status is Parked resolves the park as merged, ends the run done, tears down the box and branch, and adds one desk line; the teardown.parked keep no longer fires for a merged PR"
    - kind: "automated"
      check: "(unit) done poll: a merged PR whose run still has a live worker keeps the claim as today"
    - kind: "automated"
      check: "(unit) claimPr counts a merged PR on the claim's branch that is not the recorded one when it merged into the claim's base after the claim and its head holds the start commit, and does not count a merged PR of an earlier claim of a reused branch"
    - kind: "automated"
      check: "(unit) after a merged teardown whose base status is Parked, dipo journals a lane edit to Done after the claim is released, and journals nothing when the base already says Done"
    - kind: "automated"
      check: "(unit) packages/engine/test/backlog/pr/check.test.ts: Parked to Done passes when the task's own PR merged on its field block branch into the base, and the old barrier still refuses Ready to In Progress, Refined to Done and Parked to Done without a merged PR"
    - kind: "automated"
      check: "(unit) packages/engine/test/backlog/pr/check.test.ts bypass forms: a PR merged from another branch, a closed unmerged PR, a merged PR whose merge commit is not on the base, a story id typo and a second story without its own merged PR in the same PR are each refused"
    - kind: "automated"
      check: "(unit) scripts/check-backlog-pr.test.ts: CI proves the merge from gh and git and refuses Parked to Done when gh fails or answers nothing (fail closed), on a real temporary repository through the real check path"
    - kind: "manual"
      check: "After the story merges and dipo is re-pinned, read dipo desk and the backlog for DIPO-460, which is parked with its PR #634 merged"
      expect: "the DIPO-460 park is gone from the desk with one line saying its PR merged, a backlog PR sets DIPO-460 to Done and passes its checks, and once it merges dipo desk offers DIPO-461 as next up"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When the one Done check answers merged for a claim whose branch status is Parked, the Done poll resolves the open park as merged, ends the run done and tears down the box and branch as for any merged story, with one line on the desk saying the PR merged while the story was parked; this replaces the teardown.parked keep for a merged PR, and a run with a live worker keeps its claim as today
- [ ] #2 claimPr counts a merged PR on the claim's branch that is not the run's recorded PR when it merged into the claim's base after the claim was taken and its head holds the claim's start commit, replacing the recorded-number match, and a merged PR of an earlier claim of a reused branch still does not count
- [ ] #3 When the base does not say Done after such a teardown, dipo writes Done for the story through its planning lane after the claim is released, and writes nothing when the base already says Done
- [ ] #4 The backlog PR check, in dipo's own run and in CI, accepts Parked to Done for a task exactly when its own PR merged: head branch equal to the branch of the task's dipo field block, base equal to the PR's base and the merge commit on the base, read from dipo's story PR record or from gh and git, decided by code with no model
- [ ] #5 The old barrier still refuses every other transition, with a test for each: Ready to In Progress, Refined to Done, In Progress or In Review to Done, and Parked to Done without a merged PR
- [ ] #6 Tests cover the bypass forms, each refused: a PR merged from another branch, a closed unmerged PR, a merged PR whose merge commit is not on the base, a story id typo that names another story's branch, and a second story without its own merged PR in the same backlog PR
- [ ] #7 A fail-closed test against the real path runs scripts/check-backlog-pr.ts on a temporary repository and shows Parked to Done refused when gh fails, times out or answers no merged PR
- [ ] #8 ADR 0012 gets a Parked to Done row for a story whose PR merged and ADR 0020 describes the park resolved as merged, each with one Replaced line; the maintainer approves the wording in the story's PR
<!-- AC:END -->
