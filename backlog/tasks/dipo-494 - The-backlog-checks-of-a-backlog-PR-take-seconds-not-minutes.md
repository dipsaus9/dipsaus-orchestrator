---
id: DIPO-494
title: 'The backlog checks of a backlog PR take seconds, not minutes'
status: Refined
assignee: []
created_date: '2026-11-13 09:17'
updated_date: '2026-11-13 09:29'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - scripts/check-ready-gate.ts
  - scripts/check-ready-gate.test.ts
  - scripts/check-backlog-pr.ts
  - scripts/check-backlog-pr.test.ts
  - packages/engine/src/gate-decisions/read.ts
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/gate-decisions/cache.ts
  - packages/engine/src/stories/read.ts
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/story-store/fields/block.ts
  - packages/engine/src/backlog/pr/check.ts
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
priority: high
type: bug
ordinal: 465000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the backlog checks of a backlog PR to take seconds instead of minutes, so that filing a story and setting it Ready no longer waits on a slow pipeline.

M3 (0022), a bug from the maintainer on 2026-11-13: "It also takes too much of an effort to make a story ready. It also is unclear how to do this. With the pipelines being slow this process is not efficient." Evidence: backlog PRs #676, #677 and #678 (2026-11-12) took about 7 minutes from created to merged each; the `ready-gate` job took about 6.5 minutes on a 2-core ubuntu runner (run 43230962341), of which `bun scripts/check-ready-gate.ts` about 2.5 minutes with no Ready story and `bun scripts/check-backlog-pr.ts HEAD^1 HEAD` about 2.5 minutes for 4 changed tasks. Locally on main each takes about 33 s wall and 180 s user CPU.

Cause (on main):
1. `checkReadyGate` (scripts/check-ready-gate.ts:69-105; header :5-8) lists every task and views every one of them through the Backlog CLI (`viewListedTasks`, packages/engine/src/gate-decisions/read.ts:52-73, at `VIEW_CONCURRENCY = 4`, packages/engine/src/stories/read.ts:69) before it knows whether any story is Ready. The backlog holds about 450 tasks, and each `backlog task view` loads the whole backlog: about 0.25 s wall and 0.36 s CPU per call against 0.08 s for `backlog --version`, so the read costs about 450 CLI processes whatever the PR changes. The views feed only R13, R14 and R19 (`activeTasks`, packages/engine/src/gate/rules.ts:82, :401-407, :473-480): each other task's id, dependencies and frozen branch.
2. `check-backlog-pr.ts` runs the same `checkReadyGate` over the whole head again (scripts/check-backlog-pr.ts:132-133), after viewing the changed tasks on both sides, so the job pays the full read twice (.github/workflows/ci.yml:97-104).
3. No bulk read in the CLI gives dependencies: `backlog task list --json` (1.53) has id, status, labels and references but no dependencies and no description, and `task view` takes one id.

The daemon does not pay this: it reads the other tasks from the mirror (DIPO-180, packages/engine/src/gate-decisions/cache.ts:1-3, `#otherTasks` in packages/engine/src/gate-decisions/feature.ts:184-200), and only `readGateInput`'s fallback (read.ts:121-147) views every task. The 2162 ms `story.gate` of 2026-11-12 is three CLI calls (the story's view, milestones, story folders) plus, when the base moved, the index pass that brings the mirror up to date; this story removes the fallback's per-task views and adds a DEBUG line with each part's duration so a slow gate read names its cause.

The fix, one read of the other tasks (0001):
- The gate's other active tasks (id, status, dependencies, frozen branch) come from one pass over the checkout's task files, never written. The pass reuses the Backlog file scan the runner already makes before each CLI call (`scanBacklogFiles`, packages/engine/src/backlog/runner.ts:1169) and its Backlog 1.53 front-matter preparation and parse (`preparedFrontMatter` and `parseYamlDocument`, runner.ts:940-1010, packages/engine/src/platform/yaml.ts:11), so the files are found and their front matter read exactly as the CLI prepares them; the field block is parsed with `parseFieldBlock` (packages/engine/src/story-store/fields/block.ts). No new YAML reader is written. The story being gated and the tasks a PR changes are still viewed through the CLI. This replaces the one-CLI-view-per-task read in `viewListedTasks` for the gate's other tasks, in CI and in `readGateInput`'s fallback; the daemon's mirror stays.
- `checkReadyGate` views only the Ready stories, and none when no story is Ready.
- `check-backlog-pr.ts` reuses one read for its gate step. No change to ci.yml (a Code Owner path), so the job keeps its two steps; each takes seconds.
- A task file the one-pass read cannot parse fails the check. This is a new, stricter rule: today a non-parsing other task becomes `undefined` (`viewListedTasks`, read.ts:52-73) and counts as active with no dependencies and no branch (`gateTasksOf`, read.ts:75-80); only a Ready story's own view that does not parse throws (scripts/check-ready-gate.ts:89-92). Failing closed means a broken task file can no longer hide a dependency or a branch from R13, R14 or R19.

ADR 0010 section 1, the line "**Only through the CLI.**" (line 12): the files dipo reads directly gain one: the task files of the StoryStore's folders, read in one pass for the Ready gate's other active tasks (their id, status, dependencies and frozen branch), never written. ADR 0012's input line (line 71, "the other active tasks in the office's backlog (read through the CLI)") says they come from that read. One Replaced line in 0010: the gate's other tasks read with one CLI view each (2026-11-13).

R30 applies: this changes how a CI guard and the Ready gate read their facts, and a misread could change a verdict. What the old read caught, each keeping a test: R13 (a dependency that is unknown, archived or a draft), R14 (a dependency cycle through the story), R19 (another active task with the same branch), a Ready story whose own view does not parse (the check throws), a list that disagrees with its count (DIPO-323), and the structural check's five rules (`backlog-only`, `parses`, `transition`, `ready-decision`, `no-claim`, packages/engine/src/backlog/pr/check.ts:31-37). Bypass forms to test: a branch in single quotes, double quotes, plain and with a YAML escape; dependencies as a block list, a flow list, a lower-case id and a single string; a task in the completed or archive folder and a draft (not active); a task file with a field block the parser refuses. The fail-closed test runs against the real path: on this repository's own backlog and on a fixture-built one, the one-pass read gives the same id, status, dependencies and branch as a Backlog CLI view of each task, and `checkReadyGate` gives the same verdicts as before.

Tier M: one read replaced in two callers, a lazy view of the Ready stories, an ADR line and a parity test.

```dipo
branch: "DIPO-494/backlog-checks-in-seconds"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(fail-closed, ci: the real Backlog CLI on this repository's backlog and on a fixture-built one) the one-pass read gives, for every active task, the id, status, dependencies and branch a CLI view gives"
    - kind: "automated"
      check: "(unit, fixture backlog) checkReadyGate still fails R13 for an unknown, archived and draft dependency, R14 for a cycle, R19 for a shared branch, and fails on a Ready story whose view does not parse and on a list that disagrees with its count; (new rule) an unparsable other task file now fails the check instead of counting with no dependencies"
    - kind: "automated"
      check: "(unit, fixture backlog) the bypass forms read the same as the CLI: a branch single-quoted, double-quoted, plain and escaped; dependencies as block list, flow list, lower-case and single string; tasks in completed and archive folders and drafts are not active"
    - kind: "automated"
      check: "(unit, counting CLI) checkReadyGate on a backlog with no Ready story runs no task view; with two Ready stories it views exactly those two"
    - kind: "automated"
      check: "(unit, counting CLI) checkBacklogPrIn views only the changed tasks and the Ready stories, reads the other tasks once, and still refuses each of its five rules' cases"
    - kind: "automated"
      check: "(unit) readGateInput without a mirror runs at most three CLI calls and logs the duration of each part at DEBUG"
    - kind: "manual"
      check: "Open a backlog-only PR that files one Refined story and watch the ready-gate job"
      expect: "Both steps of the ready-gate job finish in well under a minute together"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Ready gate's other active tasks (id, status, dependencies, frozen branch) come from one pass over the checkout's task files that reuses scanBacklogFiles and the runner's Backlog 1.53 front-matter preparation and parse, in CI and in readGateInput's fallback; the one-CLI-view-per-task read for them is removed
- [ ] #2 checkReadyGate views only the Ready stories through the CLI, and none when no story is Ready
- [ ] #3 check-backlog-pr views only the changed tasks and the Ready stories and reads the other tasks once
- [ ] #4 On this repository's backlog and on a fixture-built one the one-pass read gives every active task the id, status, dependencies and branch a CLI view gives
- [ ] #5 The gate still fails R13, R14 and R19, the check still fails on a Ready story whose view does not parse or a list that disagrees with its count, and the structural check still refuses each of its five rules' cases, each with a test
- [ ] #6 An other task file the one-pass read cannot parse now fails the check instead of counting as active with no dependencies (a new, stricter rule), with a test
- [ ] #7 The bypass forms (branch quoting and escapes, dependency list forms, completed, archive and draft tasks) read the same as the CLI
- [ ] #8 readGateInput logs the duration of each part at DEBUG
- [ ] #9 ADR 0010's Only through the CLI line names the one-pass read of task files for the gate's other tasks, with one Replaced line, and ADR 0012's input line says so
<!-- AC:END -->
