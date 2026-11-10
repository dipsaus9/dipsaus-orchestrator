---
id: DIPO-480
title: A planning session knows the stories it filed
status: In Review
assignee: []
created_date: '2026-11-10 15:21'
updated_date: '2026-11-10 16:33'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/records/planning-record.ts
  - packages/engine/src/records/story-keys.ts
  - packages/engine/src/prompts/contract/planning-box.md
  - packages/engine/src/prompts/task/planning.md
  - packages/engine/src/box/review-box.ts
  - packages/engine/src/backlog/lane/stories.ts
  - packages/engine/test/run/planning-filing.test.ts
  - packages/engine/test/run/planning-ready.test.ts
  - packages/engine/test/run/planning-world.ts
priority: high
type: bug
ordinal: 452000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a planning session to know every story it filed, whether its backlog PR merged or not, and to let me file a story that depends on one it filed a moment ago, so that I can plan a chain of stories in one sitting without Claude saying a filed story is missing or refusing its dependency.

M3 (0022), a bug the maintainer asked to fix on 2026-11-10. Three findings from the same session.

1. A dependency on a story the session just filed is refused. Evidence: the daemon log of 2026-11-10 14:41 to 14:43 has four `planning.confirm` answered `planning.storyUnknown`: the maintainer confirmed story 1, then story 2, which depends on story 1, and it was refused. Cause (on main): `#checkNewStory` in packages/engine/src/run/planning-session.ts (:1078-1118) resolves each dependency with `resolveStoryRef` against the office's stories, which know a story only once its filing PR merged; the lane had flushed story 1 (`committed=1 merged=0`). The Ready confirm in the same file (`ready`, :801-822, DIPO-451) already handles "a story whose filing PR has not merged has an id but no key yet" by finding it in the planning record (`readPlanningRecord`, story entries). Fix: a dependency also resolves when it is a story this session filed, by that same rule, moved into one helper both call (0001: it replaces the separate record lookup in `ready`). Everything else is refused as today.

2. Claude cannot see the stories its session filed. In a session Claude said "DIPO-477 is not on the base copy I have (commit 193b138) ... only DIPO-471 and DIPO-472 are present", although dipo's backlog PR #655, which filed DIPO-473 to DIPO-478, had merged (main 39e44f14). Cause: the box's read-only copy is staged once, at the base tip when the box is made (`#launch`, planning-session.ts:1483-1520, `stageReviewCopy` in packages/engine/src/box/review-box.ts), and never refreshed; a story filed but not merged is on no base at all. The `[dipo]` line for a confirm (planning-session.ts:766-767) names the ids "in dipo's backlog PR" but never their text, and nothing says when the PR merged. Mechanism (one, 0001): dipo gives Claude the session's filed stories as text, never by refreshing the copy. Before Claude's next turn after a filing change (filed, its backlog PR merged, or closed), the next message's `[dipo]` lines list each story the session filed or edited with its id, title, dependencies, state (filed with its backlog PR open, or on the base since commit X) and its full text as filed; a fresh session's first message (`planningRecordText`) carries the same list. The planning contract (packages/engine/src/prompts/contract/planning-box.md) says the copy is at the commit `<copy>` names, that stories filed or merged after it are in this list and not in the copy, and that a story missing from the copy but listed is never "missing". A refresh of the box copy was not chosen: it cannot show a story whose PR has not merged, so the text would be needed anyway. This replaces Claude reading its own session's stories from the copy.

3. Claude told the maintainer to press Ctrl-G to set Ready. On main Ctrl-G is in fact the TUI's Ready key (packages/tui/src/planning.tsx:21, packages/tui/src/keys.ts:541) while the design says Y (docs/design/tui-v2/keymap.json, planReady), and DIPO-487 makes it Y in the planning view's Ready step. Claude found Ctrl-G by reading the TUI's code in the copy; the engine does not know the TUI's keys (0009). The fix: the planning contract names the Ready step in words ("the planning view's Ready step, where the maintainer ticks the stories that go Ready") and tells Claude never to name a key of the TUI, so what Claude says can never differ from the TUI.

Finding 1 changes a check, so (CLAUDE.md, R30): the old check caught an unknown id, a typo, a dependency on a dropped draft and a story filed by another session that has not merged; each keeps a test. Bypass forms to test: a lower-case id, a proposal number instead of an id, and a dependency on a proposal that was confirmed and then failed. The fail-closed test runs the real planning session with the real planning lane and the Backlog CLI on a fixture-built office, not planning-world's injected lane (packages/engine/test/run/planning-world.ts:133-134, none by default), so filing with `--dep` on an id whose filing PR has not merged (packages/engine/src/backlog/lane/stories.ts:204) is proven to work, never a fake check.

Tier M: the dependency rule, the filed-stories list and the contract text. If it runs over, split it into the dependency fix (criteria 1 to 5) and what Claude is told (criteria 6 to 8).

```dipo
branch: "DIPO-480/planning-knows-its-stories"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(fail-closed: the real planning lane and the Backlog CLI on a fixture-built office) confirm story 1, then story 2 that depends on story 1's id while story 1's filing PR is open: both are filed and story 2's filed task lists the dependency"
    - kind: "automated"
      check: "(unit, planning-world) the old refusals stay: an unknown id, a typo of a filed id, a dropped draft and a story another session filed that has not merged are each answered planning.storyUnknown"
    - kind: "automated"
      check: "(unit, planning-world) bypass forms: a lower-case id of a session story resolves like its upper-case form and a lower-case unknown id is refused; a proposal number (3, #3) instead of an id is refused; a dependency on a proposal confirmed and then failed is refused"
    - kind: "automated"
      check: "(unit, planning-world) Ready on one final confirm sets both stories Ready after both filing PRs merged later"
    - kind: "automated"
      check: "(unit, planning-world) after a confirm the next message's [dipo] lines list the filed story with id, title, dependencies, 'filed, backlog PR open' and its full text; after the PR merges the next message lists it as on the base since the merge commit; a fresh session's first message lists the same"
    - kind: "automated"
      check: "(unit) the planning contract names the Ready step in words, tells Claude never to name a TUI key, and says stories in the filed list may be missing from the copy; a test fails on a key name (ctrl-, Ctrl+, a single-letter key in backticks) in the planning prompts"
    - kind: "manual"
      check: "On the scratch repository, in a planning session confirm story 1 and, straight after, story 2 that depends on story 1; after dipo's backlog PR merges, ask Claude about story 2's dependency and how to set them Ready"
      expect: "Both are filed with no planning.storyUnknown; Claude knows both stories and says they are on the base, never that one is missing; it names the planning view's Ready step, not a key"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A new story, split or refined draft whose dependency is a story this planning session filed is filed even when that story's filing PR has not merged, and the filed task lists the dependency
- [x] #2 The session-story rule is one helper that both the dependency check and the Ready confirm (DIPO-451) use; the separate record lookup in the Ready confirm is removed
- [x] #3 An unknown id, a typo, a dropped draft and a story filed by another session that has not merged are still refused with planning.storyUnknown, each with a test
- [x] #4 Bypass forms have tests: a lower-case id resolves like its upper-case form, a proposal number instead of an id is refused, and a dependency on a proposal confirmed and then failed is refused
- [x] #5 A fail-closed test runs the real planning session with the real planning lane and the Backlog CLI on a fixture-built office (not planning-world's injected lane), proving --dep on an id whose filing PR has not merged, and Ready on one final confirm still sets both stories Ready after their filing PRs merged
- [x] #6 Before Claude's next turn after a filing change, its message lists each story the session filed or edited with id, title, dependencies, full text and its state, filed with the backlog PR open or on the base since a named commit; a fresh session's first message carries the same list; the box copy is not refreshed
- [x] #7 The planning contract says stories filed or merged after the copy's commit are in that list and not in the copy, so Claude never calls a listed story missing
- [x] #8 The planning contract names the planning view's Ready step in words and tells Claude never to name a TUI key, with a test that fails on a key name in the planning prompts
<!-- AC:END -->
