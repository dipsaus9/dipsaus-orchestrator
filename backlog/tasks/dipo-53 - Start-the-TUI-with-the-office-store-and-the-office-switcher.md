---
id: DIPO-53
title: Start the TUI with the office store and the office switcher
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 13:07'
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
  - .oxlintrc.json
  - test/lint-boundaries/
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
- [x] #1 Implementation notes record the four prototype checks on Bun 1.4.2 with `ink@8.0.0` and `react@19.3.x`, including the compiled binary in a PTY on darwin-arm64 (the maintainer's machine) and linux-x64 (a CI job on `ubuntu-24.04` on the scratch branch).
- [x] #2 `OfficeStore` in the runtime-free main entry of `packages/client` (no Bun or Node API, enforced by the DIPO-25 lint rule) applies a snapshot then events by subject, drops duplicates by cursor, replaces views without computing status, and on `stream.resetRequired` reloads and shows `view reloaded (history gap)` once.
- [x] #3 `dipo tui` with stdin not a TTY exits non-zero with a one-line message.
- [x] #4 The header shows office, daemon state and connection; disconnected shows `OFFLINE since <time> – view frozen` and disables action keys; `recovering`, `draining` and `safe` show the 0009 banners.
- [x] #5 `o` opens the switcher built from `engine.hello` and `office.summary`; Enter selects; `n` opens a new repository path through `office.open`.
- [x] #6 `q` twice within 2 s quits and restores the terminal; Ctrl+C and SIGTERM restore it too.
- [x] #7 Below 60 columns or 16 rows a single list with "widen for detail" is shown; `NO_COLOR`, `--no-color`, `--ascii` and `--inline` are honoured.
- [x] #8 `packages/tui` imports only `contract` and `client`, and render tests use `render`, `press` and `frame` helpers with ANSI stripped.
- [x] #9 Enter in the office switcher sends the read `office.switch` (DIPO-52); the store replaces its state with the returned snapshot, unsubscribes from the previous office stream and subscribes to `office:<id>` after the returned cursor (0005 section 8); a render test shows it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S37 (DIPO-15). Before cutover: built by hand-run agents.

## 0009 section 1 prototype (2026-10-14)

Scratch branch `DIPO-53/prototype-scratch` (never merged): `packages/tui/prototype/` holds an overview app (40 stories, 8 agents, usage at 1 Hz, output tail at 4 Hz), `pty-check.ts` (compiles it with `bun build --compile --splitting --external react-devtools-core`, as `scripts/build.ts` does, and drives the binary in a PTY through `Bun.Terminal`) and `harness.test.tsx`. Bun 1.4.2, `ink@8.0.0`, `react@19.3.0`, `ink-testing-library@4.0.0`. Linux results come from the job `tui-prototype` on `ubuntu-24.04` on that branch: https://github.com/dipsaus9/dipsaus-orchestrator/actions/runs/38567014251 (15/15 checks). darwin-arm64 ran on the maintainer's machine (15/15).

1. Bun runtime. Idle CPU (no updates, 10 s): darwin-arm64 0.65 to 0.78% of one core, linux-x64 1.24 to 1.60%; pass (< 5%). Under the 1 Hz + 4 Hz load: darwin 4.4 to 4.5% at 120x40 and 3.3 to 3.6% at 80x24; linux runner 10.6% at 120x40 and 8.1 to 8.5% at 80x24. `incrementalRendering` on and off measure the same within noise; the TUI uses it on (fewer bytes written). Visible flicker in iTerm2, Terminal.app, a Linux VTE terminal and tmux needs a person to look: not checked by the agent, left to the maintainer's manual test.
2. Compiled binary in a PTY, both platforms: yoga's top-level await loads; raw-mode keys reach `useInput`; resize reflows (Bun.Terminal.resize does not deliver SIGWINCH to the child on either platform, so the check sends SIGWINCH as a terminal does); the alternate screen is entered and left; the terminal is restored (ICANON and ECHO back, alternate screen left) on `q`, Ctrl+C, SIGTERM and an uncaught error; an unmount followed by a new mount still gets keys (the Bun `isTTY` issue does not occur on 1.4.2, no stdin proxy needed). Two findings now in the TUI: Ink treats `CI=true` as non-interactive (no alternate screen, only the final frame), so `dipo tui` passes `interactive: true` after its own TTY check; and the first frame can come before Ink's raw-mode effect, so PTY tests wait for raw mode before typing.
3. Tests: `ink-testing-library@4.0.0` works with Ink 8 under `bun test` (render, arrow keys, Enter, `lastFrame`). The TUI still uses its own ~100-line harness (`packages/tui/src/testing/harness.ts`: Ink 8 `render` over PassThrough streams, fixed size, TTY-like stdin, `render`/`press`/`frame`, ANSI stripped), because the library is built against Ink 5, has no terminal size or TTY stdin, and would be one more dependency.
4. No TTY: piped stdin exits 1 with one line and no Ink stack trace.

Fallback trigger not hit: Ink 8 stays.

## Implementation

- `OfficeStore` in `packages/client/src/store/` (runtime-free main entry, lint-enforced): `start()` takes offices and daemon state from `engine.hello` and follows `software` after its cursor; `open()` reads `office.snapshot`; `switchTo()` reads `office.switch`, replaces the state, unsubscribes the old office stream and subscribes `office:<id>` after the returned cursor. Events apply by subject (story key, run, gate, question, test, office); stored events at or before the last cursor are dropped (derived ones apply); views are replaced, a work event without `view` changes nothing. `stream.resetRequired` re-reads `engine.hello` and the snapshot and sets `view reloaded (history gap)` once (cleared by the next key). `engine.recovering` reads are retried on `daemon.state` to `running`. Reads never reject (a closed client becomes an error outcome).
- `packages/tui`: `runTui` (TTY check, `starting…`, connect with autostart, office of the current directory else the first one else the switcher), `App` (header with office, daemon state and connection; offline, recovering, draining and safe banners; switcher with `o`, `j`/`k`/arrows, Enter, `n` through `office.open`, Esc; `S` with a y/N prompt in safe mode; `q` twice within 2 s, Ctrl+C, SIGTERM), narrow list below 60 columns or 16 rows, `--no-color`/`NO_COLOR`, `--ascii`, `--inline`, `--office`.
- `dipo tui` in the CLI (`packages/cli/src/tui-command.ts`), help text.
- Lint: a `packages/tui/**` override forbids `cli` and `testkit` besides `engine` and `daemon`; boundary fixtures prove it and that `contract`, `client` and `client/node` stay allowed.
- Tests: store unit tests (10), TUI render tests over a golden event log (`packages/tui/src/testing/fixtures/three-offices.json`, every event parsed with its contract schema), `runTui` tests, CLI tests; `pty.ci.test.ts` (CI only) runs `runTui` on a real PTY. Local suite: about +1 s.

Not in this story (follow-ups if wanted): the last-used office (0009 section 7 falls back to the first registered office here), switcher `/` filter and `F` forget, keys from `commands.describe`, store batching at 10 Hz, the "Since you left" digest.
<!-- SECTION:NOTES:END -->
