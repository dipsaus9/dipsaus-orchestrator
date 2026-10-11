---
id: DIPO-57
title: Re-attach worker hosts after a daemon restart
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-45
  - DIPO-56
references:
  - packages/engine/src/host/reattach.ts
  - packages/engine/src/host/
  - packages/engine/test/host/
documentation:
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0009-tui.md
priority: medium
type: feature
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after a daemon restart the engine re-attaches every active run's worker host by PID and start time, catches up from the processed offset, follows a host whose socket is gone in follow-only mode, processes an exit that happened while it was down, and parks `interrupted` a run whose host died without an exit file and cannot be resumed.

References: 0006 decision 7 (recovering), decision 8 (re-attach cases, never a new host while the old PID is alive, caps checked after catch-up); 0008 section 8 (resume on `interrupted`); 0009 section 3 (`host-lost`, `follow-only`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

Built after cutover: dipo delivers this story itself (M0 breakdown decision D6, DIPO-15).

```dipo
branch: "DIPO-57/re-attach-worker-hosts-after-daemon"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) each of the four cases with a fake host."
    - kind: "automated"
      check: "(integration, CI only) restart the daemon during a replayed run; output continues without gaps or duplicates."
    - kind: "manual"
      check: "during a scratch run, `dipo daemon restart`"
      expect: "the TUI reconnects and the worker output continues."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Host alive with a matching handshake: catch up from `processed_offset`, then follow live with steering.
- [ ] #2 Host alive without a socket: tail the event file, wait for `exit.json`, emit `work.observed follow-only`; steering commands fail with a message.
- [ ] #3 Host dead with `exit.json`: process remaining events and the exit.
- [ ] #4 Host dead without `exit.json`: emit `work.observed host-lost`, then resume once if budget remains and `canResume` holds, else park `interrupted`.
- [ ] #5 No new host starts for a run whose old host PID is alive.
- [ ] #6 After catch-up the run's caps are checked and the worker stopped when over.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S41 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
