---
id: DIPO-468
title: A story whose PR merges while it is parked becomes Done
status: Refined
assignee: []
created_date: '2026-11-09 17:56'
updated_date: '2026-11-09 18:02'
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
  - packages/engine/src/backlog/pr/merge.ts
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

M3 (maintainer's choice, 2026-11-09). The trigger, DIPO-460: after the maintainer approved its merge gate, a CI fix round ran (a cancelled check read as red), its box verify went red 5 times, and dipo parked the story and pushed "status Parked" to the story branch. GitHub's auto-merge then merged dipo's story PR #634 with that commit. main now says DIPO-460 is Parked, and `ebd192c4` (#634) is the last commit that touched its task file. dipo's desk keeps the park, and DIPO-461, which depends on DIPO-460, can never start. A backlog PR that set DIPO-460 to Done (#637) was refused by the backlog PR check: "DIPO-460 moves from Parked to Done, which a backlog PR may not do (0012)". That rule is right in general and stays closed for everyone else.

Today the one Done check (`decideDone` in packages/engine/src/worktree/done-check.ts) answers merged for the claim's story PR. Then the Done poll (packages/engine/src/worktree/done.ts, `#merged`) reads the story's status on its branch. When the status is Parked, it keeps the claim with the `teardown.parked` notice (packages/engine/src/worktree/teardown.ts) and asks the maintainer to resolve the park. Next up already skips a story whose PR is recorded merged (DIPO-445, packages/engine/src/records/story-prs.ts, packages/engine/src/run/next-up.ts), but a dependent story waits until its dependency reads Done on the base. The backlog PR check (packages/engine/src/backlog/pr/check.ts, `LANE_B_TRANSITIONS`) refuses Parked to Done, both in dipo's own run and in CI (scripts/check-backlog-pr.ts).

The fix, one mechanism (0001): the merge is the fact, and code decides it with no model.

1. When `decideDone` answers merged and the branch status is Parked, the Done poll resolves the open park as `merged` (packages/engine/src/run-state/park-records.ts), ends the run done and tears down as it does for any merged story. It adds one line to the desk. This replaces the `teardown.parked` keep in `#merged` only. `#movedPast` keeps its own parked keep for a merged PR whose branch holds work the base lacks, and a run with a live worker keeps its claim, as today.
2. If the base does not say Done after the teardown, dipo writes Done through its planning lane (packages/engine/src/backlog/lane/lane.ts, the `edit` kind in packages/engine/src/backlog/lane/ops.ts). It writes only after the claim is released, so the no-claim rule still holds. dipo's auto-merge poll (packages/engine/src/backlog/pr/merge.ts) merges that backlog PR once its check passes.
3. The backlog PR check accepts Parked to Done for a task exactly when `decideDone` answers merged for it. The check gives it the claim {branch: the `branch` of the task's `dipo` field block on the base side, base: the PR's base}. The PR is the story PR whose merge commit is the last commit on the base that touched the task file, and so wrote Parked there. The check gets that PR from git (`git log -1 <base> -- <task file>`) and the host (the merged PR of that commit, packages/engine/src/platform/host.ts). dipo's own run and CI share this one check. It adds no third Done definition next to DIPO-445's next-up skip. Every other Parked to Done, and every other refused transition, is still refused. When the host fails, the check refuses.

ADRs: 0012 gets a Parked to Done row in its transition table, "the story's PR merged", with one Replaced line. 0020 gets a park resolved as merged when the story's PR merged, next to section 7, with one Replaced line for the keep of a merged parked story. The maintainer approves the wording in the story's PR, and the merge gate waits for any change under docs/decisions/ (0002).

Built by builder agents. The story changes dipo's own Done poll and the backlog PR check, and DIPO-460 shows that a parked dipo run cannot be trusted to finish it.

```dipo
branch: "DIPO-468/merged-while-parked"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) done poll: a claim whose story PR merged while its branch status is Parked resolves the park as merged, ends the run done, tears down the box and branch, and adds one desk line"
    - kind: "automated"
      check: "(unit) done poll: a merged PR with a live worker keeps the claim, and a merged PR whose branch moved past the merged head with work the base lacks still keeps its parked keep in #movedPast"
    - kind: "automated"
      check: "(unit) after a merged teardown whose base status is Parked, dipo journals a lane edit to Done after the claim is released, and journals nothing when the base already says Done"
    - kind: "automated"
      check: "(unit) packages/engine/test/backlog/pr/check.test.ts: Parked to Done passes when decideDone answers merged for the story PR whose merge commit last touched the task file on the base, and the old barrier still refuses Ready to In Progress, Refined to Done, In Progress or In Review to Done, and Parked to Done without a merged PR"
    - kind: "automated"
      check: "(unit) packages/engine/test/backlog/pr/check.test.ts bypass forms, each refused: a PR merged from another branch, a closed unmerged PR, a merged PR whose merge commit is not on the base, an old merged PR of a reused branch, a PR that edits the field block branch and sets Parked to Done together, a story id typo and a second story without its own merged PR"
    - kind: "automated"
      check: "(unit) scripts/check-backlog-pr.test.ts: on a real temporary repository through the real check path, Parked to Done is refused when gh fails, times out or answers no merged PR (fail closed)"
    - kind: "manual"
      check: "After the story merges and dipo is re-pinned, read dipo desk for DIPO-460, parked with its PR #634 merged, then wait for dipo's backlog PR that sets it Done to auto-merge"
      expect: "the DIPO-460 park is gone from the desk with one line saying its PR merged, a backlog PR from dipo sets DIPO-460 to Done, passes its checks and is merged by dipo's auto-merge with no merge by hand, and after that merge dipo desk offers DIPO-461 as next up"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When the one Done check answers merged for a claim whose branch status is Parked, the Done poll resolves the open park as merged, ends the run done and tears down the box and branch as for any merged story, with one line on the desk saying the story PR merged while the story was parked; this replaces the teardown.parked keep in #merged only
- [ ] #2 A merged PR whose branch moved past the merged head with work the base lacks still keeps its own parked keep in #movedPast, and a run with a live worker keeps its claim, each with a test
- [ ] #3 When the base does not say Done after such a teardown, dipo writes Done for the story through its planning lane after the claim is released, and writes nothing when the base already says Done
- [ ] #4 The backlog PR check, in dipo's own run and in CI, accepts Parked to Done for a task exactly when decideDone answers merged for it, with the claim made of the branch in the task's dipo field block on the base side and the PR's base, and the PR being the story PR whose merge commit is the last commit on the base that touched the task file; it reuses decideDone and adds no third Done definition next to DIPO-445's next-up skip
- [ ] #5 The old barrier still refuses every other transition, with a test for each: Ready to In Progress, Refined to Done, In Progress or In Review to Done, and Parked to Done without a merged PR
- [ ] #6 Tests cover the bypass forms, each refused: a PR merged from another branch, a closed unmerged PR, a merged PR whose merge commit is not on the base, an old merged PR of a reused branch, a backlog PR that edits the field block branch and sets Parked to Done in the same PR, a story id typo that names another story, and a second story without its own merged PR in the same backlog PR
- [ ] #7 A fail-closed test against the real path runs scripts/check-backlog-pr.ts on a temporary repository and shows Parked to Done refused when gh fails, times out or answers no merged PR
- [ ] #8 ADR 0012 gets a Parked to Done row for a story whose PR merged and ADR 0020 describes the park resolved as merged, each with one Replaced line; the maintainer approves the wording in the story's PR
<!-- AC:END -->
