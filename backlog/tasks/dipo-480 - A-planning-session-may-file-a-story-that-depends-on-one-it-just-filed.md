---
id: DIPO-480
title: A planning session may file a story that depends on one it just filed
status: Refined
assignee: []
created_date: '2026-11-10 15:21'
updated_date: '2026-11-10 15:22'
labels:
  - 'tier:S'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/records/planning-record.ts
  - packages/engine/src/records/story-keys.ts
  - packages/engine/test/run/planning-filing.test.ts
  - packages/engine/test/run/planning-ready.test.ts
  - packages/engine/test/run/planning-world.ts
priority: high
type: bug
ordinal: 452000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a planning session to file a story that depends on a story the same session filed a moment ago, so that I can confirm a chain of stories in one sitting instead of waiting for each filing PR to merge.

M3 (0022), a bug. Evidence: the daemon log of 2026-11-10 14:41 to 14:43 has four `planning.confirm` answered `planning.storyUnknown`. The maintainer confirmed story 1, then story 2, which depends on story 1, and it was refused.

Cause (on main): `#checkNewStory` in packages/engine/src/run/planning-session.ts resolves each dependency with `resolveStoryRef` against the office's stories, which know a story only once its filing PR merged; the lane had flushed story 1 (`committed=1 merged=0`). The Ready confirm in the same file (`ready`, DIPO-451) already handles "a story whose filing PR has not merged has an id but no key yet" by finding it in the planning record (`readPlanningRecord`, story entries).

Fix: a dependency also resolves when it is a story this session filed, by the same rule the Ready confirm uses, moved into one helper both call (0001: it replaces the separate record lookup in `ready`, which then uses the helper). Everything else is refused as today.

This changes a check, so (CLAUDE.md, R30): the old check caught an unknown id, a typo, a dependency on a dropped draft and a story filed by another session that has not merged; each keeps a test. Bypass forms to test: a lower-case id, a proposal number instead of an id, and a dependency on a proposal that was confirmed and then failed. The fail-closed test runs the real planning session with a fixture-built office and lane (planning-world.ts), never a fake check.

```dipo
branch: "DIPO-480/planning-dep-on-session-story"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, planning-world) confirm story 1, then story 2 that depends on story 1's id while story 1's filing PR is open: both are filed and story 2's filed task lists the dependency"
    - kind: "automated"
      check: "(unit, planning-world) the old refusals stay: an unknown id, a typo of a filed id, a dropped draft and a story another session filed that has not merged are each answered planning.storyUnknown"
    - kind: "automated"
      check: "(unit, planning-world) bypass forms: a lower-case id of a session story resolves like its upper-case form and a lower-case unknown id is refused; a proposal number (3, #3) instead of an id is refused; a dependency on a proposal confirmed and then failed is refused"
    - kind: "automated"
      check: "(unit, planning-world) Ready on one final confirm sets both stories Ready after both filing PRs merged later"
    - kind: "manual"
      check: "On the scratch repository, in a planning session confirm story 1 and, straight after, story 2 that depends on story 1"
      expect: "Both are filed, story 2 with story 1 as its dependency, with no planning.storyUnknown"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new story, split or refined draft whose dependency is a story this planning session filed is filed even when that story's filing PR has not merged, and the filed task lists the dependency
- [ ] #2 The session-story rule is one helper that both the dependency check and the Ready confirm (DIPO-451) use; the separate record lookup in the Ready confirm is removed
- [ ] #3 An unknown id, a typo, a dropped draft and a story filed by another session that has not merged are still refused with planning.storyUnknown, each with a test
- [ ] #4 Bypass forms have tests: a lower-case id resolves like its upper-case form, a proposal number instead of an id is refused, and a dependency on a proposal confirmed and then failed is refused
- [ ] #5 A fail-closed test runs the real planning session with a fixture-built office and lane, and Ready on one final confirm still sets both stories Ready after their filing PRs merged
<!-- AC:END -->
