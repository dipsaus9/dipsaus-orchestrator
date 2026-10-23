---
id: DIPO-313
title: >-
  Clean terminal control characters from all worker and repository text the CLI
  and TUI print
status: Done
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-23 08:09'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - '- packages/engine/src/box/door.ts'
  - packages/cli/src/
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/run-command.test.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/watch-command.test.ts
  - packages/cli/src/watch-command.ts
  - packages/client/src/node/logs/reader.ts
  - packages/client/test/unit/logs.test.ts
  - packages/contract/src/
  - packages/contract/src/clean-text.test.ts
  - packages/contract/src/clean-text.ts
  - packages/contract/src/index.ts
  - packages/engine/src/box/door.ts
  - packages/engine/src/ingest/output.ts
  - packages/engine/test/box/
  - packages/engine/test/box/door.test.ts
  - packages/engine/test/ingest/
  - packages/engine/test/ingest/command-bodies.test.ts
  - packages/tui/src/
  - packages/tui/src/detail.test.tsx
  - packages/tui/src/detail.tsx
  - packages/tui/src/output.test.ts
  - packages/tui/src/output.ts
type: bug
ordinal: 298000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no text that comes from a worker, a repository, a story or a log reaches the maintainer's terminal with terminal control characters. `dipo watch`, `dipo run` (its dry run too), `dipo daemon logs` and the TUI show it as plain text, cleaned by one shared function. Worker text cannot redraw, hide or fake what the maintainer reads.

Context:
- 0021 section 7: every message from the worker reaches the maintainer cleaned of terminal control characters.
- The door's `cleanDoorText` (`packages/engine/src/box/door.ts`) cleans part messages and the worker's report. The TUI cleaner and the CLI print paths do not share the rules of `cleanDoorText` yet.
- The print paths this story covers:
  - `dipo watch` (`packages/cli/src/watch-command.ts`);
  - `dipo run` (`packages/cli/src/run-command.ts`), including the dry run's prompt preview;
  - the TUI's `cleanLine` (`packages/tui/src/output.ts`) and the prompt pane (`packages/tui/src/detail.tsx`);
  - the client log reader (`packages/client/src/node/logs/reader.ts`).
- UIs may not import the engine (0004).

```dipo
branch: "DIPO-313/clean-terminal-control-text"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the shared cleaner removes CSI in both forms, OSC, DCS, cursor movement and erase sequences, C0 and C1 controls and bidi overrides, and keeps tab and line breaks where the caller asks"
    - kind: "automated"
      check: "(unit) the door's part messages and worker report use the shared cleaner, with the door's former tests moved to it"
    - kind: "automated"
      check: "(unit) dipo watch and dipo run, including --dry-run, print a worker line, a story title and a notice that carry each sequence class as plain text"
    - kind: "automated"
      check: "(unit) the TUI output line and the prompt pane show each sequence class as plain text"
    - kind: "automated"
      check: "(unit) dipo daemon logs prints a log line that carries each sequence class as plain text"
    - kind: "automated"
      check: "(unit) worker output lines are stored cleaned at ingest"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One pure function removes terminal control characters, with the rules of `cleanDoorText`. It lives in a package that the engine and every client may import. The door uses it in place of its own copy, and its tests move with it.
- [x] #2 `dipo watch` and `dipo run`, including `--dry-run`, pass every interpolated string through it before printing. That covers text from a worker, a repository, a story or a notice.
- [x] #3 The TUI's `cleanLine` and the prompt pane use it. Tab and line-break handling stays as today. The 7-bit and one-byte control sequences, string sequences and hyperlinks are removed.
- [x] #4 `dipo daemon logs` prints log text through it.
- [x] #5 Worker output lines are stored cleaned at ingest (`packages/engine/src/ingest/output.ts`), so a client of an older build also gets plain text.
- [x] #6 Tests feed each sequence class through watch, run, the TUI output, the prompt pane and the log reader, and show that none reaches the output. The classes are CSI in both forms, OSC, DCS, cursor movement and erase.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-23: Done by dipo's box run run_01M5KW01EA786WVK0G5GBXS85C (PR #364), approved by dipo's reviewer in round 1. The worker's own note: line breaks inside a printed string still stay in dipo watch and dipo run output (not asked by this story). The dipo run CLI timed out after 300 s while the claim took 5.5 minutes (the old Mac setup install; DIPO-240 removes it).
<!-- SECTION:NOTES:END -->
