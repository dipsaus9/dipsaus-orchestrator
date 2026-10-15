---
id: DIPO-94
title: Stop the TUI pty test from leaking spinning processes
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/tui/src/pty.ci.test.ts
  - packages/tui/src/testing/pty-main.ts
priority: medium
type: feature
ordinal: 84000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a timed-out or aborted TUI pty test leaves no process behind; the test kills its child and the harness exits by itself when its terminal goes away.

Context: seen in the M0 delivery sessions: pty-main.ts processes kept spinning at about 167% CPU for hours after a pty test timed out or its worktree was removed. pty.ci.test.ts spawns packages/tui/src/testing/pty-main.ts in a Bun.Terminal and only closes the terminal in finally (packages/tui/src/pty.ci.test.ts:15-45); the child is never killed on a timeout or thrown error. pty-main.ts runs runTui on the real terminal with no exit on hang-up or stdin EOF (packages/tui/src/testing/pty-main.ts:9-25).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 inPty kills the child (SIGKILL after a short SIGTERM grace) in its finally, also when the frame wait throws.
- [ ] #2 pty-main.ts exits within a second when its terminal closes (SIGHUP, stdin EOF or EIO) or when its parent process is gone.
- [ ] #3 A test closes the terminal under a running pty-main and checks the process is gone within 2 s.
<!-- AC:END -->
