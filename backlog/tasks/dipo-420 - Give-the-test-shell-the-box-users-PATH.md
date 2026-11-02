---
id: DIPO-420
title: Give the test shell the box user's PATH
status: In Progress
assignee: []
created_date: '2026-11-02 09:14'
updated_date: '2026-11-02 09:34'
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
unknowns:
  - q: "The test shell's command was `/bin/bash -l`. The login shell reads /etc/profile, which resets PATH and drops the box user's PATH that execArgs passes. I removed `-l`, so TEST_SHELL_COMMAND is now `[\"/bin/bash\"]` (packages/engine/src/box/apple-args.ts), and the shell keeps the one PATH every box command gets. I added the args test (criterion 1) and updated the old `-l` assertion in packages/daemon/src/test-shell.test.ts. I added the real-box check for criterion 2 to test-box.box.test.ts, which I could not run on this Linux box. Blocked because criterion 2 is unverified: it needs a macOS box with Apple container and DIPO_TEST_BOX=1. No question is needed; the maintainer runs `DIPO_TEST_BOX=1 bun test packages/engine/test/box/test-box.box.test.ts` on the Mac. Full `bun run verify` passed (all 14 shards). One DIPO-386 test failed once under load and passed on rerun, unrelated to this change."
    status: "resolved"
    answer: "Criterion 2's box test cannot run in your box; that is expected. Keep the box test you wrote in test-box.box.test.ts, make sure verify passes, and report done; the maintainer's session runs DIPO_TEST_BOX=1 on the Mac against your pushed branch before merge. The change to packages/daemon/src/test-shell.test.ts is fine: it is the old -l assertion."
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-02 09:32 UTC: ambiguous-spec
- Detail: The test shell's command was `/bin/bash -l`. The login shell reads /etc/profile, which resets PATH and drops the box user's PATH that execArgs passes. I removed `-l`, so TEST_SHELL_COMMAND is now `["…
- Run: run_01M6DSE1E0T4DN0ZQW4EBR6RNW
- Criteria met: 1 of 2 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 58,469 of 300,000 tokens; 24 of 90 turns; 3 of 45 minutes
- Last good commit: b4e09592a7ce66125262802d4837bc91fde6d5ac

Resumed 2026-11-02 09:34 UTC; grants: none; note: Criterion 2's box test cannot run in your box; that is expected. Keep the box test you wrote in test-box.box.test.ts, make sure verify passes, and report done; the maintainer's session runs DIPO_TEST…
<!-- SECTION:NOTES:END -->
