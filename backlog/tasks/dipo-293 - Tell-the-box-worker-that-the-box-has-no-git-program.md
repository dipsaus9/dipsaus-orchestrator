---
id: DIPO-293
title: Tell the box worker that the box has no git program
status: To Do
assignee: []
created_date: '2026-10-22 08:30'
updated_date: '2026-10-22 08:32'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/prompts/contract/implement-box.md
  - packages/engine/test/prompts/system.test.ts
priority: high
type: bug
ordinal: 282000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker in a box knows from its prompt that the box has no git program and that none can be installed, so it does not try to install one and names the git-based test failures in its report instead.

Context: in the first box run (DIPO-275 on DIPO-248, run run_01M5H7RZ4HT6ZE49074MCH9EWF, 2026-10-22) the worker saw 305 tests fail with "Executable not found in $PATH: git" and tried apt-get install git. The box prompt (implement-box.md) says the box holds no git repository and that the worker does not need one, which the worker read as "no repository", not "no git program". The maintainer chose on 2026-10-22 to keep git out of the box (0021 decision 4) and to try this prompt line together with counting only new verify failures (the companion story) before considering git in the image.

```dipo
branch: "DIPO-293/box-prompt-no-git"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 implement-box.md says the box has no git program and that one cannot be installed, and that tests or commands that need git fail in the box for that reason, not because of the worker's change
- [ ] #2 It tells the worker not to install missing system tools, to name such failures in its report, and to put a tool the box lacks in proposals
- [ ] #3 A prompt test pins the new text
<!-- AC:END -->
