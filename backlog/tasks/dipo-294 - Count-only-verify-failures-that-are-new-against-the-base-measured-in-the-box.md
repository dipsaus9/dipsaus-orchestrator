---
id: DIPO-294
title: Install the office's packages in the box before the worker starts
status: Done
assignee: []
created_date: '2026-10-22 08:30'
updated_date: '2026-10-22 11:31'
labels:
  - 'tier:M'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/workers.ts
  - packages/engine/src/box/verify.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/test/box/workers.test.ts
  - packages/engine/test/run/start.test.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/run/compose.ts
  - packages/daemon/src/runs.ts
  - packages/engine/test/box/fake-boxes.ts
priority: high
type: feature
ordinal: 283000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: before the worker starts, its box holds the office's packages installed at the story's start commit, so the worker can run the office's verify and tests at once, without installing first.

Context: in the first box run (DIPO-275 on DIPO-248) the box started without node_modules and the worker ran bun install itself. Maintainer decision of 2026-10-22 (0021 amendment of that date): dipo prepares the box with the office's packages installed; the worker runs verify itself before done; dipo no longer runs verify in the box; CI on the story PR is the verify, started together with the review; an office without CI relies on the worker's own verify and the review. The story first held an in-box base verify that counted only new failures; the maintainer dropped that part. A stopped first build on branch DIPO-294/box-verify-new-failures (commit 1ad7ae11) holds an install step (BoxWorkers.install, runBoxInstall, the web route before the session) that may be reused; its base verify, verdict, migration and PR-body parts are not wanted.

```dipo
branch: "DIPO-294/box-install-at-start"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After the box is created and before the worker's session starts, dipo runs the run profile's install command in the box at the start commit, through the box's web route and Safe-Chain, with the install deadline of the office config
- [x] #2 A failed or timed-out install stops the launch with a reason the maintainer sees, and the box is deleted
- [x] #3 Tests with the fake box backend cover: install before the session with the web route's environment; a failed install; a timed-out install the box cannot end; and the tree check
- [x] #4 After the install, /work holds no file that git does not ignore beyond the start commit's files, checked on dipo's own copy and never by running git on the box's files (section 14), or the launch stops, as the Mac worktree setup does
<!-- AC:END -->
