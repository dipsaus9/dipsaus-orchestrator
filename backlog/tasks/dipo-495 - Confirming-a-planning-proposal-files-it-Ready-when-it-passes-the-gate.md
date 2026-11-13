---
id: DIPO-495
title: Confirming a planning proposal files it Ready when it passes the gate
status: In Review
assignee: []
created_date: '2026-11-13 09:17'
updated_date: '2026-11-13 12:06'
labels:
  - 'tier:L'
milestone: m-3
dependencies:
  - DIPO-492
references:
  - packages/engine/src/backlog/lane/stories.ts
  - packages/engine/src/backlog/lane/planning.ts
  - packages/engine/src/run/ready-stories.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/run/planning.ts
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/backlog/pr/check.ts
  - packages/contract/src/work.ts
  - scripts/check-ready-gate.ts
  - scripts/check-ready-gate.test.ts
  - scripts/check-backlog-pr.ts
  - scripts/check-backlog-pr.test.ts
  - packages/engine/test/run/planning-world.ts
  - packages/engine/test/run/planning-filing.test.ts
  - packages/engine/test/run/planning-proposals.test.ts
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0022-planning-sessions.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: high
type: feature
ordinal: 466000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want my confirm of a new story, a split or a refined draft in a planning session to file it Ready when it passes the Ready gate, in the same backlog PR, so that one confirm and one backlog PR take a story from conversation to runnable.

M3 (0022), a feature the maintainer decided on 2026-11-13 ("Confirm = Ready") after: "It also takes too much of an effort to make a story ready. It also is unclear how to do this. With the pipelines being slow this process is not efficient." Today a story needs a confirm that files it Refined (backlog PR 1), then `/end`'s Ready step or the Queue's `Y` (backlog PR 2, since 0012 forbids Ready in the filing PR), then the next-up confirm; each backlog PR takes about 7 minutes. This story is the engine and CI side; DIPO-497 removes the `/end` Ready step and `planning.ready` once this lands.

On main:
- The lane files every story Refined: `fileKind` runs `task create ... --status Refined` (packages/engine/src/backlog/lane/stories.ts:172-215), then fills and reads back the field block.
- Ready is set only by `readyStories` (packages/engine/src/run/ready-stories.ts:1-6, :44-110), which gates the story as the base holds it, so its filing PR must have merged; `planning.ready` (packages/engine/src/run/planning-session.ts:855-920) and `story.ready` (packages/engine/src/run/planning.ts:228-280, the Queue's `space` and `Y`) both call it.
- The structural check refuses a new task at Ready: `LANE_B_TRANSITIONS` (packages/engine/src/backlog/pr/check.ts:146-162) has no `[null, "Ready"]` and no `["Draft", "Ready"]`, so `transition` fails it; `ready-decision` (:267-285) wants a passing gate decision for the content of every task that becomes Ready. In CI that decision is the gate run on the head (scripts/check-backlog-pr.ts:132-143), and the structural check runs only on a backlog-only PR (the light path, 0016).

The fix:
- On `planning.confirm` of a `story`, the new story of a `split`, or a `refine` of a draft, the lane's file operation, once the task is created and read back in the `_backlog` worktree, evaluates the Ready gate (`ready` mode) on the task as filed there, stores the decision for its content hash under the story's key (`recordGateDecision`), and when it passes sets the task Ready in the same operation, read back again, so the backlog PR that files it carries it at Ready. When the gate fails the task stays Refined, and the card and the planning view show the gate's messages; `story.ready` and the Queue's `Y` stay the way to set it later. The confirm calls the gate step `readyStories` uses, not a copy (0001).
- An edit (`edit`, or the narrowed story of a `split`) of a Ready story is gated again on the content as revised, in the same operation: it stays Ready when it passes and returns to Refined with the gate's messages when it fails. An edit of a Refined or Parked story keeps its status: an edit is not a Ready choice.
- DIPO-478 (m-4, Ready on main) sets a Ready story Refined when a planning edit changes its role (its criterion #4), so the daemon gates it again. When this story builds second, it replaces that criterion's rule with the re-gate in the revise operation, which a role change also goes through; when 478 builds second, it follows this story's re-gate instead of setting Refined.
- Only the maintainer's `planning.confirm` does this. A proposal block has no status field (`PlanningProposal` is a strict schema, packages/contract/src/work.ts:640-670), the planning session has no command access (0008, 0022), and workers and reviewers never file.
- The structural check accepts `[null, "Ready"]` and `["Draft", "Ready"]` only with the passing decision `ready-decision` already demands for every task that becomes Ready; in CI the head's gate run decides it.
- A PR that also changes code (any path outside `backlog/`, such as a worker's story PR) and adds a task at Ready or promotes a draft to Ready is refused in CI: `scripts/check-ready-gate.ts`, which runs on every PR, compares the head with the PR's base (`GITHUB_BASE_REF`, as check-backlog-pr.ts reads it) and fails on such a task, so ci.yml (a Code Owner path) does not change. dipo's own merge check of a story PR keeps the rule that a story branch changes no other `backlog/` file (0010).

R30 applies: this loosens who and what may put a story at Ready. Said plainly: a new task may now arrive at Ready in a backlog-only PR (the light path, 0016) when the gate passes on it. That means a hand-written backlog-only PR by the maintainer or a builder can add a passing story at Ready in one PR; this is accepted. A PR that also changes code may not add or promote a task at Ready.

What the old barriers caught, each keeping a test: a backlog PR that adds or moves a task to Ready whose content fails the gate is refused by CI (`ready-decision` with the head's gate); a task at Ready in dipo's backlog PR without a stored passing decision for its content is refused by dipo's own check; a planner cannot file Ready without the maintainer's confirm; a story that fails the gate is never filed Ready; a new task at Ready was refused in every PR (the `transition` rule), which now holds for every PR that changes code. Bypass forms to test: a proposal that claims a status (`"status": "Ready"`, refused by the schema); a split whose new part passes and whose narrowed part fails, and the reverse; a refine of a draft; an edit of a Ready story that breaks a gated field; a confirm whose content changes in the lane's read-back (the decision's hash no longer matches); a mixed PR that adds a Ready task, and one that promotes a draft to Ready. The fail-closed test runs the real lane path with the real Backlog CLI and the real gate on a temporary backlog: a passing story is created Ready, a failing one Refined, and the structural check over the resulting diff passes the first and refuses a hand-made Ready task with no decision.

ADR lines that change:
- 0012 section 2, the line above the table (line 43), "new tasks start `Refined`": new tasks start `Refined`, or `Ready` at the maintainer's planning confirm when the gate passes.
- 0012 section 2, two new rows: `(none) → Ready` and `Draft → Ready`, "at the maintainer's planning confirm, with a passing decision for its content", who: Maintainer, decided by code.
- 0012 section 2, the Refined to Ready row (line 49): "sets the stories that pass Ready in a second backlog PR it opens, never the PR that filed them" becomes: at the maintainer's confirm in a planning session dipo gates the story as filed and files it Ready in the same backlog PR when it passes, Refined with the gate's messages when it fails; `story.ready` stays for any Refined story; a PR that also changes code may not add a task at Ready.
- 0012 section 2, the Ready to Refined row (line 50): "A gated field changed, or the pickup check failed" becomes "A gated field changed and the re-gate failed, or the pickup check failed".
- 0012: one Replaced line: Ready only in a second backlog PR after the filing PR merged (2026-11-13).
- 0022 section 2, the line "**Ready.**" (line 26): rewritten the same way, and the line "**A new story**" (line 24) says it is filed Ready when the gate passes. One Replaced line: the end-of-session Ready confirm as the way to Ready.
- 0010 section 2, the structural check line "each status change is an allowed 0012 transition" (line 41): it names the new tasks at Ready with a passing decision and that a PR which changes code may not add one.

Tier L: the lane's file and revise operations with the gate, the structural check's transitions, the CI rule for mixed PRs, three ADRs and the R30 tests.

```dipo
branch: "DIPO-495/confirm-files-ready"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(fail-closed: the real planning lane, Backlog CLI and gate on a temporary backlog) confirming a passing story files it Ready with a stored passing decision for its content; a failing one is filed Refined and the view shows the gate's messages"
    - kind: "automated"
      check: "(unit, backlog-pr check) a new task at Ready and a draft promoted to Ready pass with a passing decision for their content and fail ready-decision without one or with a decision for other content; other new-task transitions are refused as before"
    - kind: "automated"
      check: "(unit, check-backlog-pr on a fixture repository) a backlog-only PR adding a task at Ready that fails the gate is refused; a backlog-only PR adding one that passes is accepted"
    - kind: "automated"
      check: "(unit, check-ready-gate on a fixture repository with a base) a PR that changes a code file and adds a task at Ready is refused, and so is one that promotes a draft to Ready; a backlog-only PR is not refused by this rule"
    - kind: "automated"
      check: "(unit, planning-proposals) a proposal with a status field is refused by the schema; no planning path sets Ready without planning.confirm"
    - kind: "automated"
      check: "(unit, planning-world) a split whose new part passes and narrowed part fails files the new part Ready and leaves the narrowed Ready story Refined with messages, and the reverse; a refine of a passing draft is filed Ready; a confirm whose read-back content differs is not filed Ready"
    - kind: "automated"
      check: "(unit, planning-world) an edit of a Ready story that keeps it passing leaves it Ready; one that breaks a gated field leaves it Refined with the gate's messages; an edit of a Refined story keeps it Refined"
    - kind: "automated"
      check: "(unit) story.ready and the Queue's Y still set a Refined story Ready through readyStories, with their old refusals"
    - kind: "manual"
      check: "On the scratch repository, in a planning session confirm one story that passes the gate and one that lacks a test plan"
      expect: "dipo's one backlog PR holds the first story at Ready and the second at Refined; its CI passes; the card of the second shows why"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A confirmed new story, new story of a split or refined draft that passes the Ready gate as filed is filed Ready in the same backlog PR, with a stored passing decision for its content; one that fails is filed Refined and the card and view show the gate's messages
- [x] #2 A confirmed edit of a Ready story is gated again in the same operation: it stays Ready when it passes and returns to Refined with the gate's messages when it fails; an edit of a Refined or Parked story keeps its status
- [x] #3 The structural check accepts a new task at Ready and a draft promoted to Ready only with a passing decision for their content, in dipo and in CI, on a backlog-only PR
- [x] #4 A PR that also changes code and adds a task at Ready or promotes a draft to Ready is refused in CI, with a test
- [x] #5 A backlog-only PR adding a task at Ready that fails the gate is refused, one adding a passing task is accepted, and a task at Ready without a passing decision for its content is refused by dipo's check, each with a test
- [x] #6 No planning path sets Ready without the maintainer's planning.confirm, and a proposal with a status field is refused by the schema
- [x] #7 The bypass forms (a split with one part passing, a refine of a draft, an edit breaking a gated field, content changed in the read-back, a mixed PR adding or promoting a Ready task) are tested, and a fail-closed test runs the real lane, Backlog CLI and gate on a temporary backlog
- [x] #8 story.ready and the Queue's Y still set a Refined story Ready through readyStories with their old refusals
- [x] #9 ADR 0012's new-task line, its new (none) to Ready and Draft to Ready rows, its Refined to Ready and Ready to Refined rows, ADR 0022's new story and Ready lines and ADR 0010's structural check line describe filing Ready at confirm, with Replaced lines in 0012 and 0022
<!-- AC:END -->
