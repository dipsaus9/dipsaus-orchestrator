---
id: DIPO-333
title: >-
  Read the Backlog CLI's output from a file, never a pipe, and say how much
  arrived when a list is short
status: Done
assignee: []
created_date: '2026-10-23 13:02'
updated_date: '2026-10-23 13:34'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - '- packages/contract/src/runtime.ts'
  - packages/contract/src/index.ts
  - packages/contract/src/runtime.ts
  - packages/engine/src/backlog/list.ts
  - packages/engine/src/backlog/runner.ts
  - packages/engine/src/platform/output-files.ts
  - packages/engine/src/platform/process.ts
  - packages/engine/src/run/temp-dirs.ts
  - packages/engine/test/backlog/list.test.ts
  - packages/engine/test/backlog/runner-output-file.test.ts
  - packages/engine/test/backlog/runner.test.ts
  - packages/engine/test/platform/spawn-output-file.test.ts
  - packages/engine/test/run/temp-dirs.test.ts
  - scripts/check-ready-gate.test.ts
  - scripts/check-ready-gate.ts
priority: high
type: bug
ordinal: 316000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every Backlog CLI call dipo makes reads the CLI's output from a regular file after the CLI exits, so no pipe sits between the CLI and dipo, and a list that is still short says how much of it arrived.

Context: on 2026-10-23 the CI Ready gate (scripts/check-ready-gate.ts) failed with DIPO-323's guard: `task list --plain` printed 271 entries while its --count said 294, on both attempts; locally the same tree lists 294. The 271 printed are exactly the first 271 lines of the local output and the 23 missing are exactly its last 23 lines (the end of the Done group), so the end of the output was lost on Linux CI while the CLI exited 0. The earlier R13 failures (DIPO-284, DIPO-285 missing) were also at the end of the list. Cross-branch reads are not the cause: in Backlog.md 1.53 `task list`, `--count` and `task view` read only the working copy (`includeCrossBranch: false`, checked in the CLI and in a scratch repository with a newer task version on another branch), as 0010 fact 7 says. 0010 section 1, DIPO-323.

```dipo
branch: "DIPO-333/base-only-backlog-reads"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) packages/engine/test/platform/spawn-output-file.test.ts: a real child writing over 300 KB, and one writing slowly, reach dipo whole through regular files (mode 0600) in a private folder that is removed after reading, also when the child fails or cannot start"
    - kind: "automated"
      check: "(unit) packages/engine/test/backlog/runner-output-file.test.ts: runBacklog with a real CLI stand-in that writes a long list slowly gets every entry, and the stand-in sees a regular file as its stdout, not a pipe"
    - kind: "automated"
      check: "(unit) packages/engine/test/backlog/list.test.ts: the incomplete-list error names the bytes received, the last line received and whether the output ended with a newline"
    - kind: "automated"
      check: "(unit) scripts/check-ready-gate.test.ts: the CI script's Backlog CLI uses the same spawn as the daemon"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every Backlog CLI call dipo makes (runBacklog) has the CLI write its stdout and stderr to regular files (mode 0600) in a private temp folder; dipo reads them after the process exits, so no pipe sits between the CLI and dipo, and the folder is removed after reading, also on a failure
- [x] #2 The incomplete-list error names the bytes received, the last line received and whether the output ended with a newline
- [x] #3 The change is tested on real processes, with large output (over 300 KB) and with a CLI stand-in that writes slowly
- [x] #4 scripts/check-ready-gate.ts goes through the same path
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-23 findings: (1) Cross-branch reads are not the cause on 1.53.0. In the CLI, task list runs queryTasks with includeCrossBranch false, which only reads backlog/tasks; --count takes the same path and prints the length of the same array; task view, archive and the readiness helpers also default to includeCrossBranch false. A scratch repository with this repository's 294 tasks, a local bare origin and a pushed branch holding newer versions (DIPO-5 In Progress, DIPO-10 archived, DIPO-321 In Progress), with check_active_branches and remote_operations on, listed 294 and counted 294 on main every time, also in a shallow detached clone like the CI checkout. check_active_branches matters on 1.53 only for id allocation. (2) The end of the output is lost on Linux CI while the CLI exits 0: the 271 entries CI printed are exactly the first 271 lines of the local output of the same tree (29902 bytes, cut after DIPO-106 at about byte 27444) and the 23 missing (DIPO-107 to DIPO-321) are exactly its last 23 lines. (3) Not reproduced on macOS (concurrent reads, a blocked parent event loop, a 333 KB list with a delayed reader), so the pipe is taken out of the path rather than a fix aimed at one side of it.

Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all 4 criteria met; its advisories are fixed: output read through kept descriptors with a regular-file check and a size cap, a foreign temp root refused, left-over folders swept at daemon start, a failed read reported as a Backlog CLI error). The first guess, cross-branch reads, was disproved by the builder on the 1.53 CLI.
<!-- SECTION:NOTES:END -->
