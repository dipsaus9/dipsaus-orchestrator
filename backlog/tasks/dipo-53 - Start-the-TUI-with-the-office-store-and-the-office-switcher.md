---
id: DIPO-53
title: Start the TUI with the office store and the office switcher
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 12:17'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-25
  - DIPO-27
  - DIPO-32
  - DIPO-52
  - DIPO-70
references:
  - packages/tui/
  - packages/client/src/store/
  - packages/cli/src/
  - package.json
  - bun.lock
  - packages/client/src/index.ts
  - packages/client/test/
documentation:
  - docs/decisions/0009-tui.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: feature
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo tui` opens an Ink 8 full-screen client that autostarts the daemon, keeps an `OfficeStore` fed by snapshot and events, shows connection and daemon banners, and lets the maintainer switch offices with `o`, after the 0009 prototype has confirmed Ink inside the compiled binary.

Context: first TUI story. Its first step is the throwaway prototype on a scratch branch, never merged; results go in the implementation notes, with the Linux results from a CI job on `ubuntu-24.04` (M0 review, DIPO-15). The `OfficeStore` belongs to the runtime-free client core so a future web client can reuse it (0004 amendment of 2026-10-12). Autostart comes from DIPO-70 and office summaries from DIPO-32. Ink and react are already bundled by DIPO-17's self-check. References: 0009 sections 1 (prototype checks 1 to 4, fallback trigger), 2 (thin client, store rules), 4 (office switcher), 6 (global keys), 7 (connection and daemon states), 9 (narrow terminals, `NO_COLOR`, `--ascii`, alternate screen, `--inline`); 0017 section 1 (TUI layer).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-53/start-tui-office-store-office-switcher"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(TUI) switcher renders three offices from a golden event log; arrow and Enter select one."
    - kind: "automated"
      check: "(TUI) disconnect frame shows the offline banner and disabled keys."
    - kind: "automated"
      check: "(unit) store drops duplicate cursors and handles reset."
    - kind: "manual"
      check: "`dipo tui` in this repository"
      expect: "the office opens; press `o` -> the switcher lists registered offices; press `q` twice -> the shell prompt returns intact."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Implementation notes record the four prototype checks on Bun 1.4.2 with `ink@8.0.0` and `react@19.3.x`, including the compiled binary in a PTY on darwin-arm64 (the maintainer's machine) and linux-x64 (a CI job on `ubuntu-24.04` on the scratch branch).
- [ ] #2 `OfficeStore` in the runtime-free main entry of `packages/client` (no Bun or Node API, enforced by the DIPO-25 lint rule) applies a snapshot then events by subject, drops duplicates by cursor, replaces views without computing status, and on `stream.resetRequired` reloads and shows `view reloaded (history gap)` once.
- [ ] #3 `dipo tui` with stdin not a TTY exits non-zero with a one-line message.
- [ ] #4 The header shows office, daemon state and connection; disconnected shows `OFFLINE since <time> – view frozen` and disables action keys; `recovering`, `draining` and `safe` show the 0009 banners.
- [ ] #5 `o` opens the switcher built from `engine.hello` and `office.summary`; Enter selects; `n` opens a new repository path through `office.open`.
- [ ] #6 `q` twice within 2 s quits and restores the terminal; Ctrl+C and SIGTERM restore it too.
- [ ] #7 Below 60 columns or 16 rows a single list with "widen for detail" is shown; `NO_COLOR`, `--no-color`, `--ascii` and `--inline` are honoured.
- [ ] #8 `packages/tui` imports only `contract` and `client`, and render tests use `render`, `press` and `frame` helpers with ANSI stripped.
- [ ] #9 Enter in the office switcher sends the read `office.switch` (DIPO-52); the store replaces its state with the returned snapshot, unsubscribes from the previous office stream and subscribes to `office:<id>` after the returned cursor (0005 section 8); a render test shows it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S37 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
