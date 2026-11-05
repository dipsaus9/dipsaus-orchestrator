---
id: DIPO-445
title: Stop offering a story as next up once its pull request has merged
status: Refined
assignee: []
created_date: '2026-11-05 12:06'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/engine/src/merge/stories.ts
  - packages/engine/src/run/next-up.ts
  - packages/engine/src/stories/feature.ts
  - packages/engine/src/create/stories.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/test/run/next-up.test.ts
  - docs/decisions/0010-backlog-and-git-integration.md
priority: high
type: bug
ordinal: 418000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to stop offering a story as next up once its pull request has merged, so that I never start a pointless run of finished work by confirming a stale offer.

Found by M2's closing hand test (2026-11-05, scratch repository). Blocks M2 (maintainer's decision). After three stories merged, the desk offered all three again as NEXT UP for about 3.5 minutes: the claim is released at the merge, but _base moves only at the next fetch poll (polling.fetchSeconds, default 300 s), so next up still read the stories as Ready. A confirm in that window would likely start a run of a Done story.

The fix: when dipo sees a story's pull request merge, it fetches and moves _base before it releases that story's claim, so pickup and next up read the merged status. A confirm or dipo run of a story whose pull request merged is refused and starts nothing.

Built by builder agents: it changes dipo's own run path.

```dipo
branch: "DIPO-445/no-next-up-after-merge"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) next-up tests: after a story's pull request merges, the story is not offered as next up, also before the next fetch poll"
    - kind: "automated"
      check: "(unit) merge tests: on a seen merge dipo moves _base to the merged base before it releases the story's claim"
    - kind: "automated"
      check: "(unit) a confirm or dipo run of a story whose pull request merged is refused with a message and starts no run"
    - kind: "manual"
      check: "On the scratch repository, let a confirmed story merge and read dipo desk right after the merge"
      expect: "The merged story is not offered as next up at any moment after its merge"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After a story's pull request merges, dipo never offers that story as next up, also before the next fetch poll
- [ ] #2 When dipo sees a story's pull request merge, it moves _base to the merged base before it releases that story's claim
- [ ] #3 A confirm or dipo run of a story whose pull request merged is refused with a message that says it merged, and starts no run
- [ ] #4 A fetch that fails at the merge leaves the story out of next up until _base shows it Done, and the next poll retries
<!-- AC:END -->
