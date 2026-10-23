---
id: DIPO-313
title: >-
  Clean terminal control characters from all worker and repository text the CLI
  and TUI print
status: In Progress
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-23 07:58'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/door.ts
  - packages/contract/src/
  - packages/cli/src/watch-command.ts
  - packages/cli/src/run-command.ts
  - packages/tui/src/output.ts
  - packages/tui/src/detail.tsx
  - packages/client/src/node/logs/reader.ts
  - packages/engine/src/ingest/output.ts
  - packages/cli/src/
  - packages/tui/src/
  - packages/engine/test/box/
  - packages/engine/test/ingest/
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
- [ ] #1 One pure function removes terminal control characters, with the rules of `cleanDoorText`. It lives in a package that the engine and every client may import. The door uses it in place of its own copy, and its tests move with it.
- [ ] #2 `dipo watch` and `dipo run`, including `--dry-run`, pass every interpolated string through it before printing. That covers text from a worker, a repository, a story or a notice.
- [ ] #3 The TUI's `cleanLine` and the prompt pane use it. Tab and line-break handling stays as today. The 7-bit and one-byte control sequences, string sequences and hyperlinks are removed.
- [ ] #4 `dipo daemon logs` prints log text through it.
- [ ] #5 Worker output lines are stored cleaned at ingest (`packages/engine/src/ingest/output.ts`), so a client of an older build also gets plain text.
- [ ] #6 Tests feed each sequence class through watch, run, the TUI output, the prompt pane and the log reader, and show that none reaches the output. The classes are CSI in both forms, OSC, DCS, cursor movement and erase.
<!-- AC:END -->
