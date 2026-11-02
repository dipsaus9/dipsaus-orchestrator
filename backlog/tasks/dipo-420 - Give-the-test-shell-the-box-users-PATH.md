---
id: DIPO-420
title: Give the test shell the box user's PATH
status: Ready
assignee: []
created_date: '2026-11-02 09:14'
updated_date: '2026-11-02 09:23'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/apple-args.ts
  - packages/engine/test/box/args.test.ts
  - packages/engine/test/box/test-box.box.test.ts
priority: medium
type: bug
ordinal: 398000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: in `dipo test shell <ID>` the maintainer types `bun` (and every tool the worker had) as in the story's manual steps, without a full path.

Found in the TUI hand test of 2026-11-02 on the scratch office (binary ca71ee54, story TASK-19 flagged test-before-merge, a product with nothing to start). The manual step `bun -e '…'` failed in the test shell with "bash: bun: command not found"; `~/.local/bin/bun` worked and printed the expected result. The shell's PATH was /usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games. `TEST_SHELL_COMMAND` in packages/engine/src/box/apple-args.ts is `/bin/bash -l`: a login shell reads /etc/profile, which sets PATH again and drops the box user's PATH that `execArgs` passes (`BOX_USER_ENV`, DIPO-334).

One PATH for every command in a box (0001): the shell keeps the one `execArgs` passes. 0008.

```dipo
branch: "DIPO-420/test-shell-path"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the test shell's command keeps the box user's PATH, so bun resolves in the shell"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The test shell starts with the same PATH as every other command dipo runs in a box as the box user, so `bun` and the other tools the worker used resolve, shown by an args test
- [ ] #2 In a real test box, `command -v bun` in the test shell prints the box user's bun, shown by a box test (DIPO_TEST_BOX=1)
<!-- AC:END -->
